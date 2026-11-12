/**
 * /api/perp/*: USDT-M perpetual futures trading (long/short, leverage, isolated margin) in two isolated environments.
 *   perp_paper    ETI internal simulation on live Binance futures prices (session scope: paper)
 *   perp_testnet  Binance futures testnet, recorded only from exchange responses (session scope: testnet)
 *   GET  /api/perp/config
 *   GET  /api/perp/state?environment=
 *   POST /api/perp/preview {environment, symbol, side, type, quantity, limitPrice?, stopPrice?, leverage?, reduceOnly?}
 *   POST /api/perp/order   same body plus clientOrderId?. buy = long/close short, sell = short/close long.
 *   POST /api/perp/close   {environment, symbol}        reduce-only market order for the whole position
 *   POST /api/perp/cancel  {environment, orderId}
 *   POST /api/perp/sync    {environment}
 * Live futures trading does not exist: there is no live environment, and nothing here can reach a live account.
 */
import { authenticate, can, rateLimit, type EnvScope } from "../auth/session.ts";
import { SYMBOL_RE, cancelPaper, estimate, futuresPrice, matchPaper, perpConfig, perpLedger, perpStore, placePaper, type PerpDeps, type PerpEnv, type PerpOrderInput } from "./engine.ts";
import { cancelTestnet, placeTestnet, reconcileTestnet, signed, syncTestnet, testnetConfigured } from "./testnet.ts";
import { present, type Ledger, type PerpEnvironment } from "./ledger.ts";
import { storageConfigured, type KVL } from "../portfolio/store.ts";

export type PerpRouteEnv = PerpEnv & { ETI_EXECUTION_TOKEN?: string; ETI_SESSION_SECRET?: string; ETI_SESSION_SECRET_PREVIOUS?: string; ETI_AUTO_SESSIONS?: string; ETI_PORTFOLIO_DB?: any };
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
export const PERP_ENVS: PerpEnvironment[] = ["perp_paper", "perp_testnet"];
const scopeOf = (e: PerpEnvironment): EnvScope => e === "perp_paper" ? "paper" : "testnet";
export const PERP_LABEL: Record<PerpEnvironment, string> = { perp_paper: "Internal Paper Futures (simulated)", perp_testnet: "Binance Futures Testnet" };
const downsample = <T,>(a: T[], max: number): T[] => { if (a.length <= max) return a; const s = a.length / max, o: T[] = []; for (let i = 0; i < max; i++) o.push(a[Math.floor(i * s)]); o.push(a[a.length - 1]); return o; };

/** Exchange wallet for testnet (the ledger of a testnet stream never invents a balance). */
async function exchangeBalance(env: PerpRouteEnv, deps: PerpDeps, now: number) {
  const r = await signed(env, deps, "GET", "/fapi/v2/balance", {}, now); if (!r.ok || !Array.isArray(r.data)) return { ok: false as const, error: r.msg ?? "unavailable" };
  const row = r.data.find((x: any) => x.asset === "USDT"); if (!row) return { ok: false as const, error: "no USDT balance reported" };
  return { ok: true as const, wallet: Number(row.balance), available: Number(row.availableBalance) };
}
async function ledgerFor(env: PerpRouteEnv, deps: PerpDeps, environment: PerpEnvironment, now: number) {
  const st = perpStore(env, environment);
  if (environment === "perp_paper") { const { ensurePaperInit } = await import("./engine.ts"); await ensurePaperInit(env, now); }
  const { ledger } = await perpLedger(st, environment);
  let bal: Awaited<ReturnType<typeof exchangeBalance>> | null = null;
  if (environment === "perp_testnet" && testnetConfigured(env)) { bal = await exchangeBalance(env, deps, now); if (bal.ok) { ledger.cash = bal.wallet; ledger.startingBalance = ledger.startingBalance || null; } }
  return { st, ledger, bal };
}

export async function buildPerpState(env: PerpRouteEnv, deps: PerpDeps, environment: PerpEnvironment, now: number) {
  if (!storageConfigured(env)) return { environment, label: PERP_LABEL[environment], unavailable: true, message: "No portfolio storage is bound. Bind the ETI_PORTFOLIO_DB D1 database (preferred) or the ETI_EXECUTION_LOG KV namespace.", serverTime: now };
  if (environment === "perp_testnet" && !testnetConfigured(env)) return { environment, label: PERP_LABEL[environment], unavailable: true, needsCredentials: true, message: "Futures testnet keys are not configured. Set BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_SECRET_KEY (futures testnet keys from testnet.binancefuture.com).", serverTime: now };
  const { ledger: L, bal } = await ledgerFor(env, deps, environment, now), live: Record<string, number | null> = {}, stale: string[] = [];
  await Promise.all(Object.keys(L.positions).map(async s => { const px = await futuresPrice(env, deps, s, now); if (px) live[s] = px; else { live[s] = L.marks[s] ?? null; stale.push(s); } }));
  const P = present(L, live, now);
  if (environment === "perp_testnet" && bal && bal.ok) { P.balances.wallet = bal.wallet; P.balances.available = bal.available; P.balances.equity = P.balances.unrealized === null ? null : bal.wallet + P.balances.unrealized; P.balances.starting = null; P.pnl.total = null; }
  if (environment === "perp_testnet" && (!bal || !bal.ok)) { P.balances.wallet = null; P.balances.available = null; P.balances.equity = null; P.balances.starting = null; P.pnl.total = null; }
  const liqAlerts = P.positions.filter(p => p.liqDistancePct !== null && p.liqDistancePct < 5).map(p => ({ symbol: p.symbol, kind: "near_liquidation", message: p.symbol + " " + p.side + " is " + p.liqDistancePct!.toFixed(2) + "% from its liquidation price (" + p.liqPrice.toFixed(4) + ")." }));
  return { environment, label: PERP_LABEL[environment], serverTime: now, simulated: environment === "perp_paper", source: environment === "perp_paper" ? "ETI internal paper simulation on Binance USDT-M prices (no exchange contacted for orders). Funding is not simulated." : "Binance futures testnet: recorded from exchange responses only.",
    balanceSource: environment === "perp_testnet" ? (bal && bal.ok ? "exchange" : "unavailable: " + (bal && !bal.ok ? bal.error : "?")) : "ledger", config: publicConfig(env),
    ...P, orders: Object.values(L.orders).sort((a, b) => b.createdAt - a.createdAt).slice(0, 150), fills: L.fills.slice(-300), curve: downsample(L.curve, 300), anomalies: L.anomalies.slice(-30), alerts: liqAlerts, marksStale: stale, eventCount: L.eventCount };
}
function publicConfig(env: PerpRouteEnv) { const c = perpConfig(env); return { maxLeverage: c.maxLeverage, takerFeeBps: c.takerBps, makerFeeBps: c.makerBps, slippageBps: c.slipBps, maintenanceMarginRate: c.mmr, minNotional: c.minNotional, marginMode: "isolated", positionMode: "one-way", testnetConfigured: testnetConfigured(env), notes: ["Isolated margin, one-way mode, USDT-margined perpetuals only.", "Liquidation uses one maintenance rate; Binance uses tiered rates per symbol, so the real liquidation price can differ.", "Funding payments are not simulated or applied.", "Leveraged positions can lose the whole margin; liquidation is automatic."] }; }

const num = (v: unknown) => v === null || v === undefined || v === "" ? null : Number(v);
function parseOrder(b: any, L: Ledger | null): { ok: true; inp: PerpOrderInput } | { ok: false; message: string } {
  const symbol = typeof b.symbol === "string" ? b.symbol.toUpperCase() : "", type = String(b.type || "market"), side = String(b.side || ""), qty = Number(b.quantity ?? b.qty);
  const reduceOnly = b.reduceOnly === true || b.reduceOnly === "true", lev = num(b.leverage), leverage = lev ?? (L?.leverage[symbol] ?? 5);
  const cid = typeof b.clientOrderId === "string" && /^[A-Za-z0-9_.-]{4,40}$/.test(b.clientOrderId) ? b.clientOrderId : crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  if (!SYMBOL_RE.test(symbol)) return { ok: false, message: "Enter a valid futures symbol such as BTCUSDT." };
  return { ok: true, inp: { clientOrderId: cid, symbol, side: side as any, type: type as any, qty, limitPrice: num(b.limitPrice), stopPrice: num(b.stopPrice), leverage, reduceOnly, source: typeof b.source === "string" ? b.source.slice(0, 40) : "dashboard" } };
}

export async function handlePerp(req: Request, env: PerpRouteEnv, deps: PerpDeps = {}): Promise<Response> {
  const url = new URL(req.url), now = (deps.now ?? Date.now)(), path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/api/perp/")) return reply({ error: "not_found" }, 404);
  const auth = await authenticate(req, env as any, now);
  if (!auth.master && auth.scopes.size === 0) return reply({ error: "unauthorized", message: "No valid ETI session or execution token. Open the dashboard to start an automatic session." }, 401);
  const post = req.method === "POST";
  let body: any = {}; if (post) { try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); } }
  const asked = String(post ? body?.environment : url.searchParams.get("environment") || "");
  const environment: PerpEnvironment = (PERP_ENVS as string[]).includes(asked) ? asked as PerpEnvironment : (auth.master || auth.scopes.has("paper") ? "perp_paper" : "perp_testnet");
  if (path === "/api/perp/config" && req.method === "GET") return reply(publicConfig(env));
  const need = scopeOf(environment);
  if (!can(auth, need)) return reply({ error: "environment_scope_mismatch", required_session: need, environment, message: "This view needs a " + (need === "paper" ? "PAPER" : "TESTNET") + " session. Sessions are isolated per environment." }, 403);
  if (!storageConfigured(env)) return reply({ error: "storage_not_configured", message: "Bind the ETI_PORTFOLIO_DB D1 database (preferred) or the ETI_EXECUTION_LOG KV namespace." }, 503);
  if (path === "/api/perp/state" && req.method === "GET") return reply(await buildPerpState(env, deps, environment, now));
  if (!post) return reply({ error: "method_not_allowed" }, 405);
  if (!auth.master) { const rl = await rateLimit(env as any, "perp:" + (auth.refs[need] || "anon"), 120, 600, now); if (!rl.ok) return reply({ error: "rate_limited" }, 429); }
  const authRef = auth.master ? "master_token" : "session:" + (auth.refs[need] || "?");
  const audit = async (what: string, detail: unknown) => { try { await ((env.ETI_EXECUTION_LOG ?? { put: async () => undefined }) as KVL).put("exec:audit:" + new Date(now).toISOString() + ":perp-" + what, JSON.stringify({ at: new Date(now).toISOString(), what: "perp_" + what, environment, authRef, detail }), { expirationTtl: 60 * 60 * 24 * 90 }); } catch { /* best effort */ } };

  if (path === "/api/perp/preview") {
    const { ledger: L, bal } = await ledgerFor(env, deps, environment, now), p = parseOrder(body, L); if (!p.ok) return reply({ error: "invalid_order", message: p.message }, 400);
    const cfg = perpConfig(env), px = await futuresPrice(env, deps, p.inp.symbol, now);
    if (environment === "perp_testnet" && bal && bal.ok) L.cash = bal.available + Object.values(L.positions).reduce((x, q) => x + q.margin, 0); // so availableBalance() equals the exchange's available balance
    const est = estimate(L, p.inp, px, cfg);
    return reply({ ok: true, environment, marketPrice: px, estimate: est, order: { symbol: p.inp.symbol, side: p.inp.side, direction: p.inp.side === "buy" ? "long" : "short", type: p.inp.type, quantity: p.inp.qty, leverage: p.inp.leverage, reduceOnly: p.inp.reduceOnly }, note: "Estimate only. Market fills differ slightly; testnet fills and fees come from the exchange." });
  }
  if (path === "/api/perp/order" || path === "/api/perp/close") {
    const { ledger: L } = await ledgerFor(env, deps, environment, now);
    let input = body;
    if (path === "/api/perp/close") {
      const sym = String(body.symbol || "").toUpperCase(), pos = L.positions[sym]; if (!pos) return reply({ error: "no_position", message: "No open " + sym + " position to close." }, 409);
      input = { ...body, symbol: sym, side: pos.side === "long" ? "sell" : "buy", type: "market", quantity: pos.qty, reduceOnly: true, leverage: pos.leverage, source: "close_button" };
    }
    const p = parseOrder(input, L); if (!p.ok) return reply({ error: "invalid_order", message: p.message }, 400);
    if (env.ETI_KILL_SWITCH === "true" && !p.inp.reduceOnly) return reply({ error: "kill_switch_active", message: "The kill switch is on: new exposure is blocked. Reduce-only orders and cancels still work." }, 423);
    const r = environment === "perp_paper" ? await placePaper(env, deps, p.inp, now) : await placeTestnet(env, deps, p.inp, now);
    await audit(path === "/api/perp/close" ? "close" : "order", { symbol: p.inp.symbol, side: p.inp.side, type: p.inp.type, qty: p.inp.qty, leverage: p.inp.leverage, reduceOnly: p.inp.reduceOnly, ok: r.ok, code: (r as any).code ?? null });
    return reply(r.ok ? { ok: true, ...r } : { ok: false, error: (r as any).code, message: (r as any).message, order: (r as any).order ?? null, marketPrice: (r as any).marketPrice ?? null, estimate: (r as any).estimate ?? null }, r.ok ? 200 : (r as any).status);
  }
  if (path === "/api/perp/cancel") {
    const orderId = typeof body.orderId === "string" ? body.orderId : ""; if (!/^[A-Za-z0-9_.:-]{4,80}$/.test(orderId)) return reply({ error: "invalid_order_id" }, 400);
    const r = environment === "perp_paper" ? await cancelPaper(env, orderId, now) : await cancelTestnet(env, deps, orderId, now);
    await audit("cancel", { orderId, ok: r.ok, code: (r as any).code ?? null });
    return reply(r.ok ? { ok: true, order: (r as any).order } : { ok: false, error: (r as any).code, message: (r as any).message }, r.ok ? 200 : (r as any).status);
  }
  if (path === "/api/perp/sync") {
    const r = environment === "perp_paper" ? await matchPaper(env, deps, now) : await syncTestnet(env, deps, now);
    const rec = environment === "perp_testnet" && testnetConfigured(env) ? await reconcileTestnet(env, deps, now) : null;
    return reply({ ok: true, environment, result: r, reconciliation: rec });
  }
  return reply({ error: "not_found" }, 404);
}

/** Cron: match paper orders/liquidations and pull testnet fills. Isolated and best effort; idle streams are skipped after one read. */
export async function runPerpCycle(env: PerpRouteEnv, deps: PerpDeps = {}) {
  if (!storageConfigured(env)) return null;
  const now = (deps.now ?? Date.now)(), out: Record<string, unknown> = {};
  for (const environment of PERP_ENVS) {
    try {
      if (environment === "perp_testnet" && !testnetConfigured(env)) { out[environment] = "not_configured"; continue; }
      const st = perpStore(env, environment), head = await st.head(), idle = await st.kvGet<{ head: string } | null>("idle", null);
      if (idle && idle.head === head) { out[environment] = "idle"; continue; }
      const r: any = environment === "perp_paper" ? await matchPaper(env, deps, now) : await syncTestnet(env, deps, now);
      out[environment] = r; if (r.idle) await st.kvPut("idle", { head: await st.head() });
    } catch (e) { out[environment] = "error: " + (e instanceof Error ? e.message : "?"); }
  }
  return out;
}
export function withPerp(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: (req: Request, env: any, ctx?: any) => new URL(req.url).pathname.startsWith("/api/perp/") ? handlePerp(req, env) : inner.fetch(req, env, ctx) };
}

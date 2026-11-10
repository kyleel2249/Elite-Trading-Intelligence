/**
 * /api/portfolio/*: read and manage the persistent portfolio ledger.
 *   GET  /api/portfolio/state?environment=internal_paper|exchange_testnet|live[&symbol=]
 *   GET  /api/portfolio/history?environment=&symbol=&strategy=&result=&from=&to=&source=[&format=csv]
 *   POST /api/portfolio/cancel     {environment, orderId}
 *   POST /api/portfolio/plan       {environment, symbol, stop, tp1, tp2, tp3}
 *   POST /api/portfolio/sync       {environment}     internal: match resting orders now; testnet: pull broker order/fill state
 *   POST /api/portfolio/reconcile  {environment}
 * Every call is authenticated per environment (INTERNAL PAPER and EXCHANGE TESTNET sessions are isolated; the master token sees all).
 * The live environment has no ledger: it reports "disabled" and never accepts changes.
 */
import { authenticate, can, rateLimit, type EnvScope } from "../auth/session.ts";
import { cancelExchange, cancelInternal, ensureInit, matchInternal, reconcile, setPlan, syncExchange, type EngineDeps, type EngineEnv } from "./engine.ts";
import { present, type ClosedTrade, type Environment } from "./ledger.ts";
import { PortfolioStore, type KVL } from "./store.ts";
import { loadMinuteBars } from "../algo/market-inputs.ts";

export type PortfolioEnv = EngineEnv & { ETI_EXECUTION_TOKEN?: string; ETI_SESSION_SECRET?: string; ETI_SESSION_SECRET_PREVIOUS?: string; ETI_AUTO_SESSIONS?: string; ETI_KEY_ROTATION_DAYS?: string; ETI_KILL_SWITCH?: string };
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
export const ENVIRONMENTS: Environment[] = ["internal_paper", "exchange_testnet", "live"];
const scopeOf = (e: Environment): EnvScope | null => e === "internal_paper" ? "paper" : e === "exchange_testnet" ? "testnet" : null;
export const LABEL: Record<Environment, string> = { internal_paper: "Internal Paper", exchange_testnet: "Exchange Testnet", live: "Live" };
const livePrice = new Map<string, { at: number; px: number | null }>();
async function quote(env: PortfolioEnv, deps: EngineDeps, symbol: string, now: number): Promise<number | null> {
  if (deps.priceOf) { try { return await deps.priceOf(symbol); } catch { return null; } }
  const c = livePrice.get(symbol); if (c && now - c.at < 8000) return c.px;
  let px: number | null = null; try { px = deps.priceOf ? await deps.priceOf(symbol) : (await loadMinuteBars(env as any, symbol, null, now)).price; } catch { px = null; }
  livePrice.set(symbol, { at: now, px }); return px;
}
function downsample<T>(a: T[], max: number): T[] { if (a.length <= max) return a; const step = a.length / max, out: T[] = []; for (let i = 0; i < max; i++) out.push(a[Math.floor(i * step)]); out.push(a[a.length - 1]); return out; }

export function filterClosed(trades: ClosedTrade[], q: URLSearchParams): ClosedTrade[] {
  const sym = (q.get("symbol") || "").toUpperCase(), strat = (q.get("strategy") || "").toLowerCase(), res = q.get("result") || "", src = q.get("source") || "";
  const from = q.get("from") ? Date.parse(q.get("from")!) : NaN, to = q.get("to") ? Date.parse(q.get("to")!) : NaN;
  return trades.filter(t => (!sym || t.symbol.includes(sym)) && (!strat || (t.strategy || "").toLowerCase().includes(strat)) && (!res || t.result === res)
    && (!src || t.fills.some(f => f.origin === src)) && (!Number.isFinite(from) || t.exitAt >= from) && (!Number.isFinite(to) || t.exitAt <= to + 86_399_999));
}
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function closedCsv(trades: ClosedTrade[], source: string): string {
  const head = ["symbol", "side", "qty", "entry_price", "exit_price", "entry_time", "exit_time", "holding_ms", "gross_pnl", "fees", "net_pnl", "slippage_cost", "result", "strategy", "signal_id", "source"];
  return [head.join(","), ...trades.map(t => [t.symbol, "long", t.qty, t.entryPrice, t.exitPrice, new Date(t.entryAt).toISOString(), new Date(t.exitAt).toISOString(), t.holdingMs, t.gross, t.unknownFees ? "" : t.fees, t.unknownFees ? "" : t.net, t.slippageCost, t.result, t.strategy, t.signalId, source].map(csvCell).join(","))].join("\n");
}

export async function buildState(env: PortfolioEnv, deps: EngineDeps, environment: Environment, now: number, symbol?: string) {
  if (environment === "live") return { environment, label: LABEL.live, disabled: true, message: "Live trading is disabled. No live ledger exists and no live orders are placed from this dashboard.", serverTime: now };
  if (!env.ETI_EXECUTION_LOG) return { environment, label: LABEL[environment], unavailable: true, message: "The ETI_EXECUTION_LOG KV binding is not configured, so no portfolio can be stored.", serverTime: now };
  if (environment === "internal_paper") await ensureInit(env, now);
  const st = new PortfolioStore(env.ETI_EXECUTION_LOG as KVL, environment), { ledger: L, version, truncated, cached } = await st.ledgerFast(now);
  const live: Record<string, number | null> = {}, stale: string[] = [];
  await Promise.all(Object.keys(L.positions).map(async s => { const px = await quote(env, deps, s, now); if (px) live[s] = px; else { live[s] = L.marks[s] ?? null; stale.push(s); } }));
  const P = present(L, live, now, stale);
  const alerts = P.positions.flatMap(p => {
    const a: { symbol: string; kind: string; level: number; message: string }[] = [];
    if (p.markPrice !== null && !p.markStale) {
      if (p.levels.stop !== null && p.markPrice <= p.levels.stop) a.push({ symbol: p.symbol, kind: "stop_level_reached", level: p.levels.stop, message: environment === "exchange_testnet" ? p.symbol + " is at or below its stop. Testnet levels are alert-only: close the position manually." : p.symbol + " is at or below its stop; the engine exits on the next minute bar." });
      p.levels.tp.forEach((tp, i) => { if (tp !== null && !p.levels.hit[i] && p.markPrice! >= tp) a.push({ symbol: p.symbol, kind: "tp" + (i + 1) + "_level_reached", level: tp, message: p.symbol + " reached TP" + (i + 1) + (environment === "exchange_testnet" ? " (alert only: take profit manually)." : ".") }); });
    }
    return a;
  });
  const orders = Object.values(L.orders).sort((a, b) => b.createdAt - a.createdAt).slice(0, 150);
  const fills = L.fills.filter(f => !symbol || f.symbol === symbol).slice(-600).map(f => ({ orderId: f.orderId, fillId: f.fillId, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee, at: f.at, origin: f.origin, applied: f.applied, positionId: f.positionId, slippageBps: f.slippageBps }));
  return {
    environment, label: LABEL[environment], serverTime: now, version, cached, truncated, simulated: environment === "internal_paper", source: environment === "internal_paper" ? "ETI internal paper simulation (no exchange contacted)" : "Exchange testnet fills as reported by the broker",
    sync: { mode: "polling", consistency: "KV is eventually consistent; another edge location can lag up to about a minute behind the writer." },
    ...P, curve: downsample(P.curve, 400), orders, fills, anomalies: L.anomalies.slice(-30), alerts, recon: await st.kvGet("recon", null), eventCount: L.eventCount,
    marksStale: stale,
  };
}

export async function handlePortfolio(req: Request, env: PortfolioEnv, deps: EngineDeps = {}): Promise<Response> {
  const url = new URL(req.url), now = (deps.now ?? Date.now)(), path = url.pathname;
  if (!path.startsWith("/api/portfolio/")) return reply({ error: "not_found" }, 404);
  const auth = await authenticate(req, env, now);
  if (!auth.master && auth.scopes.size === 0) return reply({ error: "unauthorized", message: "No valid ETI session or execution token. Open the dashboard to start an automatic session." }, 401);
  const post = req.method === "POST";
  let body: any = {}; if (post) { try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); } }
  const asked = (post ? body?.environment : url.searchParams.get("environment")) as string | null;
  const environment = (ENVIRONMENTS as string[]).includes(asked || "") ? asked as Environment : (auth.master || auth.scopes.has("paper") ? "internal_paper" : "exchange_testnet");
  const need = scopeOf(environment);
  if (need && !can(auth, need)) return reply({ error: "environment_scope_mismatch", required_session: need, environment, message: "This view needs an " + LABEL[environment].toUpperCase() + " session. Sessions are isolated per environment." }, 403);
  if (environment === "live") return reply(post ? { error: "live_disabled", message: "Live trading is disabled; there is nothing to change." } : await buildState(env, deps, "live", now), post ? 423 : 200);
  if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured", message: "Configure the ETI_EXECUTION_LOG KV binding to store the portfolio." }, 503);

  if (path === "/api/portfolio/state" && req.method === "GET") return reply(await buildState(env, deps, environment, now, (url.searchParams.get("symbol") || "").toUpperCase() || undefined));
  if (path === "/api/portfolio/history" && req.method === "GET") {
    const st = new PortfolioStore(env.ETI_EXECUTION_LOG as KVL, environment), { ledger: L } = await st.ledgerFast(now), rows = filterClosed(L.closed.slice().sort((a, b) => b.exitAt - a.exitAt), url.searchParams);
    const label = environment === "internal_paper" ? "Internal Paper" : "Exchange Testnet";
    if (url.searchParams.get("format") === "csv") return new Response(closedCsv(rows, label), { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": "attachment; filename=eti-closed-trades-" + environment + ".csv" } });
    return reply({ environment, label, total: L.closed.length, count: rows.length, trades: rows.slice(0, 500) });
  }
  if (!post) return reply({ error: "method_not_allowed" }, 405);
  if (!auth.master) { const rl = await rateLimit(env as any, "pf:" + (auth.refs[need!] || "anon"), 120, 600, now); if (!rl.ok) return reply({ error: "rate_limited" }, 429); }
  const authRef = auth.master ? "master_token" : "session:" + (auth.refs[need!] || "?");
  const audit = async (what: string, detail: unknown) => { try { await (env.ETI_EXECUTION_LOG as KVL).put("exec:audit:" + new Date(now).toISOString() + ":" + what, JSON.stringify({ at: new Date(now).toISOString(), what, environment, auth: authRef, detail }), { expirationTtl: 60 * 60 * 24 * 90 }); } catch { /* audit is best effort here; the ledger event is the record */ } };
  if (path === "/api/portfolio/cancel") {
    const orderId = typeof body.orderId === "string" ? body.orderId : ""; if (!/^[A-Za-z0-9_.:-]{4,80}$/.test(orderId)) return reply({ error: "invalid_order_id" }, 400);
    const r = environment === "internal_paper" ? await cancelInternal(env, orderId, now, authRef) : await cancelExchange(env, deps, orderId, now);
    await audit("cancel", { orderId, ok: r.ok, code: (r as any).code ?? null });
    return reply(r.ok ? { ok: true, order: r.order } : { ok: false, error: r.code, message: (r as any).message ?? null }, r.ok ? 200 : r.status);
  }
  if (path === "/api/portfolio/plan") {
    const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "", n = (v: unknown) => v === null || v === "" ? null : v === undefined ? undefined : Number(v);
    if (!/^[A-Z0-9._-]{2,24}$/.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
    const plan = { stop: n(body.stop), tp: [n(body.tp1), n(body.tp2), n(body.tp3)] as (number | null)[] };
    if ([plan.stop, ...plan.tp].some(v => typeof v === "number" && !Number.isFinite(v))) return reply({ error: "invalid_levels", message: "Levels must be numbers." }, 400);
    const r = await setPlan(env, environment, symbol, plan, now); await audit("plan", { symbol, ok: r.ok });
    return reply(r.ok ? { ok: true, levels: r.levels } : { ok: false, error: r.code, message: r.message }, r.ok ? 200 : r.status);
  }
  if (path === "/api/portfolio/sync") {
    const r = environment === "internal_paper" ? await matchInternal(env, deps, now) : await syncExchange(env, deps, now);
    return reply({ ok: true, environment, result: r });
  }
  if (path === "/api/portfolio/reconcile") {
    const rec = await reconcile(env, deps, environment, now); await audit("reconcile", { ok: rec.ok, problems: rec.problems.length });
    return reply({ ok: true, reconciliation: rec });
  }
  return reply({ error: "not_found" }, 404);
}

/** Cron entry: match internal paper orders and exits, pull testnet fills. Isolated and best effort. A stream with nothing active and no new events is skipped after a single KV read. */
export async function runPortfolioCycle(env: PortfolioEnv, deps: EngineDeps = {}) {
  if (!env.ETI_EXECUTION_LOG) return null;
  const now = (deps.now ?? Date.now)(), out: Record<string, unknown> = {};
  for (const environment of ["internal_paper", "exchange_testnet"] as const) {
    try {
      const st = new PortfolioStore(env.ETI_EXECUTION_LOG as KVL, environment), head = (await st.kv.get("pf:" + environment + ":head")) ?? "none", idle = await st.kvGet<{ head: string } | null>("idle", null);
      if (idle && idle.head === head) { out[environment] = "idle"; continue; }
      const r: any = environment === "internal_paper" ? await matchInternal(env, deps, now) : await syncExchange(env, deps, now);
      out[environment] = r;
      const head2 = (await st.kv.get("pf:" + environment + ":head")) ?? "none";
      if (r.idle) await st.kvPut("idle", { head: head2 }); // nothing active: sleep until a new event arrives
    } catch (e) { out[environment] = "error: " + (e instanceof Error ? e.message : "?"); }
  }
  return out;
}

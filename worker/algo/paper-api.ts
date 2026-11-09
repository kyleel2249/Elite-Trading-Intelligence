// Authenticated paper-trading API. SIMULATED fills only: it never contacts a broker and exposes no withdrawal,
// transfer or live-mode concept. Every order is preflighted through the ETI server-side risk gateway (the same
// service and contract as /api/orders) and fails closed when the gateway is missing, unreachable or says no.
//
//   GET  /api/paper/status
//   POST /api/paper/evaluate   {symbol, strategy, execute?}   analyse; with execute=true open a paper position if approved
//   POST /api/paper/tick       {symbol}                        advance an open position with closed 1m bars
//   POST /api/paper/kill       {on}                            engage/release the paper kill switch
//   GET  /api/paper/performance
//   GET  /api/paper/audit?limit=100
import { authorized, type ExecutionEnv } from "../execution.ts";
import type { MarketEnv } from "../market.ts";
import type { Strategy } from "./timeframes.ts";
import { STRATEGIES } from "./omni-api.ts";
import { loadMinuteBars, loadSignalInputs } from "./market-inputs.ts";
import { runOmnisignal } from "./omnisignal.ts";
import { KVPaperStore, PaperEngine, type KVLike, type Preflight, type PreflightRequest } from "./paper.ts";
import { calibration, reportsBy, reportsByEngine, windowedReports } from "./performance.ts";

export interface PaperEnv extends ExecutionEnv, MarketEnv {}
export interface PaperDeps { now?: () => number; fetchImpl?: typeof fetch }
interface KVWithList extends KVLike { list(o: { prefix: string; limit?: number }): Promise<{ keys: { name: string }[] }> }

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body, (k, v) => (v === Infinity ? "Infinity" : v)), { status, headers: HEADERS });

/** Adapter to the Python POST /api/risk-gateway/preflight contract. Returns null when the gateway is not configured. */
export function makeGatePreflight(env: ExecutionEnv, fetchImpl: typeof fetch = fetch): Preflight | null {
  const url = env.ETI_RISK_GATE_URL, token = env.ETI_RISK_GATE_TOKEN;
  if (!url || !token) return null;
  return async (r: PreflightRequest) => {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ provider: "binance", environment: "paper", symbol: r.symbol, side: r.side, quantity: r.quantity, order_type: r.orderType, limit_price: r.limitPrice }) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return { approved: false, reasons: [`Risk gateway responded HTTP ${res.status}`, ...(Array.isArray(body?.reasons) ? body.reasons : [])] };
    return { approved: body?.approved === true, reasons: Array.isArray(body?.reasons) ? body.reasons : [] };
  };
}

export async function handlePaper(req: Request, env: PaperEnv, deps: PaperDeps = {}): Promise<Response> {
  const url = new URL(req.url), now = (deps.now ?? Date.now)(), path = url.pathname.replace(/\/+$/, "");
  const known: Record<string, string> = { "/api/paper/status": "GET", "/api/paper/performance": "GET", "/api/paper/audit": "GET", "/api/paper/evaluate": "POST", "/api/paper/tick": "POST", "/api/paper/kill": "POST" };
  if (!(path in known)) return reply({ error: "not_found" }, 404);
  if (!(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
  if (req.method !== known[path]) return reply({ error: "method_not_allowed", allowed: known[path] }, 405);
  if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured", message: "Bind the ETI_EXECUTION_LOG KV namespace; paper state and audit trail are stored there." }, 503);
  const kv = env.ETI_EXECUTION_LOG as unknown as KVWithList, store = new KVPaperStore(kv);
  const envKill = env.ETI_KILL_SWITCH === "true";
  const engine = await PaperEngine.create(store, makeGatePreflight(env, deps.fetchImpl ?? fetch), {}, now);
  const body: any = req.method === "POST" ? await req.json().catch(() => null) : {};
  if (req.method === "POST" && (body === null || typeof body !== "object")) return reply({ error: "invalid_json_body" }, 400);
  const symbolOf = () => String(body?.symbol ?? "BTCUSDT").toUpperCase();
  const validSymbol = (s: string) => /^[A-Z0-9]{5,20}$/.test(s);

  if (path === "/api/paper/status") {
    const s = engine.state;
    return reply({ mode: "paper", simulated: true, equity: s.equity, startingEquity: engine.cfg.startingEquity, openPositions: s.positions, closedTrades: s.closed.length, killSwitch: s.killSwitch || envKill, envKillSwitch: envKill,
      riskGateConfigured: !!(env.ETI_RISK_GATE_URL && env.ETI_RISK_GATE_TOKEN), config: engine.cfg, withdrawalPermissions: false, liveTradingAvailable: false, stateVersion: s.version,
      note: "Simulated fills against live public prices; no broker is contacted. State is stored in KV without transactions, so issue paper requests one at a time." });
  }
  if (path === "/api/paper/performance") {
    const t = engine.state.closed;
    return reply({ windows: windowedReports(t, now, engine.cfg.startingEquity), byEngine: reportsByEngine(t, engine.cfg.startingEquity), byRegime: reportsBy(t, "regime", engine.cfg.startingEquity), calibration: calibration(t), trades: t.length,
      disclosure: "Simulated results. Rates and ratios are withheld below 30 closed trades; past results do not guarantee future results." });
  }
  if (path === "/api/paper/audit") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 100)));
    const listed = await kv.list({ prefix: "eti:paper:audit:", limit: 1000 });
    const names = listed.keys.map(k => k.name).slice(-limit);
    const entries = (await Promise.all(names.map(async n => JSON.parse((await kv.get(n)) || "null")))).filter(Boolean);
    return reply({ count: entries.length, entries });
  }
  if (path === "/api/paper/kill") {
    if (typeof body.on !== "boolean") return reply({ error: "invalid_request", message: "'on' must be true or false" }, 400);
    return reply({ event: await engine.setKillSwitch(body.on, now), killSwitch: engine.state.killSwitch, envKillSwitch: envKill });
  }

  const symbol = symbolOf();
  if (!validSymbol(symbol)) return reply({ error: "invalid_symbol" }, 400);
  if (path === "/api/paper/tick") {
    const p = engine.state.positions.find(x => x.symbol === symbol);
    if (!p) return reply({ symbol, events: [], position: null, message: "No open paper position on this symbol" });
    let m; try { m = await loadMinuteBars(env, symbol, null, now); } catch (e) { return reply({ error: "market_data_unavailable", detail: e instanceof Error ? e.message : "unknown" }, 503); }
    // Bars that opened before the fill are excluded (their range pre-dates the position); the partial minute containing the fill is unmonitored.
    const bars = m.bars.filter(k => k[0] >= p.openedAt).map(k => ({ ts: k[0] + 60_000, high: k[2], low: k[3], close: k[4] }));
    const pending = bars.filter(b => b.ts > (p.lastBarTs ?? p.openedAt)).length, events = await engine.processBars(symbol, bars);
    return reply({ symbol, barsPending: pending, events, position: engine.state.positions.find(x => x.symbol === symbol) ?? null, equity: engine.state.equity,
      granularity: "closed 1-minute bars; stop-first when a bar touches both stop and target" });
  }

  // evaluate
  const strategy = String(body?.strategy ?? "intraday") as Strategy;
  if (!STRATEGIES.includes(strategy)) return reply({ error: "invalid_strategy", strategies: STRATEGIES }, 400);
  if (body?.execute !== undefined && typeof body.execute !== "boolean") return reply({ error: "invalid_request", message: "'execute' must be boolean" }, 400);
  const inputs = await loadSignalInputs(env, symbol, strategy, null, now);
  if ("error" in inputs) return reply({ decision: "DATA_UNRELIABLE", ...inputs, submitsOrder: false }, 503);
  const plan = runOmnisignal({ symbol, strategy, candles: inputs.candles, depth: inputs.depth, now });
  const out: Record<string, unknown> = { symbol, strategy, plan, executed: false, event: null, submitsOrder: false };
  if (body?.execute === true) {
    if (envKill) { out.event = { type: "REJECTED", reasons: ["Emergency kill switch (ETI_KILL_SWITCH) is active"] }; return reply(out, 423); }
    if (plan.decision === "BUY" || plan.decision === "SELL") {
      let m; try { m = await loadMinuteBars(env, symbol, null, now); } catch { m = { bars: [], price: null, provider: "unknown" }; }
      out.event = m.price === null ? { type: "REJECTED", reasons: ["No fresh live price available for a paper fill"] } : await engine.open(plan, m.price, now);
      out.executed = (out.event as { type: string }).type === "OPENED";
    } else out.event = { type: "REJECTED", reasons: [`Decision is ${plan.decision}; nothing to execute`] };
  }
  return reply(out);
}

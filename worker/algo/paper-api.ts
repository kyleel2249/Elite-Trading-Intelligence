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
import { costBpsFrom, runOmnisignal } from "./omnisignal.ts";
import { activeOptions, paramsOp } from "./params.ts";
import { KVPaperStore, PaperEngine, type KVLike, type Preflight, type PreflightRequest } from "./paper.ts";
import { calibration, reportsBy, reportsByEngine, windowedReports } from "./performance.ts";

export interface PaperEnv extends ExecutionEnv, MarketEnv { ETI_PAPER_SYMBOLS?: string; ETI_PAPER_STRATEGY?: string; ETI_PAPER_AUTOEXECUTE?: string; ETI_ROUND_TRIP_COST_BPS?: string }
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
  const known: Record<string, string> = { "/api/paper/status": "GET", "/api/paper/performance": "GET", "/api/paper/audit": "GET", "/api/paper/evaluate": "POST", "/api/paper/tick": "POST", "/api/paper/kill": "POST", "/api/paper/params": "GET", "/api/paper/params/propose": "POST", "/api/paper/params/promote": "POST", "/api/paper/params/rollback": "POST" };
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
      scheduler: { ...(({ symbols, strategy, autoExecute, ignored }) => ({ symbols, strategy, autoExecute, ignoredSymbols: ignored }))(cycleConfig(env)), maxSymbolsPerRun: MAX_CYCLE_SYMBOLS, lastRun: await readLastRun(env) },
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

  if (path.startsWith("/api/paper/params")) { const r = await paramsOp(path.split("/").pop() === "params" ? "get" : (path.split("/").pop() as "propose" | "promote" | "rollback"), env.ETI_EXECUTION_LOG as any, body, now); return reply(r.body, r.status); }

  const symbol = symbolOf();
  if (!validSymbol(symbol)) return reply({ error: "invalid_symbol" }, 400);
  if (path === "/api/paper/tick") { const r = await tickSymbol(engine, env, symbol, now); return reply(r.body, r.status); }

  const strategy = String(body?.strategy ?? "intraday") as Strategy;
  if (!STRATEGIES.includes(strategy)) return reply({ error: "invalid_strategy", strategies: STRATEGIES }, 400);
  if (body?.execute !== undefined && typeof body.execute !== "boolean") return reply({ error: "invalid_request", message: "'execute' must be boolean" }, 400);
  const r = await evaluateSymbol(engine, env, symbol, strategy, body?.execute === true, now, envKill);
  return reply(r.body, r.status);
}

export interface OpResult { status: number; body: Record<string, unknown> }
/** Advance an open position with closed 1-minute bars (each bar is applied once). */
export async function tickSymbol(engine: PaperEngine, env: PaperEnv, symbol: string, now: number): Promise<OpResult> {
  const p = engine.state.positions.find(x => x.symbol === symbol);
  if (!p) return { status: 200, body: { symbol, events: [], position: null, message: "No open paper position on this symbol" } };
  let m; try { m = await loadMinuteBars(env, symbol, null, now); } catch (e) { return { status: 503, body: { error: "market_data_unavailable", detail: e instanceof Error ? e.message : "unknown" } }; }
  // Bars that opened before the fill are excluded (their range pre-dates the position); the partial minute containing the fill is unmonitored.
  const bars = m.bars.filter(k => k[0] >= p.openedAt).map(k => ({ ts: k[0] + 60_000, high: k[2], low: k[3], close: k[4] }));
  const pending = bars.filter(b => b.ts > (p.lastBarTs ?? p.openedAt)).length, events = await engine.processBars(symbol, bars);
  return { status: 200, body: { symbol, barsPending: pending, events, position: engine.state.positions.find(x => x.symbol === symbol) ?? null, equity: engine.state.equity, granularity: "closed 1-minute bars; stop-first when a bar touches both stop and target" } };
}
/** Analyse a symbol and, when `execute` is true, open a paper position if the plan is BUY/SELL and the risk gateway approves. */
export async function evaluateSymbol(engine: PaperEngine, env: PaperEnv, symbol: string, strategy: Strategy, execute: boolean, now: number, envKill: boolean): Promise<OpResult> {
  let active; try { active = await activeOptions(env.ETI_EXECUTION_LOG as any, () => now); } catch { return { status: 503, body: { error: "params_unavailable", message: "The parameter registry could not be read, so no new analysis or entry is made.", submitsOrder: false } }; }
  const inputs = await loadSignalInputs(env, symbol, strategy, null, now);
  if ("error" in inputs) return { status: 503, body: { decision: "DATA_UNRELIABLE", ...inputs, submitsOrder: false } };
  const { version, name, ...opts } = active;
  const plan = runOmnisignal({ symbol, strategy, candles: inputs.candles, depth: inputs.depth, now }, { roundTripCostBps: costBpsFrom(env), ...opts });
  const out: Record<string, unknown> = { symbol, strategy, parameters: { version, name }, plan, executed: false, event: null, submitsOrder: false };
  if (!execute) return { status: 200, body: out };
  if (envKill) { out.event = { type: "REJECTED", reasons: ["Emergency kill switch (ETI_KILL_SWITCH) is active"] }; return { status: 423, body: out }; }
  if (plan.decision === "BUY" || plan.decision === "SELL") {
    let m; try { m = await loadMinuteBars(env, symbol, null, now); } catch { m = { bars: [], price: null, provider: "unknown" }; }
    out.event = m.price === null ? { type: "REJECTED", reasons: ["No fresh live price available for a paper fill"] } : await engine.open(plan, m.price, now);
    out.executed = (out.event as { type: string }).type === "OPENED";
  } else out.event = { type: "REJECTED", reasons: [`Decision is ${plan.decision}; nothing to execute`] };
  return { status: 200, body: out };
}

// ---------- scheduled cycle ----------
/** Free-plan Workers allow ~50 subrequests per invocation and one symbol costs ~10, so a run is capped. */
export const MAX_CYCLE_SYMBOLS = 3;
export interface CycleConfig { symbols: string[]; strategy: Strategy; autoExecute: boolean; ignored: string[] }
export function cycleConfig(env: PaperEnv): CycleConfig {
  const raw = (env.ETI_PAPER_SYMBOLS || "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean), good = [...new Set(raw.filter(x => /^[A-Z0-9]{5,20}$/.test(x)))];
  const strategy = STRATEGIES.includes(env.ETI_PAPER_STRATEGY as Strategy) ? (env.ETI_PAPER_STRATEGY as Strategy) : "intraday";
  return { symbols: good.slice(0, MAX_CYCLE_SYMBOLS), strategy, autoExecute: env.ETI_PAPER_AUTOEXECUTE === "true", ignored: [...raw.filter(x => !good.includes(x)), ...good.slice(MAX_CYCLE_SYMBOLS)] };
}
export interface CycleItem { symbol: string; action: "tick" | "evaluate"; decision?: string; event?: string; reasons?: string[]; events?: string[]; error?: string }
export interface CycleSummary { ran: boolean; reason?: string; at: string; autoExecute?: boolean; strategy?: Strategy; items: CycleItem[]; ignoredSymbols?: string[]; killSwitch?: boolean; equity?: number; openPositions?: number }
const LASTRUN_KEY = "eti:paper:lastrun";

/** One scheduled pass: manage every open position, then evaluate configured symbols. Disabled unless ETI_PAPER_SYMBOLS is set.
 *  Opening new positions additionally requires ETI_PAPER_AUTOEXECUTE=true and no kill switch; managing open positions never stops. */
export async function runPaperCycle(env: PaperEnv, deps: PaperDeps = {}): Promise<CycleSummary> {
  const now = (deps.now ?? Date.now)(), at = new Date(now).toISOString(), cfg = cycleConfig(env);
  if (!env.ETI_EXECUTION_LOG) return { ran: false, reason: "ETI_EXECUTION_LOG KV binding is not configured", at, items: [] };
  const kv = env.ETI_EXECUTION_LOG as unknown as KVWithList, engine = await PaperEngine.create(new KVPaperStore(kv), makeGatePreflight(env, deps.fetchImpl ?? fetch), {}, now);
  const open = engine.state.positions.map(p => p.symbol);
  if (!cfg.symbols.length && !open.length) return { ran: false, reason: "ETI_PAPER_SYMBOLS is not set and there are no open positions", at, items: [] };
  const envKill = env.ETI_KILL_SWITCH === "true", killed = envKill || engine.state.killSwitch, items: CycleItem[] = [];
  const targets = [...new Set([...open, ...cfg.symbols])].slice(0, Math.max(MAX_CYCLE_SYMBOLS, open.length)); // open positions always get managed
  for (const symbol of targets) {
    const holds = engine.state.positions.some(p => p.symbol === symbol);
    try {
      if (holds) {
        const r = await tickSymbol(engine, env, symbol, now), b = r.body as any;
        items.push(r.status === 200 ? { symbol, action: "tick", events: (b.events ?? []).map((e: any) => e.type) } : { symbol, action: "tick", error: String(b.error ?? `HTTP ${r.status}`) });
      } else if (cfg.symbols.includes(symbol)) {
        const execute = cfg.autoExecute && !killed, r = await evaluateSymbol(engine, env, symbol, cfg.strategy, execute, now, envKill), b = r.body as any;
        const skipped = cfg.autoExecute && killed && r.status === 200; // evaluated but deliberately not executed: say why
        items.push(r.status === 200 || r.status === 423 ? { symbol, action: "evaluate", decision: b.plan?.decision, event: skipped ? "SKIPPED" : b.event?.type, reasons: skipped ? ["Kill switch active: new entries are disabled"] : b.event?.reasons } : { symbol, action: "evaluate", decision: b.decision, error: String(b.error ?? `HTTP ${r.status}`) });
      }
    } catch (e) { items.push({ symbol, action: holds ? "tick" : "evaluate", error: e instanceof Error ? e.message : "unknown" }); } // one symbol failing never stops the rest
  }
  const summary: CycleSummary = { ran: true, at, autoExecute: cfg.autoExecute, strategy: cfg.strategy, items, ignoredSymbols: cfg.ignored, killSwitch: killed, equity: engine.state.equity, openPositions: engine.state.positions.length };
  try { await kv.put(LASTRUN_KEY, JSON.stringify(summary)); } catch { /* the summary is informational; trading state was already persisted */ }
  return summary;
}
export async function readLastRun(env: PaperEnv): Promise<CycleSummary | null> {
  try { const v = await (env.ETI_EXECUTION_LOG as unknown as KVWithList | undefined)?.get(LASTRUN_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
}

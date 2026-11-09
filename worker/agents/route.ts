/**
 * HTTP surface for the multi-agent system. Wrapped around the existing application (worker/main.ts):
 *   GET  /api/agents                 roster, contracts, configuration needs
 *   GET|POST /api/agents/analyze     read-only analysis (POST accepts supplied research data and account state)
 *   POST /api/agents/execute         bearer-authenticated; only reaches /api/orders if Commander AND Risk Manager approve
 *   GET  /api/agents/audit           bearer-authenticated; Performance Auditor over recorded decisions
 */
import { AllProvidersFailed, INTERVALS, getMarketData, providerOrder } from "../market.ts";
import type { MarketEnv, Ticker } from "../market.ts";
import { handleExecution } from "../execution.ts";
import type { ExecutionEnv } from "../execution.ts";
import { AGENT_ROSTER } from "./types.ts";
import type { AccountState, Integrity, MarketInput, SuppliedData } from "./types.ts";
import { analyze, toDecisionRecord } from "./orchestrator.ts";
import type { AnalysisResult } from "./orchestrator.ts";
import { auditSummary, evaluateDecision } from "./controls.ts";
import type { AuditSummary, DecisionRecord, ExecutionRequest } from "./controls.ts";
import { finite } from "./math.ts";

export type AgentsEnv = MarketEnv & ExecutionEnv;
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
export type MarketLoader = (env: AgentsEnv, symbol: string, interval: string, opts: { provider?: string | null; benchmark?: string | null }) => Promise<MarketInput>;
export interface AgentsDeps { loadMarket?: MarketLoader; now?: () => number }

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const SYMBOL = /^[A-Z0-9]{5,20}$/, MAX_BODY = 200_000, TTL = 60 * 60 * 24 * 90;

export function integrityFromEnv(env: ExecutionEnv): Integrity {
  return {
    killSwitch: env.ETI_KILL_SWITCH === "true", liveTradingEnabled: env.ETI_LIVE_TRADING_ENABLED === "true",
    liveCapsConfigured: Number(env.ETI_LIVE_MAX_NOTIONAL_USD) > 0 && Number(env.ETI_LIVE_MAX_ORDER_QUANTITY) > 0,
    riskGateConfigured: !!(env.ETI_RISK_GATE_URL && env.ETI_RISK_GATE_TOKEN), executionTokenConfigured: !!env.ETI_EXECUTION_TOKEN, auditLogConfigured: !!env.ETI_EXECUTION_LOG,
  };
}

async function bearerOk(req: Request, env: ExecutionEnv): Promise<boolean> {
  const token = env.ETI_EXECUTION_TOKEN, supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** Live read-only market snapshot. Throws AllProvidersFailed if candles cannot be obtained; never substitutes data. */
export const loadMarket: MarketLoader = async (env, symbol, interval, opts) => {
  const order = providerOrder(env, opts.provider ?? null), failures: Record<string, string> = {};
  const name = (e: unknown) => (e instanceof AllProvidersFailed ? "all_providers_failed" : e instanceof Error ? e.message : "unknown");
  const kP = getMarketData("klines", { symbol, interval, limit: 300 }, order);
  const dP = getMarketData("depth", { symbol, interval, limit: 100 }, order).catch((e) => { failures.depth = name(e); return null; });
  const bP = opts.benchmark ? getMarketData("klines", { symbol: opts.benchmark, interval, limit: 300 }, order).catch((e) => { failures.benchmark = name(e); return null; }) : Promise.resolve(null);
  const k = await kP, d = await dP, b = await bP;
  let crossCheck: MarketInput["crossCheck"] = null;
  const other = order.find((p) => p !== k.provider);
  if (other) {
    try { const t = await getMarketData("ticker", { symbol, interval, limit: 1 }, [other]); crossCheck = { provider: t.provider, price: (t.data as Ticker).lastPrice }; }
    catch (e) { failures.cross_check = name(e); }
  }
  return { symbol, interval, candles: k.data as MarketInput["candles"], depth: d ? (d.data as MarketInput["depth"]) : null, provider: k.provider, fetchedAt: Date.now(), crossCheck, benchmark: b && opts.benchmark ? { symbol: opts.benchmark, candles: b.data as MarketInput["candles"] } : null, failures };
};

function parseAccount(v: unknown): AccountState | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>, out: AccountState = {};
  for (const k of ["equityUsd", "availableUsd", "positionQuantity", "dailyPnlPct", "drawdownPct", "openRiskPct"] as const) { const n = finite(o[k]); if (n !== undefined) out[k] = n; }
  return out;
}
const supplied = (b: Record<string, unknown>): SuppliedData => ({ fundamentals: b.fundamentals, macro: b.macro, news: b.news, onchain: b.onchain });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("body_too_large");
  if (!text.trim()) return {};
  const j = JSON.parse(text);
  return j && typeof j === "object" && !Array.isArray(j) ? j : null;
}

async function record(env: AgentsEnv, r: AnalysisResult, executed: boolean) {
  if (!env.ETI_EXECUTION_LOG) return false;
  const rec = toDecisionRecord(r, executed), inv = String(9_999_999_999_999 - Date.parse(rec.at)).padStart(13, "0");
  await env.ETI_EXECUTION_LOG.put(`agentrun:${inv}:${rec.id}`, JSON.stringify(rec), { expirationTtl: TTL });
  return true;
}

export function withAgents<E extends AgentsEnv>(base: App<E>, deps: AgentsDeps = {}): App<E> {
  const load = deps.loadMarket ?? loadMarket, clock = deps.now ?? Date.now;
  return {
    async fetch(request, env) {
      const url = new URL(request.url), path = url.pathname;
      if (!path.startsWith("/api/agents")) return base.fetch(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" } });
      const integrity = integrityFromEnv(env);

      if (path === "/api/agents") {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        const audit = env.ETI_EXECUTION_LOG ? JSON.parse((await env.ETI_EXECUTION_LOG.get("agentaudit:summary")) || "null") as AuditSummary | null : null;
        return reply({ schema: "eti.agents.roster/1", agents: AGENT_ROSTER, endpoints: ["GET|POST /api/agents/analyze", "POST /api/agents/execute (bearer)", "GET /api/agents/audit (bearer)"], integrity, liveExecutionAllowed: false, riskVeto: "binding", auditSummary: audit });
      }

      const symbolOf = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "BTCUSDT");
      const intervalOf = (v: unknown) => (typeof v === "string" && v ? v : "1h");

      if (path === "/api/agents/audit") {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        if (!(await bearerOk(request, env))) return reply({ error: "unauthorized" }, 401);
        if (!env.ETI_EXECUTION_LOG) return reply({ error: "audit_log_not_configured" }, 503);
        const listed = await env.ETI_EXECUTION_LOG.list({ prefix: "agentrun:", limit: 50 });
        const recs = (await Promise.all(listed.keys.map(async (k) => JSON.parse((await env.ETI_EXECUTION_LOG!.get(k.name)) || "null") as DecisionRecord | null))).filter((x): x is DecisionRecord => !!x);
        const pairs = [...new Set(recs.filter((r) => r.action !== "NO_TRADE").map((r) => r.symbol + "|" + r.interval))].slice(0, 5), series = new Map<string, MarketInput["candles"]>(), failures: string[] = [];
        await Promise.all(pairs.map(async (p) => { const [symbol, interval] = p.split("|"); try { series.set(p, (await getMarketData("klines", { symbol, interval, limit: 1000 }, providerOrder(env))).data as MarketInput["candles"]); } catch { failures.push(p); } }));
        const outcomes = recs.map((r) => evaluateDecision(r, series.get(r.symbol + "|" + r.interval) ?? []));
        const summary = auditSummary(recs, outcomes, clock());
        if (failures.length) summary.notes.push("Candle history unavailable for: " + failures.join(", "));
        await env.ETI_EXECUTION_LOG.put("agentaudit:summary", JSON.stringify(summary), { expirationTtl: 60 * 60 * 24 * 7 });
        return reply({ summary, outcomes });
      }

      if (path !== "/api/agents/analyze" && path !== "/api/agents/execute") return reply({ error: "not_found" }, 404);
      const isExec = path === "/api/agents/execute";
      if (isExec && request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (!isExec && request.method !== "GET" && request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

      let body: Record<string, unknown> = {};
      const authed = (isExec || request.method === "POST") ? await bearerOk(request, env) : false;
      if (isExec && !authed) return reply({ error: "unauthorized" }, 401);
      if (isExec && integrity.killSwitch) return reply({ error: "execution_disabled", reason: "Emergency kill switch is active" }, 423);
      if (request.method === "POST") {
        try { const b = await readBody(request); if (!b) return reply({ error: "invalid_json" }, 400); body = b; }
        catch (e) { return reply({ error: e instanceof Error && e.message === "body_too_large" ? "body_too_large" : "invalid_json" }, e instanceof Error && e.message === "body_too_large" ? 413 : 400); }
      }
      const symbol = symbolOf(request.method === "GET" ? url.searchParams.get("symbol") : body.symbol);
      const interval = intervalOf(request.method === "GET" ? url.searchParams.get("interval") : body.interval);
      const benchRaw = request.method === "GET" ? url.searchParams.get("benchmark") : body.benchmark;
      const benchmark = typeof benchRaw === "string" && benchRaw ? benchRaw.toUpperCase() : null;
      if (!SYMBOL.test(symbol) || (benchmark && !SYMBOL.test(benchmark))) return reply({ error: "invalid_symbol" }, 400);
      if (!INTERVALS.includes(interval)) return reply({ error: "invalid_interval", intervals: INTERVALS }, 400);
      const provider = request.method === "GET" ? url.searchParams.get("provider") : typeof body.provider === "string" ? body.provider : null;

      let market: MarketInput;
      try { market = await load(env, symbol, interval, { provider, benchmark }); }
      catch (e) {
        return reply({ error: "market_data_unavailable", decision: "DATA_UNRELIABLE", detail: e instanceof AllProvidersFailed ? e.attempts.map((a) => `${a.provider}:${a.errorClass}`) : "loader_error", submitsOrder: false }, 503);
      }
      let audit: AuditSummary | null = null;
      try { if (env.ETI_EXECUTION_LOG) audit = JSON.parse((await env.ETI_EXECUTION_LOG.get("agentaudit:summary")) || "null"); } catch { audit = null; }
      const exReq = (body.execution && typeof body.execution === "object" ? body.execution : {}) as ExecutionRequest;
      const maxQty = Number(env.ETI_MAX_ORDER_QUANTITY ?? "100");
      const result = analyze({ market, supplied: supplied(body), account: parseAccount(body.account), integrity, audit, execution: isExec ? exReq : undefined, maxOrderQuantity: Number.isFinite(maxQty) && maxQty > 0 ? maxQty : undefined, now: clock() });

      if (!isExec) {
        const recorded = authed && body.record === true ? await record(env, result, false).catch(() => false) : false;
        return reply({ ...result, recorded });
      }

      // Execution path: the Risk Manager's veto is structural: no ticket exists unless risk.approved.
      const blocked = !result.decision.executionEligible || !result.execution.eligible || !result.execution.ticket;
      if (blocked) {
        await record(env, result, false).catch(() => false);
        return reply({ error: "blocked_by_agents", vetoedBy: result.decision.vetoedBy, action: result.decision.action, reasons: result.decision.vetoedBy ? result.risk?.vetoes ?? [] : result.execution.blockers.length ? result.execution.blockers : result.decision.rationale, decision: result.decision, execution: result.execution, risk: result.risk }, 409);
      }
      const order = new Request(new URL("/api/orders", request.url).toString(), { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.get("authorization") ?? "" }, body: JSON.stringify(result.execution.ticket) });
      const res = await handleExecution(order, env);
      const brokerBody = await res.json().catch(() => ({}));
      await record(env, result, res.status === 201).catch(() => false);
      return reply({ ok: res.status === 201, status: res.status, broker: brokerBody, decision: result.decision, risk: result.risk, ticket: result.execution.ticket }, res.status);
    },
  };
}

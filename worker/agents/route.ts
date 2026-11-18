/**
 * HTTP surface for the multi-agent system (wrapped around the existing application by worker/main.ts):
 *   GET  /agents                      Agent Intelligence Center dashboard
 *   GET  /api/agents                  roster, integration status, latest audit summary
 *   GET  /api/agents/providers        live health check of the research data providers
 *   GET|POST /api/agents/analyze      read-only analysis (providers auto-fetched unless providers=0 / providers:false)
 *   POST /api/agents/execute          bearer-authenticated; reaches /api/orders only if Commander AND Risk Manager approve and exchange filters pass
 *   GET  /api/agents/audit            bearer-authenticated; Performance Auditor over recorded decisions
 *   POST /api/agents/brief            bearer-authenticated; advisory LLM review of an analysis (see llm-route.ts)
 */
import { AllProvidersFailed, INTERVALS, getMarketData, providerOrder } from "../market.ts";
import { buildOrderFlow, normalizeDepth, normalizeTrades } from "../analysis/orderflow.ts";
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
import { fetchProviderData } from "./providers.ts";
import type { ProviderEnv, ProviderStatus } from "./providers.ts";
import { loadBinanceTestnetAccount } from "./account.ts";
import { applyFilters, loadBinanceFilters } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";
import { withLlmBrief } from "./llm-route.ts";
import { readAutopilotConfig } from "./autopilot.ts";
import { listAgentDecisions, persistAgentDecision } from "./persistence.ts";
import type { AgentAuditDb, AgentDecisionSnapshot } from "./persistence.ts";

export type AgentsEnv = MarketEnv & ExecutionEnv & ProviderEnv & { ETI_PORTFOLIO_DB?: AgentAuditDb; ETI_AGENT_AUTOPILOT_ENABLED?: string; ETI_AGENT_AUTOPILOT_SYMBOLS?: string; ETI_AGENT_AUTOPILOT_INTERVAL?: string; ETI_AGENT_AUTOPILOT_MIN_CONFIDENCE?: string; ETI_AGENT_AUTOPILOT_MIN_AGREEMENT?: string; ETI_AGENT_AUTOPILOT_MAX_POSITIONS?: string; ETI_AGENT_AUTOPILOT_CONFIG?: string };
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
export type MarketLoader = (env: AgentsEnv, symbol: string, interval: string, opts: { provider?: string | null; benchmark?: string | null }) => Promise<MarketInput>;
export type ProviderLoader = (env: AgentsEnv, symbol: string, now: number) => Promise<{ supplied: SuppliedData; status: ProviderStatus[] }>;
export type AccountLoader = (env: AgentsEnv, symbol: string, lastPrice: number) => Promise<{ account?: AccountState; error?: string }>;
export type FilterLoader = (symbol: string) => Promise<SymbolFilters | null>;
export interface AgentsDeps { loadMarket?: MarketLoader; loadProviders?: ProviderLoader; loadAccount?: AccountLoader; loadFilters?: FilterLoader; now?: () => number }

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const SYMBOL = /^[A-Z0-9]{5,20}$/, MAX_BODY = 200_000, TTL = 60 * 60 * 24 * 90;

export function integrityFromEnv(env: ExecutionEnv): Integrity {
  return {
    killSwitch: env.ETI_KILL_SWITCH === "true", liveFlagSet: env.ETI_LIVE_TRADING_ENABLED === "true",
    executionTokenConfigured: !!env.ETI_EXECUTION_TOKEN, auditLogConfigured: !!env.ETI_EXECUTION_LOG,
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
  const tP = getMarketData("trades", { symbol, interval, limit: 100 }, order).catch((e) => { failures.trades = name(e); return null; });
  const bP = opts.benchmark ? getMarketData("klines", { symbol: opts.benchmark, interval, limit: 300 }, order).catch((e) => { failures.benchmark = name(e); return null; }) : Promise.resolve(null);
  const [k, d, t, b] = await Promise.all([kP, dP, tP, bP]);
  let crossCheck: MarketInput["crossCheck"] = null;
  const other = order.find((p) => p !== k.provider);
  if (other) {
    try { const t = await getMarketData("ticker", { symbol, interval, limit: 1 }, [other]); crossCheck = { provider: t.provider, price: (t.data as Ticker).lastPrice }; }
    catch (e) { failures.cross_check = name(e); }
  }
  let orderFlow: MarketInput["orderFlow"] = null;
  if (t && d && t.provider === k.provider && d.provider === k.provider) {
    try {
      const trades = normalizeTrades(t.data), depth = normalizeDepth(d.data);
      if (trades && depth) {
        const analysis = buildOrderFlow({ symbol, venue: k.provider.startsWith("bitget") ? "bitget" : "bybit", market: "spot", provider: k.provider, trades, depth, candles: k.data as MarketInput["candles"], now: Date.now() });
        orderFlow = { provider: analysis.provider, generatedAt: analysis.generatedAt, tape: analysis.tape, depth: { spreadBps: analysis.depth.spreadBps, imbalance: analysis.depth.imbalance, microprice: analysis.depth.microprice, bidNotional: analysis.depth.bidNotional, askNotional: analysis.depth.askNotional }, dataQuality: { tradeAgeMs: analysis.dataQuality.tradeAgeMs, tradeCount: analysis.dataQuality.tradeCount, notes: analysis.dataQuality.notes } };
      } else failures.orderflow = "trade_or_depth_validation_failed";
    } catch (e) { failures.orderflow = name(e); }
  } else if (!t) failures.orderflow = "trade_tape_unavailable";
  else if (!d) failures.orderflow = "depth_unavailable";
  else if (t.provider !== k.provider || d.provider !== k.provider) failures.orderflow = "venue_source_mismatch";
  return { symbol, interval, candles: k.data as MarketInput["candles"], depth: d ? (d.data as MarketInput["depth"]) : null, orderFlow, provider: k.provider, fetchedAt: Date.now(), crossCheck, benchmark: b && opts.benchmark ? { symbol: opts.benchmark, candles: b.data as MarketInput["candles"] } : null, failures };
};

function parseAccount(v: unknown): AccountState | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>, out: AccountState = {};
  for (const k of ["equityUsd", "availableUsd", "positionQuantity", "dailyPnlPct", "drawdownPct", "openRiskPct"] as const) { const n = finite(o[k]); if (n !== undefined) out[k] = n; }
  return out;
}
const supplied = (b: Record<string, unknown>): SuppliedData => ({ fundamentals: b.fundamentals, macro: b.macro, news: b.news, onchain: b.onchain, orderFlow: b.orderFlow });
/** Caller-supplied data always wins over provider data, key by key. */
export function mergeSupplied(provider: SuppliedData, caller: SuppliedData): SuppliedData {
  const out: SuppliedData = {};
  for (const k of ["fundamentals", "macro", "news", "onchain", "orderFlow"] as const) { const v = caller[k] !== undefined && caller[k] !== null ? caller[k] : provider[k]; if (v !== undefined) out[k] = v; }
  return out;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("body_too_large");
  if (!text.trim()) return {};
  const j = JSON.parse(text);
  return j && typeof j === "object" && !Array.isArray(j) ? j : null;
}

async function record(env: AgentsEnv, r: AnalysisResult, executed: boolean): Promise<"d1" | "kv_fallback" | "none"> {
  if (env.ETI_PORTFOLIO_DB) {
    try {
      await persistAgentDecision(env.ETI_PORTFOLIO_DB, r as unknown as AgentDecisionSnapshot, executed);
      return "d1";
    } catch { /* Fall through to the existing compact KV audit sink. */ }
  }
  if (env.ETI_EXECUTION_LOG) {
    try {
      const rec = toDecisionRecord(r, executed), inv = String(9_999_999_999_999 - Date.parse(rec.at)).padStart(13, "0");
      await env.ETI_EXECUTION_LOG.put(`agentrun:${inv}:${rec.id}`, JSON.stringify(rec), { expirationTtl: TTL });
      return "kv_fallback";
    } catch { /* Report persistence unavailable; never claim a failed write succeeded. */ }
  }
  return "none";
}

function withAgentsCore<E extends AgentsEnv>(base: App<E>, deps: AgentsDeps = {}): App<E> {
  const load = deps.loadMarket ?? loadMarket, clock = deps.now ?? Date.now;
  const loadProv: ProviderLoader = deps.loadProviders ?? ((env, symbol, now) => fetchProviderData(env, symbol, now));
  const loadAcct: AccountLoader = deps.loadAccount ?? ((env, symbol, price) => loadBinanceTestnetAccount(env, symbol, price));
  const loadFilt: FilterLoader = deps.loadFilters ?? loadBinanceFilters;
  return {
    async fetch(request, env) {
      const url = new URL(request.url), path = url.pathname;
      if ((path === "/agents" || path === "/agents/") && request.method === "GET")
        return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
      if (!path.startsWith("/api/agents")) return base.fetch(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" } });
      const integrity = integrityFromEnv(env);
      const stored = async (): Promise<AuditSummary | null> => { try { return env.ETI_EXECUTION_LOG ? JSON.parse((await env.ETI_EXECUTION_LOG.get("agentaudit:summary")) || "null") : null; } catch { return null; } };

      if (path === "/api/agents/autopilot") {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        let latest: unknown = null;
        try { latest = env.ETI_EXECUTION_LOG ? JSON.parse((await env.ETI_EXECUTION_LOG.get("agent-autopilot:last")) || "null") : null; } catch { latest = null; }
        const config = readAutopilotConfig(env);
        const enabled = env.ETI_AGENT_AUTOPILOT_ENABLED === "true";
        const symbols = config.symbols.split(",").map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL.test(s));
        const strategies = config.strategies.split(",").map((s) => s.trim().toLowerCase()).filter((s) => ["scalp", "intraday", "swing", "position"].includes(s));
        const portfolioStorageConfigured = !!(env.ETI_PORTFOLIO_DB || env.ETI_EXECUTION_LOG);
        const blockedReasons = [
          ...(!enabled ? ["autopilot_disabled"] : []),
          ...(integrity.killSwitch ? ["kill_switch_active"] : []),
          ...(!integrity.executionTokenConfigured ? ["execution_token_missing"] : []),
          ...(!integrity.auditLogConfigured ? ["execution_audit_log_missing"] : []),
          ...(!portfolioStorageConfigured ? ["paper_portfolio_storage_missing"] : []),
          ...(!symbols.length ? ["no_valid_symbols"] : []),
          ...(!INTERVALS.includes(config.interval) ? ["invalid_interval"] : []),
          ...(!strategies.length || config.minStrategyAgreement > strategies.length ? ["invalid_strategy_configuration"] : []),
        ];
        return reply({
          enabled, ready: blockedReasons.length === 0, blockedReasons,
          mode: "internal_paper_only", liveOrdersAllowed: false, killSwitch: integrity.killSwitch,
          scheduler: { enabled, cron: "*/5 * * * *", cadenceMinutes: 5 },
          executionTokenConfigured: integrity.executionTokenConfigured, auditLogConfigured: integrity.auditLogConfigured,
          durableAuditConfigured: !!env.ETI_PORTFOLIO_DB, portfolioStorageConfigured,
          councilRunsBeforeStrategyGates: true, recordsNoTradeDecisions: true,
          symbols, interval: config.interval, maxPerCycle: config.maxPerCycle,
          minConfidence: config.minConfidence, minAgreement: config.minAgreement,
          maxPositions: config.maxPositions, strategies,
          minStrategyAgreement: config.minStrategyAgreement, minOmniConfidence: config.minOmniConfidence, latest,
        });
      }

      if (path === "/api/agents") {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        return reply({ schema: "eti.agents.roster/1", agents: AGENT_ROSTER, endpoints: ["GET /agents (dashboard)", "GET|POST /api/agents/analyze", "GET /api/agents/providers", "GET /api/agents/decisions (bearer, durable D1 audit)", "POST /api/agents/execute (bearer)", "GET /api/agents/audit (bearer)", "POST /api/agents/brief (bearer, advisory LLM review)"], integrity, durableAuditConfigured: !!env.ETI_PORTFOLIO_DB, fredConfigured: !!env.FRED_API_KEY, llmConfigured: !!(env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY, liveExecutionAllowed: false, riskVeto: "binding", auditSummary: await stored() });
      }

      const symbolOf = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "BTCUSDT");
      const intervalOf = (v: unknown) => (typeof v === "string" && v ? v : "1h");

      if (path === "/api/agents/providers") {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        const symbol = symbolOf(url.searchParams.get("symbol"));
        if (!SYMBOL.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
        try { const p = await loadProv(env, symbol, clock()); return reply({ symbol, providers: p.status, provided: Object.keys(p.supplied) }); }
        catch { return reply({ error: "provider_check_failed" }, 502); }
      }

      if (path === "/api/agents/decisions") {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        if (!(await bearerOk(request, env))) return reply({ error: "unauthorized" }, 401);
        if (!env.ETI_PORTFOLIO_DB) return reply({ error: "durable_audit_not_configured", fallback: !!env.ETI_EXECUTION_LOG }, 503);
        const rawLimit = Number(url.searchParams.get("limit") ?? 25);
        const rawBefore = url.searchParams.get("before");
        const before = rawBefore === null ? undefined : Number(rawBefore);
        const beforeId = url.searchParams.get("beforeId") ?? undefined;
        const symbol = url.searchParams.get("symbol")?.toUpperCase();
        if (!Number.isFinite(rawLimit) || (before !== undefined && (!Number.isFinite(before) || before <= 0)) || (beforeId !== undefined && (!beforeId || beforeId.length > 128 || before === undefined))) return reply({ error: "invalid_pagination" }, 400);
        if (symbol && !SYMBOL.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
        try {
          const page = await listAgentDecisions(env.ETI_PORTFOLIO_DB, { limit: rawLimit, before, beforeId, symbol });
          return reply({ schema: "eti.agent.audit.page/1", ...page, durable: true });
        } catch {
          return reply({ error: "durable_audit_unavailable", durable: false }, 503);
        }
      }

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
        catch (e) { const big = e instanceof Error && e.message === "body_too_large"; return reply({ error: big ? "body_too_large" : "invalid_json" }, big ? 413 : 400); }
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
      const lastPrice = market.candles[market.candles.length - 1][4];
      const wantProviders = request.method === "GET" ? url.searchParams.get("providers") !== "0" : body.providers !== false;
      let pSup: SuppliedData = {}, pStatus: ProviderStatus[] = [];
      if (wantProviders) {
        try { const p = await loadProv(env, symbol, clock()); pSup = p.supplied; pStatus = p.status; }
        catch { pStatus = [{ provider: "providers", ok: false, latencyMs: 0, fetchedAt: new Date(clock()).toISOString(), detail: "loader_error" }]; }
      }
      const exReq = (body.execution && typeof body.execution === "object" ? body.execution : {}) as ExecutionRequest;
      let account = parseAccount(body.account), accountNote: string | undefined;
      if (isExec && exReq.broker === "binance" && env.BINANCE_API_KEY && env.BINANCE_SECRET_KEY && symbol.endsWith("USDT")) {
        const f = await loadAcct(env, symbol, lastPrice);
        account = { ...(f.account ?? {}), ...(account ?? {}) }; accountNote = f.error;
      }
      const audit = await stored(), maxQty = Number(env.ETI_MAX_ORDER_QUANTITY ?? "100");
      const result = analyze({ market, supplied: mergeSupplied(pSup, supplied(body)), account, integrity, audit, execution: isExec ? exReq : undefined, maxOrderQuantity: Number.isFinite(maxQty) && maxQty > 0 ? maxQty : undefined, now: clock() });

      if (!isExec) {
        // D1 writes are opt-in and bearer-authenticated to prevent public analysis requests from exhausting storage.
        const requested = request.method === "POST" && authed && body.record === true;
        const persistence = requested ? await record(env, result, false).catch(() => "none" as const) : "none";
        return reply({ ...result, providers: pStatus, recorded: persistence !== "none", auditPersistence: requested ? persistence : "not_requested" });
      }

      // Execution path: the Risk Manager's veto is structural: no ticket exists unless risk.approved.
      const block = async (reasons: string[]) => {
        const auditPersistence = await record(env, result, false).catch(() => "none" as const);
        return reply({ error: "blocked_by_agents", auditPersistence, vetoedBy: result.decision.vetoedBy, action: result.decision.action, reasons, accountNote, decision: result.decision, execution: result.execution, risk: result.risk }, 409);
      };
      if (!result.decision.executionEligible || !result.execution.eligible || !result.execution.ticket)
        return block(result.decision.vetoedBy ? result.risk?.vetoes ?? [] : result.execution.blockers.length ? result.execution.blockers : result.decision.rationale);
      let ticket = result.execution.ticket; const adjustments: string[] = [];
      if (ticket.broker === "binance") {
        const f = await loadFilt(ticket.symbol).catch(() => null);
        if (!f) return block(["exchange_filters_unavailable"]);
        const a = applyFilters(ticket, f);
        if (!a.ok) return block([a.reason]);
        ticket = { ...ticket, quantity: a.quantity, limitPrice: a.limitPrice }; adjustments.push(...a.adjustments);
      } else if (ticket.broker === "alpaca") adjustments.push("Alpaca order filters are not checked by the agent system.");
      else adjustments.push("ETI internal paper uses the portfolio ledger and its own cash/position checks; no exchange is contacted.");
      const order = new Request(new URL("/api/orders", request.url).toString(), { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.get("authorization") ?? "" }, body: JSON.stringify(ticket) });
      const res = await handleExecution(order, env);
      const brokerBody = await res.json().catch(() => ({}));
      const auditPersistence = await record(env, result, res.status === 201).catch(() => "none" as const);
      return reply({ ok: res.status === 201, auditPersistence, status: res.status, broker: brokerBody, decision: result.decision, risk: result.risk, ticket, adjustments, accountNote }, res.status);
    },
  };
}

/** Public entry point. The advisory LLM review route sits in front of the agent routes; everything else is handled by the core above. */
export function withAgents<E extends AgentsEnv>(base: App<E>, deps: AgentsDeps = {}): App<E> {
  return withLlmBrief(withAgentsCore(base, deps) as App<any>, { loadMarket: deps.loadMarket, loadProviders: deps.loadProviders, now: deps.now }) as App<E>;
}

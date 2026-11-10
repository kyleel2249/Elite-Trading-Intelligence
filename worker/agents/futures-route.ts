/**
 * Futures agent routes (bearer-authenticated: they read the futures account):
 *   GET  /agents/futures                    read-only Futures Control page
 *   GET|POST /api/agents/futures/analyze    Commander analysis + FuturesPlan preview
 *   POST     /api/agents/futures/execute    forwards a plan's ticket to /api/futures/orders only if the plan is eligible
 *   GET  /api/futures/monitor               last protective-stop monitor result
 *   POST /api/futures/monitor/run           run the monitor now
 *   /api/futures/*                          gateway (see worker/futures.ts)
 */
import { AllProvidersFailed, INTERVALS, INTERVAL_SECONDS } from "../market.ts";
import type { MarketInput, SuppliedData } from "./types.ts";
import { analyze } from "./orchestrator.ts";
import { integrityFromEnv, loadMarket, mergeSupplied } from "./route.ts";
import type { AgentsEnv, MarketLoader, ProviderLoader } from "./route.ts";
import { fetchProviderData } from "./providers.ts";
import type { ProviderStatus } from "./providers.ts";
import { applyFilters } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import { planFutures } from "./futures-plan.ts";
import { FUTURES_BASE, HARD_MAX_LEVERAGE, handleFutures, loadFuturesState } from "../futures.ts";
import type { FuturesEnv, FuturesState } from "../futures.ts";
import { runFuturesMonitor } from "../futures-monitor.ts";
import { FUTURES_PAGE_HTML } from "./futures-dashboard.ts";

export type FuturesAgentsEnv = AgentsEnv & FuturesEnv;
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
export interface FuturesAgentsDeps { loadMarket?: MarketLoader; loadProviders?: ProviderLoader; loadState?: (env: FuturesAgentsEnv, symbol: string) => Promise<FuturesState | null>; loadFilters?: (symbol: string) => Promise<SymbolFilters | null>; now?: () => number }

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: HEADERS });

async function bearerOk(req: Request, env: FuturesEnv): Promise<boolean> {
  const token = env.ETI_EXECUTION_TOKEN, supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** USD-M futures filters: LOT_SIZE, PRICE_FILTER and MIN_NOTIONAL (whose field is `notional`, not `minNotional`). */
export function parseFuturesFilters(info: any, symbol: string): SymbolFilters | null {
  const s = Array.isArray(info?.symbols) ? info.symbols.find((x: any) => x.symbol === symbol) : null;
  if (!s || !Array.isArray(s.filters)) return null;
  const f: SymbolFilters = {};
  for (const x of s.filters) {
    if (x.filterType === "LOT_SIZE") { f.stepSize = Number(x.stepSize); f.minQty = Number(x.minQty); f.maxQty = Number(x.maxQty); }
    else if (x.filterType === "PRICE_FILTER") { f.tickSize = Number(x.tickSize); f.minPrice = Number(x.minPrice); f.maxPrice = Number(x.maxPrice); }
    else if (x.filterType === "MIN_NOTIONAL") f.minNotional = Number(x.notional ?? x.minNotional);
  }
  return f.stepSize || f.tickSize || f.minNotional ? f : null;
}
export async function loadFuturesFilters(symbol: string): Promise<SymbolFilters | null> {
  try { const r = await fetch(FUTURES_BASE + "/fapi/v1/exchangeInfo", { signal: AbortSignal.timeout(8000) }); return r.ok ? parseFuturesFilters(await r.json(), symbol) : null; } catch { return null; }
}

export function withFutures<E extends FuturesAgentsEnv>(base: App<E>, deps: FuturesAgentsDeps = {}): App<E> {
  const load = deps.loadMarket ?? loadMarket, clock = deps.now ?? Date.now, loadState = deps.loadState ?? loadFuturesState, loadFilt = deps.loadFilters ?? loadFuturesFilters;
  const loadProv: ProviderLoader = deps.loadProviders ?? ((env, symbol, now) => fetchProviderData(env, symbol, now));
  return {
    async fetch(request, env) {
      const url = new URL(request.url), path = url.pathname;
      if ((path === "/agents/futures" || path === "/agents/futures/") && request.method === "GET")
        return new Response(FUTURES_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
      if (path === "/api/futures/monitor" || path === "/api/futures/monitor/run") {
        const run = path.endsWith("/run");
        if (request.method !== (run ? "POST" : "GET")) return reply({ error: "method_not_allowed" }, 405);
        if (!(await bearerOk(request, env))) return reply({ error: "unauthorized" }, 401);
        if (run) return reply(await runFuturesMonitor(env, clock()));
        const last = env.ETI_EXECUTION_LOG ? await env.ETI_EXECUTION_LOG.get("futures:monitor") : null;
        return last ? reply(JSON.parse(last)) : reply({ error: "monitor_has_not_run" }, 404);
      }
      if (path.startsWith("/api/futures")) return handleFutures(request, env);
      if (path !== "/api/agents/futures/analyze" && path !== "/api/agents/futures/execute") return base.fetch(request, env);
      const isExec = path.endsWith("/execute");
      if (isExec ? request.method !== "POST" : request.method !== "GET" && request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (!(await bearerOk(request, env))) return reply({ error: "unauthorized" }, 401);
      let body: Record<string, unknown> = {};
      if (request.method === "POST") { try { const t = await request.text(); if (t.length > 200_000) return reply({ error: "body_too_large" }, 413); body = t.trim() ? JSON.parse(t) : {}; } catch { return reply({ error: "invalid_json" }, 400); } }
      const get = (k: string) => (request.method === "GET" ? url.searchParams.get(k) : body[k]);
      const symbol = typeof get("symbol") === "string" ? (get("symbol") as string).toUpperCase() : "BTCUSDT", interval = typeof get("interval") === "string" && get("interval") ? (get("interval") as string) : "1h";
      if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
      if (!INTERVALS.includes(interval)) return reply({ error: "invalid_interval", intervals: INTERVALS }, 400);
      let market: MarketInput;
      try { market = await load(env, symbol, interval, { provider: null, benchmark: null }); }
      catch (e) { return reply({ error: "market_data_unavailable", detail: e instanceof AllProvidersFailed ? e.attempts.map((a) => `${a.provider}:${a.errorClass}`) : "loader_error", submitsOrder: false }, 503); }
      const st = await loadState(env, symbol).catch(() => null);
      let pSup: SuppliedData = {}, pStat: ProviderStatus[] = [];
      if (get("providers") !== false && get("providers") !== "0") { try { const p = await loadProv(env, symbol, clock()); pSup = p.supplied; pStat = p.status; } catch { pStat = [{ provider: "providers", ok: false, latencyMs: 0, fetchedAt: new Date(clock()).toISOString(), detail: "loader_error" }]; } }
      const supplied: SuppliedData = mergeSupplied(pSup, { fundamentals: body.fundamentals, macro: body.macro, news: body.news, onchain: body.onchain });
      const integrity = integrityFromEnv(env), now = clock();
      const analysis = analyze({ market, supplied, account: st ? { equityUsd: st.walletBalance, availableUsd: st.availableBalance, positionQuantity: Math.abs(st.positionAmt) } : undefined, integrity, now });
      const lev = Math.min(Number(env.ETI_FUTURES_MAX_LEVERAGE ?? "3"), HARD_MAX_LEVERAGE), notional = Number(env.ETI_FUTURES_MAX_NOTIONAL_USD ?? "");
      const caps = Number.isFinite(lev) && lev >= 1 && Number.isFinite(notional) && notional > 0 ? { maxLeverage: Math.floor(lev), maxNotionalUsd: notional } : null;
      const ex = (body.execution && typeof body.execution === "object" ? body.execution : {}) as Record<string, any>;
      const age = now - market.candles[market.candles.length - 1][0];
      const plan = planFutures({ analysis, state: st, caps, marketFresh: age <= 2.5 * (INTERVAL_SECONDS[interval] ?? 3600) * 1000, flags: { enabled: env.ETI_FUTURES_ENABLED === "true", killSwitch: integrity.killSwitch }, request: { clientOrderId: ex.clientOrderId, riskConfirmed: ex.riskConfirmed, executionSource: ex.executionSource } });
      if (!isExec) return reply({ analysis, futuresPlan: plan, providers: pStat });
      if (!plan.eligible || !plan.ticket) return reply({ error: "blocked_by_agents", action: plan.action, reasons: plan.blockers, futuresPlan: plan, decision: analysis.decision }, 409);
      const f = await loadFilt(symbol).catch(() => null);
      if (!f) return reply({ error: "blocked_by_agents", reasons: ["exchange_filters_unavailable"], futuresPlan: plan }, 409);
      const a = applyFilters({ side: plan.ticket.side, quantity: plan.ticket.quantity, limitPrice: plan.ticket.limitPrice }, f);
      if (!a.ok) return reply({ error: "blocked_by_agents", reasons: [a.reason], futuresPlan: plan }, 409);
      const ticket = { ...plan.ticket, quantity: a.quantity, limitPrice: a.limitPrice };
      const res = await handleFutures(new Request(new URL("/api/futures/orders", request.url).toString(), { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.get("authorization") ?? "" }, body: JSON.stringify(ticket) }), env);
      return reply({ ok: res.status === 201, status: res.status, gateway: await res.json().catch(() => ({})), action: plan.action, ticket, adjustments: a.adjustments, futuresPlan: plan, decision: analysis.decision }, res.status);
    },
  };
}

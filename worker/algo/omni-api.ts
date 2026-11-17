// GET /api/omnisignal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz
// Analytical and read-only. It never submits orders; execution stays behind the existing /api/orders routes and their in-process paper safeguards.
import type { MarketEnv } from "../market.ts";
import type { Strategy } from "./timeframes.ts";
import { expectancyFor, expectancyOptions, expectancyStatus } from "./expectancy.ts";
import { journalFromRoute } from "./journal.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { costBpsFrom, runOmnisignal } from "./omnisignal.ts";
import { activeOptions } from "./params.ts";
import { MAX_SCAN_SYMBOLS, parseSymbols, scan } from "./scan.ts";
import { authorized } from "../execution.ts";
import { leaderboardOf, loadUniverse, runUniverseBatch } from "./universe.ts";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
export const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];

export async function handleOmnisignal(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/omnisignal/universe" || url.pathname === "/api/omnisignal/universe/refresh") {
    const kv = (env as any).ETI_EXECUTION_LOG; if (!kv) return reply({ error: "storage_not_configured", message: "Bind the ETI_EXECUTION_LOG KV namespace; universe results are stored there." }, 503);
    const now = Date.now();
    if (url.pathname.endsWith("/refresh")) {
      if (req.method !== "POST") return reply({ error: "method_not_allowed", allowed: "POST" }, 405);
      if (!(await authorized(req, env as any))) return reply({ error: "unauthorized", message: "Refreshing spends market-data requests and needs the execution token." }, 401);
      const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy; if (!STRATEGIES.includes(strategy)) return reply({ error: "invalid_strategy", strategies: STRATEGIES }, 400);
      try { return reply({ ...(await runUniverseBatch(env as any, kv, now, strategy)), submitsOrder: false }); } catch (e) { return reply({ error: "universe_refresh_failed", message: e instanceof Error ? e.message : "error", submitsOrder: false }, 502); }
    }
    if (req.method !== "GET") return reply({ error: "method_not_allowed", allowed: "GET" }, 405);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 25)) || 25));
    const state = await loadUniverse(kv).catch(() => null), r = leaderboardOf(state, now, limit);
    return reply({ ...r, submitsOrder: false, liveExecutionAllowed: false, note: state ? "Ranked by evidence quality, not predicted profit. Only rows analysed within the staleness window are ranked; coverage shows how much of the universe is fresh. Scores are uncalibrated unless the calibration status says otherwise." : "No universe scan has run yet. Enable ETI_UNIVERSE_ENABLED=true for the scheduled scan, or POST /api/omnisignal/universe/refresh." });
  }
  if (url.pathname === "/api/omnisignal/scan") {
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy, { symbols, ignored } = parseSymbols(url.searchParams.get("symbols"));
    if (!STRATEGIES.includes(strategy) || !symbols.length) return reply({ error: "invalid_strategy_or_symbols", maxSymbols: MAX_SCAN_SYMBOLS, strategies: STRATEGIES }, 400);
    let leaderboard; try { leaderboard = await scan(env, symbols, strategy); } catch { return reply({ error: "params_unavailable", submitsOrder: false }, 503); }
    return reply({ strategy, scanned: symbols, ignoredSymbols: ignored, maxSymbols: MAX_SCAN_SYMBOLS, leaderboard, submitsOrder: false, liveExecutionAllowed: false,
      note: "Ranked by evidence quality (validator score, reward/risk, liquidity), not by predicted profit. Only BUY/SELL rows are ranked; HOLD and REJECTED are valid outcomes. Scores are uncalibrated and are not win probabilities." });
  }
  if (url.pathname !== "/api/omnisignal") return reply({ error: "not_found" }, 404);
  if (req.method !== "GET" && req.method !== "POST") return reply({ error: "method_not_allowed", note: "This endpoint is analytical and read-only; it cannot place orders." }, 405);
  const body: any = req.method === "POST" ? await req.json().catch(() => null) : {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "invalid_json_body" }, 400);
  const symbol = String(body.symbol ?? url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  const strategy = String(body.strategy ?? url.searchParams.get("strategy") ?? "intraday") as Strategy;
  const engines = String(body.engines ?? url.searchParams.get("engines") ?? "swift,gainz").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const venue = String(body.venue ?? url.searchParams.get("venue") ?? "bybit");
  const market = String(body.market ?? url.searchParams.get("market") ?? "spot");
  const category = String(body.category ?? url.searchParams.get("category") ?? (market === "futures" ? (venue === "bitget" ? "USDT-FUTURES" : "linear") : (venue === "bitget" ? "SPOT" : "spot")));
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !STRATEGIES.includes(strategy) || !engines.length || engines.some(e => e !== "swift" && e !== "gainz") ||
      !["bybit", "bitget"].includes(venue) || !["spot", "futures"].includes(market))
    return reply({ error: "invalid_symbol_strategy_engine_or_market", strategies: STRATEGIES, engines: ["swift", "gainz"], venues: ["bybit", "bitget"], markets: ["spot", "futures"] }, 400);
  if ((venue === "bybit" && market === "futures" && !["linear", "inverse"].includes(category)) ||
      (venue === "bitget" && market === "futures" && !["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"].includes(category)))
    return reply({ error: "invalid_market_category", venue, market, category }, 400);
  const equity = body.equity === undefined ? undefined : Number(body.equity);
  const riskFraction = body.riskFraction === undefined ? undefined : Number(body.riskFraction);
  const maxNotionalFraction = body.maxNotionalFraction === undefined ? undefined : Number(body.maxNotionalFraction);
  const leverage = body.leverage === undefined ? undefined : Number(body.leverage);
  const feeBps = body.feeBps === undefined ? undefined : Number(body.feeBps);
  const slippageBps = body.slippageBps === undefined ? undefined : Number(body.slippageBps);
  if ((equity === undefined) !== (riskFraction === undefined) ||
      (equity !== undefined && (!Number.isFinite(equity) || equity <= 0 || equity > 1e12)) ||
      (riskFraction !== undefined && (!Number.isFinite(riskFraction) || riskFraction <= 0 || riskFraction > 0.05)) ||
      (maxNotionalFraction !== undefined && (!Number.isFinite(maxNotionalFraction) || maxNotionalFraction <= 0 || maxNotionalFraction > 1)) ||
      (leverage !== undefined && (!Number.isFinite(leverage) || leverage < 1 || leverage > 100)) ||
      (feeBps !== undefined && (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 500)) ||
      (slippageBps !== undefined && (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 500)))
    return reply({ error: "invalid_trade_plan_inputs", message: "Supply equity and riskFraction together; riskFraction must be <= 5%, leverage 1-100x, and fee/slippage 0-500 bps." }, 400);
  let active; try { active = await activeOptions((env as any).ETI_EXECUTION_LOG); } catch { return reply({ error: "params_unavailable", submitsOrder: false }, 503); }
  const { version, name, ...opts } = active;
  const inputs = await loadSignalInputs(env, symbol, strategy, venue, Date.now(), market as "spot" | "futures", category);
  if ("error" in inputs) return reply({ decision: "DATA_UNRELIABLE", error: inputs.error, executionTimeframe: inputs.executionTimeframe, failures: inputs.failures, submitsOrder: false, liveExecutionAllowed: false }, 503);
  const { candles, depth, derivatives, provider, failures } = inputs;
  const now = Date.now(), exp = await expectancyFor(env, strategy, symbol, now);
  const planOptions = equity !== undefined && riskFraction !== undefined ? { equity, riskFraction, maxNotionalFraction, leverage, feeBps, slippageBps } : {};
  const result = runOmnisignal({ symbol, strategy, candles, depth, derivatives, now }, { ...opts, ...planOptions, roundTripCostBps: costBpsFrom(env as any), fvg: (env as any)?.ETI_FVG_CONFLUENCE !== "off", enabledEngines: { swift: engines.includes("swift"), gainz: engines.includes("gainz") }, ...expectancyOptions(exp) });
  const journal = await journalFromRoute(env, result, strategy, now, { status: exp.status, expectancyR: exp.expectancyR, samples: exp.samples });
  return reply({ ...result, parameters: { version, name }, dataQuality: { provider, venue, market, category, timeframesLoaded: Object.keys(candles), failures, orderBook: depth ? "rest_snapshot" : "unavailable", derivatives: derivatives ? "ticker_snapshot" : "unavailable", providerCrossCheck: "not_performed",
    note: "Single selected provider per request; cross-provider reconciliation is not performed. The REST order-book and derivatives snapshots are timestamped at fetch time." },
    validationStatus: { expectancy: expectancyStatus(exp), accountRisk: "not_evaluated_by_analytical_endpoint", execution: "This endpoint is analytical and read-only. It never submits orders; live execution remains disabled." }, journal });
}

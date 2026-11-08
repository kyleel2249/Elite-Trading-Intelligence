// GET /api/omnisignal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz
// Analytical and read-only. It never submits orders; execution stays behind the existing risk-gated /api/orders routes.
import { getMarketData, providerOrder, type Depth, type Kline, type MarketEnv } from "../market.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, type Strategy, type Timeframe } from "./timeframes.ts";
import { runOmnisignal } from "./omnisignal.ts";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
export const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];

export async function handleOmnisignal(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/omnisignal") return reply({ error: "not_found" }, 404);
  if (req.method !== "GET") return reply({ error: "method_not_allowed", note: "This endpoint is analytical and read-only; it cannot place orders." }, 405);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy;
  const engines = (url.searchParams.get("engines") || "swift,gainz").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !STRATEGIES.includes(strategy) || !engines.length || engines.some(e => e !== "swift" && e !== "gainz"))
    return reply({ error: "invalid_symbol_strategy_or_engines", strategies: STRATEGIES, engines: ["swift", "gainz"] }, 400);
  const order = providerOrder(env, url.searchParams.get("provider"));
  const need = TIMEFRAMES.filter(t => DEFAULT_WEIGHTS[strategy][t] > 0 || t === EXECUTION_TF[strategy]);
  const candles: Partial<Record<Timeframe, Kline[]>> = {}, failures: Record<string, string> = {};
  let provider = "unknown";
  await Promise.all(need.map(async tf => {
    try { const r = await getMarketData("klines", { symbol, interval: tf, limit: 300 }, order); candles[tf] = r.data as Kline[]; if (tf === EXECUTION_TF[strategy]) provider = r.provider; }
    catch (e) { failures[tf] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!candles[EXECUTION_TF[strategy]]) return reply({ decision: "DATA_UNRELIABLE", error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures, submitsOrder: false, liveExecutionAllowed: false }, 503);
  let depth: { bids: [number, number][]; asks: [number, number][]; timestamp: number } | null = null;
  try { const d = (await getMarketData("depth", { symbol, interval: "1m", limit: 100 }, order)).data as Depth; depth = { bids: d.bids, asks: d.asks, timestamp: Date.now() }; }
  catch (e) { failures.depth = e instanceof Error ? e.message : "unknown"; }
  const result = runOmnisignal({ symbol, strategy, candles, depth, now: Date.now() }, { enabledEngines: { swift: engines.includes("swift"), gainz: engines.includes("gainz") } });
  return reply({ ...result, dataQuality: { provider, timeframesLoaded: Object.keys(candles), failures, orderBook: depth ? "rest_snapshot" : "unavailable", providerCrossCheck: "not_performed",
    note: "Single validated provider per request; cross-provider reconciliation is not performed and the REST order-book snapshot is timestamped at fetch time." },
    validationStatus: { expectancy: "unmeasured_until_backtest_lab", accountRisk: "not_evaluated_by_analytical_endpoint", execution: "Orders require POST /api/orders and the server-side risk-gateway preflight; live trading remains disabled by default." } });
}

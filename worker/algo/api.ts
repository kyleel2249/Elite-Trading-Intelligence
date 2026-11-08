// GET /api/algo/signal?symbol=BTCUSDT&strategy=intraday : live ETI algorithmic intelligence signal (read-only, analytical).
import { getMarketData, providerOrder, type Depth, type Kline, type MarketEnv } from "../market.ts";
import { buildSignal } from "./signal.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, type Strategy, type Timeframe } from "./timeframes.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];

export async function handleAlgoSignal(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/algo/signal" || req.method !== "GET") return reply({ error: "not_found" }, 404);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy;
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !STRATEGIES.includes(strategy)) return reply({ error: "invalid_symbol_or_strategy", strategies: STRATEGIES }, 400);
  const order = providerOrder(env, url.searchParams.get("provider"));
  // Only fetch timeframes this strategy actually weights, plus its execution timeframe (keeps subrequests inside Workers limits).
  const need = TIMEFRAMES.filter(t => DEFAULT_WEIGHTS[strategy][t] > 0 || t === EXECUTION_TF[strategy]);
  const candles: Partial<Record<Timeframe, Kline[]>> = {};
  const failures: Record<string, string> = {};
  let provider = "unknown";
  await Promise.all(need.map(async tf => {
    try { const r = await getMarketData("klines", { symbol, interval: tf, limit: 300 }, order); candles[tf] = r.data as Kline[]; if (tf === EXECUTION_TF[strategy]) provider = r.provider; }
    catch (e) { failures[tf] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!candles[EXECUTION_TF[strategy]]) return reply({ error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures }, 503);
  let depth = null as null | { bids: [number, number][]; asks: [number, number][]; timestamp: number };
  try { const d = (await getMarketData("depth", { symbol, interval: "1m", limit: 100 }, order)).data as Depth; depth = { bids: d.bids, asks: d.asks, timestamp: Date.now() }; }
  catch (e) { failures.depth = e instanceof Error ? e.message : "unknown"; }
  const signal = buildSignal({ symbol, strategy, candles, depth, now: Date.now(), provider });
  return reply({ ...signal, dataQuality: { provider, timeframesLoaded: Object.keys(candles), failures, orderBook: depth ? "rest_snapshot" : "unavailable", providerCrossCheck: "not_performed",
    note: "Single validated provider per request; cross-provider reconciliation is not yet performed, and the REST order-book snapshot is timestamped at fetch time." },
    validationStatus: { expectancy: "unmeasured_until_backtest_lab", accountRisk: "not_evaluated_by_analytical_endpoint" } });
}

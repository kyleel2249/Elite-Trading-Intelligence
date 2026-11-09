// Shared market-data loading for analytical and paper endpoints (read-only public data).
import { getMarketData, providerOrder, type Depth, type Kline, type MarketEnv } from "../market.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, TF_SECONDS, type Strategy, type Timeframe } from "./timeframes.ts";

export type Candles = Partial<Record<Timeframe, Kline[]>>;
export interface SignalInputs { candles: Candles; depth: { bids: [number, number][]; asks: [number, number][]; timestamp: number } | null; provider: string; failures: Record<string, string> }
/** Only the timeframes the strategy weights plus its execution timeframe are fetched, keeping subrequests inside Workers limits. */
export async function loadSignalInputs(env: MarketEnv, symbol: string, strategy: Strategy, providerParam: string | null, now: number = Date.now()): Promise<SignalInputs | { error: "market_data_unavailable"; executionTimeframe: Timeframe; failures: Record<string, string> }> {
  const order = providerOrder(env, providerParam), exec = EXECUTION_TF[strategy];
  const need = TIMEFRAMES.filter(t => DEFAULT_WEIGHTS[strategy][t] > 0 || t === exec);
  const candles: Candles = {}, failures: Record<string, string> = {}; let provider = "unknown";
  await Promise.all(need.map(async tf => {
    try { const r = await getMarketData("klines", { symbol, interval: tf, limit: 300 }, order); candles[tf] = r.data as Kline[]; if (tf === exec) provider = r.provider; }
    catch (e) { failures[tf] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!candles[exec]) return { error: "market_data_unavailable", executionTimeframe: exec, failures };
  let depth: SignalInputs["depth"] = null;
  try { const d = (await getMarketData("depth", { symbol, interval: "1m", limit: 100 }, order)).data as Depth; depth = { bids: d.bids, asks: d.asks, timestamp: now }; }
  catch (e) { failures.depth = e instanceof Error ? e.message : "unknown"; }
  return { candles, depth, provider, failures };
}
/** Closed 1-minute bars (used for position management) and the latest fresh 1m close as a live reference price. */
export async function loadMinuteBars(env: MarketEnv, symbol: string, providerParam: string | null, now: number): Promise<{ bars: Kline[]; price: number | null; provider: string }> {
  const r = await getMarketData("klines", { symbol, interval: "1m", limit: 300 }, providerOrder(env, providerParam)), rows = r.data as Kline[], ms = TF_SECONDS["1m"] * 1000;
  const closed = rows.filter(k => k[0] + ms <= now), last = rows.at(-1);
  const fresh = last && now - last[0] <= 3 * ms && now - last[0] >= -60_000;
  return { bars: closed, price: fresh && last![4] > 0 ? last![4] : null, provider: r.provider };
}

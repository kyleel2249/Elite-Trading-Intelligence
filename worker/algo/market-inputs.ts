// Shared market-data loading for analytical and paper endpoints (read-only public data).
import { getMarketData, providerOrder, bitgetProductFor, type Depth, type Kline, type MarketEnv, type Ticker, type ProviderId } from "../market.ts";
import type { DerivativesSnapshot } from "./derivatives.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, TF_SECONDS, type Strategy, type Timeframe } from "./timeframes.ts";

export type Candles = Partial<Record<Timeframe, Kline[]>>;
export type SignalMarket = "spot" | "futures";
export interface SignalInputs {
  candles: Candles;
  depth: { bids: [number, number][]; asks: [number, number][]; timestamp: number } | null;
  derivatives: DerivativesSnapshot | null;
  provider: string;
  market: SignalMarket;
  category: string;
  failures: Record<string, string>;
}
/** Every product category the market adapters understand. A caller-supplied value outside this set is rejected, never forwarded upstream. */
const SUPPORTED_CATEGORIES = ["spot", "linear", "inverse", "option", "SPOT", "MARGIN", "USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES", "swap"] as const;
type SupportedCategory = typeof SUPPORTED_CATEGORIES[number];
const isSupportedCategory = (v: string): v is SupportedCategory => (SUPPORTED_CATEGORIES as readonly string[]).includes(v);
/** Only the timeframes the strategy weights plus its execution timeframe are fetched, keeping subrequests inside Workers limits. */
export async function loadSignalInputs(
  env: MarketEnv, symbol: string, strategy: Strategy, providerParam: string | null,
  now: number = Date.now(), market: SignalMarket = "spot", categoryParam?: string, fetchImpl: typeof fetch = fetch,
): Promise<SignalInputs | { error: "market_data_unavailable"; executionTimeframe: Timeframe; failures: Record<string, string> }> {
  const isBitget = providerParam === "bitget" || providerParam === "bitget_mix";
  const isBinance = providerParam === "binance" || providerParam === "binance_usdm";
  const isOkx = providerParam === "okx";
  const order: ProviderId[] = isBitget ? [market === "futures" ? "bitget_mix" : "bitget"]
    : isBinance ? [market === "futures" ? "binance_usdm" : "binance"]
    : isOkx ? ["okx"] : providerOrder(env, providerParam);
  const category = categoryParam || (market === "futures" ? (isBitget ? "USDT-FUTURES" : isOkx ? "swap" : "linear") : (isBitget ? "SPOT" : "spot"));
  if (!isSupportedCategory(category))
    return { error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures: { category: "unsupported_category" } };
  if (isBitget && market === "futures" && !["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"].includes(category))
    return { error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures: { category: "unsupported_bitget_product_type" } };
  if (providerParam === "bybit" && market === "futures" && !["linear", "inverse"].includes(category))
    return { error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures: { category: "unsupported_bybit_category" } };
  if (isBinance && market === "futures" && !["linear", "swap"].includes(category))
    return { error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures: { category: "unsupported_binance_category" } };
  if (isOkx && market === "futures" && category !== "swap")
    return { error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures: { category: "unsupported_okx_category" } };
  const exec = EXECUTION_TF[strategy];
  const need = TIMEFRAMES.filter(t => DEFAULT_WEIGHTS[strategy][t] > 0 || t === exec);
  const candles: Candles = {}, failures: Record<string, string> = {}; let provider = "unknown";
  const params = { symbol, market, category };
  await Promise.all(need.map(async tf => {
    try {
      const r = await getMarketData("klines", { ...params, interval: tf, limit: 300 }, order, fetchImpl);
      candles[tf] = r.data as Kline[];
      if (tf === exec) provider = r.provider;
    } catch (e) { failures[tf] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!candles[exec]) return { error: "market_data_unavailable", executionTimeframe: exec, failures };
  let depth: SignalInputs["depth"] = null;
  try {
    const d = (await getMarketData("depth", { ...params, interval: "1m", limit: 100 }, order, fetchImpl)).data as Depth;
    depth = { bids: d.bids, asks: d.asks, timestamp: now };
  } catch (e) { failures.depth = e instanceof Error ? e.message : "unknown"; }
  let derivatives: DerivativesSnapshot | null = null;
  if (market === "futures") {
    try {
      const r = await getMarketData("ticker", { ...params, interval: "1m", limit: 1 }, order, fetchImpl), t = r.data as Ticker;
      derivatives = { fundingRate: t.fundingRate ?? null, openInterest: t.openInterest ?? null, ...(t.timestamp ? { timestamp: t.timestamp } : {}), source: r.provider };
      const kv = (env as any).ETI_EXECUTION_LOG;
      if (kv && typeof kv.get === "function" && typeof kv.put === "function" && derivatives.openInterest !== null && Number.isFinite(derivatives.openInterest)) {
        const key = `eti:market:oi:v1:${r.provider}:${market}:${category}:${symbol}`;
        const rawTs = derivatives.timestamp ?? now, currentTs = rawTs < 1e12 ? rawTs * 1000 : rawTs;
        if (currentTs <= now + 30_000 && now - currentTs <= 180_000) {
          try {
            const raw = await kv.get(key), previous = typeof raw === "string" ? JSON.parse(raw) : raw;
            const previousRawTs = Number(previous?.timestamp);
            const previousTs = Number.isFinite(previousRawTs) ? (previousRawTs < 1e12 ? previousRawTs * 1000 : previousRawTs) : null;
            if (previous && Number.isFinite(Number(previous.openInterest)) && previousTs !== null && currentTs > previousTs && currentTs - previousTs <= 86_400_000)
              derivatives.previousOpenInterest = Number(previous.openInterest);
            if (!previous || previousTs === null || currentTs >= previousTs)
              await kv.put(key, JSON.stringify({ openInterest: derivatives.openInterest, timestamp: currentTs }), { expirationTtl: 86_400 });
          } catch { /* Historical OI is advisory; KV failure must never block the signal. */ }
        }
      }
    } catch (e) { failures.derivatives = e instanceof Error ? e.message : "unknown"; }
  }
  return { candles, depth, derivatives, provider, market, category, failures };
}
/** Closed 1-minute bars (used for position management) and the latest fresh 1m close as a live reference price. */
export async function loadMinuteBars(env: MarketEnv, symbol: string, providerParam: string | null, now: number, market: "spot" | "futures" = "spot"): Promise<{ bars: Kline[]; price: number | null; provider: string }> {
  const selected = providerParam === "bitget" && market === "futures" ? "bitget_mix" : providerParam === "binance" && market === "futures" ? "binance_usdm" : providerParam;
  const category = selected === "bitget_mix" ? bitgetProductFor(symbol) : selected === "okx" && market === "futures" ? "swap" : undefined;
  const r = await getMarketData("klines", { symbol, interval: "1m", limit: 300, market, category }, providerOrder(env, selected)), rows = r.data as Kline[], ms = TF_SECONDS["1m"] * 1000;
  const closed = rows.filter(k => k[0] + ms <= now), last = rows.at(-1);
  const fresh = last && now - last[0] <= 3 * ms && now - last[0] >= -60_000;
  return { bars: closed, price: fresh && last![4] > 0 ? last![4] : null, provider: r.provider };
}

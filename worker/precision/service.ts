// Assembles one live Precision signal: fetch candles and order book, load stored context, run the pure engine.
// Shared by the HTTP route and the scheduled outcome cycle so both produce identical signals.
import { getMarketData, providerOrder, type Depth, type Kline } from "../market.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TIMEFRAMES, type Strategy, type Timeframe } from "../algo/timeframes.ts";
import { resolveConfig } from "./config.ts";
import { mergeNews } from "./context.ts";
import { parseInstrument, runPrecisionEngine } from "./engine.ts";
import { loadContext, type PrecisionEnv } from "./stores.ts";
import type { PrecisionSignal } from "./types.ts";

export const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];
export const isStrategy = (s: string | null): s is Strategy => !!s && (STRATEGIES as string[]).includes(s);

export interface BuiltSignal { status: number; body: unknown; signal: PrecisionSignal | null }

/** `symbol` must already be validated and supported by the caller (parseInstrument non-null). */
export async function buildSignal(env: PrecisionEnv, symbol: string, strategy: Strategy, preferredProvider: string | null): Promise<BuiltSignal> {
  const resolved = resolveConfig(env.ETI_PRECISION_CONFIG);
  const cfg = resolved.config;
  const inst = parseInstrument(symbol);
  if (!inst) return { status: 422, body: { error: "unsupported_market", symbol }, signal: null };
  const order = providerOrder(env, preferredProvider);
  const need = TIMEFRAMES.filter(t => DEFAULT_WEIGHTS[strategy][t] > 0 || t === EXECUTION_TF[strategy]);
  const candles: Partial<Record<Timeframe, Kline[]>> = {};
  const failures: Record<string, string> = {};
  let provider = "unknown";
  const fetchedAt = Date.now();
  const ctxPromise = loadContext(env, inst.base, strategy, fetchedAt, cfg.context.expectancyMaxAgeDays);
  await Promise.all(need.map(async tf => {
    try { const r = await getMarketData("klines", { symbol, interval: tf, limit: 300 }, order); candles[tf] = r.data as Kline[]; if (tf === EXECUTION_TF[strategy]) provider = r.provider; }
    catch (e) { failures[tf] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!candles[EXECUTION_TF[strategy]]) return { status: 503, body: { decision: "DATA_UNRELIABLE", direction: "NO TRADE", error: "market_data_unavailable", executionTimeframe: EXECUTION_TF[strategy], failures, liveExecutionAllowed: false }, signal: null };
  let depth: { bids: [number, number][]; asks: [number, number][]; timestamp: number } | null = null;
  try { const d = (await getMarketData("depth", { symbol, interval: "1m", limit: 100 }, order)).data as Depth; depth = { bids: d.bids, asks: d.asks, timestamp: Date.now() }; }
  catch (e) { failures.depth = e instanceof Error ? e.message : "unknown"; }

  const ctx = await ctxPromise;
  const now = Date.now();
  const signal = runPrecisionEngine({
    symbol, strategy, candles, depth, now, fetchedAt, provider, config: cfg, configStatus: resolved.status,
    fundamentals: ctx.fundamentals, news: mergeNews(ctx.news, ctx.marketNews), expectancy: ctx.expectancy, calibration: ctx.calibration,
  });
  const notes = [...(ctx.expectancyNote ? [ctx.expectancyNote] : []), ...(resolved.status === "override_rejected" ? [`ETI_PRECISION_CONFIG was rejected and defaults are in use: ${resolved.errors.join("; ")}`] : []),
    ...(!ctx.storeConfigured ? ["No context store (ETI_PRECISION_DATA or ETI_EXECUTION_LOG) is bound: fundamentals, news, expectancy and calibration are unavailable, so the score is capped and confidence is qualitative."] : [])];
  signal.dataQuality.notes.push(...notes);
  const full = { ...signal, dataQuality: { ...signal.dataQuality, failures } };
  return { status: 200, body: full, signal: full };
}

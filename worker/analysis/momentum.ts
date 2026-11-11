// Momentum, volatility and relative strength.
import type { Kline } from "../market.ts";
import { ema } from "../algo/indicators.ts";
import { atr14 } from "./atr.ts";
import { rsiSeries } from "../algo/gainz.ts";
import { clamp, round } from "./types.ts";

export interface MomentumAnalysis {
  rsi: number; macd: { line: number; signal: number; histogram: number; histogramTrend: "rising" | "falling" | "flat" };
  roc10Pct: number; roc20Pct: number; score: number; state: "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish";
  divergence: "bullish" | "bearish" | "none"; overbought: boolean; oversold: boolean;
}
export function analyzeMomentum(rows: Kline[]): MomentumAnalysis | null {
  if (rows.length < 40) return null;
  const close = rows.map(r => r[4]), n = close.length - 1;
  const rsi = rsiSeries(close, 14), r = rsi[n];
  const e12 = ema(close, 12), e26 = ema(close, 26), macd = e12.map((v, i) => v - e26[i]), sig = ema(macd, 9), hist = macd.map((v, i) => v - sig[i]);
  const hd = hist[n] - hist[n - 3], htr = Math.abs(hd) < Math.abs(close[n]) * 1e-5 ? "flat" : hd > 0 ? "rising" : "falling";
  const roc = (k: number) => (close[n] - close[n - k]) / close[n - k] * 100;
  const rocs = clamp(roc(10) * 4, -30, 30) + clamp(roc(20) * 2, -20, 20);
  const score = clamp((r - 50) * 1.2 + rocs + (hist[n] > 0 ? 10 : -10) + (htr === "rising" ? 8 : htr === "falling" ? -8 : 0), -100, 100);
  // Divergence over the last 20 bars: price extreme not confirmed by RSI.
  const w = rows.slice(-20), wr = rsi.slice(-20), pHi = Math.max(...w.map(x => x[2])), pLo = Math.min(...w.map(x => x[3]));
  const atHi = rows[n][2] >= pHi * 0.9995, atLo = rows[n][3] <= pLo * 1.0005;
  const prevHiRsi = Math.max(...wr.slice(0, 15)), prevLoRsi = Math.min(...wr.slice(0, 15));
  const divergence = atHi && r < prevHiRsi - 3 ? "bearish" : atLo && r > prevLoRsi + 3 ? "bullish" : "none";
  const state = score >= 50 ? "strong_bullish" : score >= 15 ? "bullish" : score <= -50 ? "strong_bearish" : score <= -15 ? "bearish" : "neutral";
  return { rsi: round(r), macd: { line: macd[n], signal: sig[n], histogram: hist[n], histogramTrend: htr }, roc10Pct: round(roc(10)), roc20Pct: round(roc(20)), score: round(score), state, divergence, overbought: r >= 70, oversold: r <= 30 };
}

export interface VolatilityAnalysis { atr: number; atrPct: number; atrPercentile: number; realizedVolPct: number; bbWidthPct: number; bbWidthPercentile: number; regime: "compression" | "normal" | "expansion"; note: string }
const pctRank = (arr: number[], v: number) => { const a = arr.filter(Number.isFinite); return a.length ? a.filter(x => x <= v).length / a.length * 100 : 50; };
export function analyzeVolatility(rows: Kline[]): VolatilityAnalysis | null {
  if (rows.length < 60) return null;
  const close = rows.map(r => r[4]), atr = atr14(rows), n = rows.length - 1, price = close[n];
  const atrPct = atr.map((a, i) => (Number.isFinite(a) ? a / close[i] * 100 : NaN));
  const rets = close.slice(1).map((c, i) => Math.log(c / close[i])).slice(-30), m = rets.reduce((s, v) => s + v, 0) / rets.length;
  const rv = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / (rets.length - 1)) * 100;
  const bw: number[] = close.map((_, i) => { if (i < 19) return NaN; const s = close.slice(i - 19, i + 1), mu = s.reduce((t, v) => t + v, 0) / 20, sd = Math.sqrt(s.reduce((t, v) => t + (v - mu) ** 2, 0) / 20); return mu ? 4 * sd / mu * 100 : NaN; });
  const ap = pctRank(atrPct, atrPct[n]), bp = pctRank(bw, bw[n]);
  const regime = bp <= 20 && ap <= 35 ? "compression" : ap >= 80 || bp >= 85 ? "expansion" : "normal";
  return { atr: atr[n], atrPct: round(atrPct[n], 3), atrPercentile: round(ap, 0), realizedVolPct: round(rv, 3), bbWidthPct: round(bw[n], 3), bbWidthPercentile: round(bp, 0), regime,
    note: regime === "compression" ? "Volatility is compressed relative to its own history; expansion (in either direction) becomes more likely but direction is unknown." : regime === "expansion" ? "Volatility is elevated relative to its own history; widen stops/reduce size and expect mean reversion of volatility." : "Volatility is near its historical norm." };
}

export interface RelativeStrength { benchmark: string; periodBars: number; assetReturnPct: number; benchmarkReturnPct: number; excessReturnPct: number; ratioSlope: "rising" | "falling" | "flat"; state: "outperforming" | "underperforming" | "in_line"; alignedBars: number }
/** Aligns asset and benchmark by candle open time. Requires >= 20 shared bars; otherwise returns null rather than guessing. */
export function relativeStrength(asset: Kline[], bench: Kline[], benchmark: string, period = 50): RelativeStrength | null {
  const bm = new Map(bench.map(r => [r[0], r[4]]));
  const pairs = asset.filter(r => bm.has(r[0])).map(r => ({ a: r[4], b: bm.get(r[0])! }));
  if (pairs.length < 20) return null;
  const p = pairs.slice(-Math.min(period, pairs.length)), first = p[0], last = p[p.length - 1];
  const ar = (last.a / first.a - 1) * 100, br = (last.b / first.b - 1) * 100, ex = ar - br;
  const ratio = p.map(x => x.a / x.b), h = Math.floor(ratio.length / 2);
  const early = ratio.slice(0, h).reduce((s, v) => s + v, 0) / h, late = ratio.slice(h).reduce((s, v) => s + v, 0) / (ratio.length - h);
  const chg = (late - early) / early * 100;
  return { benchmark, periodBars: p.length, assetReturnPct: round(ar), benchmarkReturnPct: round(br), excessReturnPct: round(ex), ratioSlope: chg > 0.5 ? "rising" : chg < -0.5 ? "falling" : "flat",
    state: ex > 2 ? "outperforming" : ex < -2 ? "underperforming" : "in_line", alignedBars: pairs.length };
}

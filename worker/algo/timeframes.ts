// Eight-timeframe analysis and weighted consensus.
import type { Kline } from "../market.ts";
import { adaptiveBands, adxSeries, atrSeries, dualEma, emaFilter, volumeMomentum, type Trend } from "./indicators.ts";

export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type Timeframe = typeof TIMEFRAMES[number];
export type Strategy = "scalp" | "intraday" | "swing" | "position";
export const TF_SECONDS: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
export const MIN_TF_CANDLES = 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Importance of each timeframe depends on the strategy's holding period; all are configurable. */
export const DEFAULT_WEIGHTS: Record<Strategy, Record<Timeframe, number>> = {
  scalp:    { "1m": 0.20, "5m": 0.25, "15m": 0.25, "30m": 0.15, "1h": 0.10, "4h": 0.05, "1d": 0, "1w": 0 },
  intraday: { "1m": 0.02, "5m": 0.08, "15m": 0.15, "30m": 0.15, "1h": 0.25, "4h": 0.20, "1d": 0.15, "1w": 0 },
  swing:    { "1m": 0, "5m": 0, "15m": 0.05, "30m": 0.05, "1h": 0.10, "4h": 0.25, "1d": 0.35, "1w": 0.20 },
  position: { "1m": 0, "5m": 0, "15m": 0, "30m": 0, "1h": 0.10, "4h": 0.15, "1d": 0.35, "1w": 0.40 },
};
export const EXECUTION_TF: Record<Strategy, Timeframe> = { scalp: "5m", intraday: "15m", swing: "4h", position: "1d" };
export const HOLDING_PERIOD: Record<Strategy, string> = { scalp: "minutes to ~1 hour", intraday: "1 to 8 hours", swing: "2 to 10 days", position: "weeks" };

export interface Pivot { index: number; price: number; kind: "high" | "low" }
export function swingPivots(rows: Kline[], left = 3, right = 3, lookback = 150): Pivot[] {
  const out: Pivot[] = [], start = Math.max(left, rows.length - lookback);
  for (let i = start; i < rows.length - right; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= left && (hi || lo); j++) { if (rows[i][2] <= rows[i - j][2]) hi = false; if (rows[i][3] >= rows[i - j][3]) lo = false; }
    for (let j = 1; j <= right && (hi || lo); j++) { if (rows[i][2] < rows[i + j][2]) hi = false; if (rows[i][3] > rows[i + j][3]) lo = false; }
    if (hi) out.push({ index: i, price: rows[i][2], kind: "high" });
    if (lo) out.push({ index: i, price: rows[i][3], kind: "low" });
  }
  return out;
}
export interface Structure { bias: Trend; support: number | null; resistance: number | null; supports: number[]; resistances: number[] }
export function marketStructure(rows: Kline[]): Structure {
  const price = rows.at(-1)![4], piv = swingPivots(rows);
  const highs = piv.filter(p => p.kind === "high"), lows = piv.filter(p => p.kind === "low");
  let bias: Trend = "neutral";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs.at(-1)!.price > highs.at(-2)!.price, hl = lows.at(-1)!.price > lows.at(-2)!.price;
    const lh = highs.at(-1)!.price < highs.at(-2)!.price, ll = lows.at(-1)!.price < lows.at(-2)!.price;
    bias = hh && hl ? "bull" : lh && ll ? "bear" : "neutral";
  }
  const supports = lows.map(p => p.price).filter(p => p < price).sort((a, b) => b - a);
  const resistances = highs.map(p => p.price).filter(p => p > price).sort((a, b) => a - b);
  return { bias, support: supports[0] ?? null, resistance: resistances[0] ?? null, supports, resistances };
}

export interface TimeframeAnalysis {
  timeframe: Timeframe; candles: number; trend: Trend; trendScore: number; momentum: number;
  volumeConfirms: boolean; relativeVolume: number; emaAlignment: "bull" | "bear" | "mixed";
  atr: number; atrPercent: number; adx: number; structure: Structure; divergence: "bullish" | "bearish" | "none";
  signalStrength: number; reliability: number; bandTrend: "bull" | "bear"; choppy: boolean; price: number; lastCandleTime: number;
}
export function analyzeTimeframe(tf: Timeframe, rows: Kline[]): TimeframeAnalysis | null {
  if (rows.length < MIN_TF_CANDLES) return null;
  const price = rows.at(-1)![4], a = atrSeries(rows).at(-1)!, adx = adxSeries(rows).adx.at(-1)!;
  if (!Number.isFinite(a) || !Number.isFinite(adx)) return null;
  const vm = volumeMomentum(rows), ef = emaFilter(rows, [20, 50, 200], a), bands = adaptiveBands(rows), de = dualEma(rows, 12, 26, a), st = marketStructure(rows);
  const v = (t: Trend) => (t === "bull" ? 1 : t === "bear" ? -1 : 0);
  const alignScore = ef.alignment === "bull" ? 100 : ef.alignment === "bear" ? -100 : (v(ef.short) + v(ef.intermediate)) / 2 * 60;
  const bandScore = bands.trend === "bull" ? 100 : -100;
  const structScore = v(st.bias) * 100;
  const trendScore = clamp(0.35 * bandScore + 0.30 * alignScore + 0.20 * vm.score + 0.15 * structScore, -100, 100);
  const trend: Trend = trendScore > 20 ? "bull" : trendScore < -20 ? "bear" : "neutral";
  const reliability = clamp(30 + Math.min(adx, 40) * 0.75 + ef.consistency * 25 + (rows.length >= 210 ? 10 : 0) - (bands.choppy ? 15 : 0), 0, 100);
  return { timeframe: tf, candles: rows.length, trend, trendScore: Number(trendScore.toFixed(2)), momentum: vm.score, volumeConfirms: vm.volumeConfirmsPrice, relativeVolume: vm.relativeVolume,
    emaAlignment: ef.alignment, atr: a, atrPercent: a / price * 100, adx, structure: st, divergence: vm.divergence, signalStrength: Math.abs(trendScore), reliability: Number(reliability.toFixed(1)),
    bandTrend: bands.trend, choppy: bands.choppy, price, lastCandleTime: rows.at(-1)![0] };
}

export interface Consensus {
  direction: Trend; weightedScore: number; confidence: number; bullish: number; bearish: number; neutral: number; unavailable: Timeframe[];
  dominantTimeframe: Timeframe | null; conflicts: string[]; opposingWeightShare: number; degraded: boolean; weightsUsed: Partial<Record<Timeframe, number>>;
  /** Consensus is evidence only. It can never trigger or authorise execution, even when all eight timeframes agree. */
  executionEligible: false; note: string;
}
export function buildConsensus(analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>>, strategy: Strategy, weights: Record<Timeframe, number> = DEFAULT_WEIGHTS[strategy]): Consensus {
  const avail = TIMEFRAMES.filter(t => analyses[t]);
  const unavailable = TIMEFRAMES.filter(t => !analyses[t]);
  const wsum = avail.reduce((s, t) => s + weights[t], 0);
  const missingWeight = unavailable.reduce((s, t) => s + weights[t], 0);
  const degraded = wsum <= 0 || missingWeight > 0.25;
  const norm = (t: Timeframe) => (wsum > 0 ? weights[t] / wsum : 0);
  let score = 0, bull = 0, bear = 0, neu = 0, dom: Timeframe | null = null, domMag = -1;
  for (const t of avail) {
    const a = analyses[t]!;
    const contrib = norm(t) * a.trendScore * (0.5 + 0.5 * a.reliability / 100);
    score += contrib;
    if (a.trend === "bull") bull++; else if (a.trend === "bear") bear++; else neu++;
    if (Math.abs(contrib) > domMag && weights[t] > 0) { domMag = Math.abs(contrib); dom = t; }
  }
  const direction: Trend = score > 20 ? "bull" : score < -20 ? "bear" : "neutral";
  const sign = direction === "bull" ? 1 : direction === "bear" ? -1 : 0;
  let agree = 0, oppose = 0;
  for (const t of avail) { const a = analyses[t]!; const s = a.trend === "bull" ? 1 : a.trend === "bear" ? -1 : 0; if (sign !== 0 && s === sign) agree += norm(t); if (sign !== 0 && s === -sign) oppose += norm(t); }
  const conflicts: string[] = [];
  const grp = (ts: Timeframe[]) => { let g = 0; for (const t of ts) if (analyses[t]) g += norm(t) * (analyses[t]!.trendScore); return g; };
  const hi = grp(["4h", "1d", "1w"]), lo = grp(["1m", "5m", "15m", "30m", "1h"]);
  if (Math.abs(hi) > 8 && Math.abs(lo) > 8 && Math.sign(hi) !== Math.sign(lo)) conflicts.push(`Higher timeframes (4h/1d/1w) lean ${hi > 0 ? "bullish" : "bearish"} while lower timeframes lean ${lo > 0 ? "bullish" : "bearish"}`);
  for (const t of avail) { const a = analyses[t]!; if (sign !== 0 && weights[t] >= 0.15 && a.trend === (sign > 0 ? "bear" : "bull")) conflicts.push(`${t} (weight ${(weights[t] * 100).toFixed(0)}%) opposes the consensus`); }
  const penalty = oppose * 40 + (conflicts.length ? 5 : 0);
  const confidence = clamp(Math.abs(score) * (0.4 + 0.6 * agree) - penalty * 0.5 - (degraded ? 15 : 0), 0, 100);
  return { direction, weightedScore: Number(score.toFixed(2)), confidence: Number(confidence.toFixed(1)), bullish: bull, bearish: bear, neutral: neu, unavailable, dominantTimeframe: dom, conflicts,
    opposingWeightShare: Number(oppose.toFixed(3)), degraded, weightsUsed: Object.fromEntries(avail.map(t => [t, Number(norm(t).toFixed(3))])), executionEligible: false,
    note: "Timeframe agreement is analytical evidence only and never authorises execution by itself." };
}

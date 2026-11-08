// ETI Algorithmic Intelligence Engine: independently engineered indicator core.
// Built from publicly documented technical-analysis concepts only. Pure functions, no I/O.
import type { Kline } from "../market.ts";

export type Trend = "bull" | "bear" | "neutral";
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

/** Wilder ATR series. Entries before `period` bars are NaN. */
export function atrSeries(rows: Kline[], period = 14): number[] {
  const out: number[] = new Array(rows.length).fill(NaN);
  if (rows.length <= period) return out;
  const tr = rows.map((r, i) => (i === 0 ? r[2] - r[3] : Math.max(r[2] - r[3], Math.abs(r[2] - rows[i - 1][4]), Math.abs(r[3] - rows[i - 1][4]))));
  let v = mean(tr.slice(1, period + 1));
  out[period] = v;
  for (let i = period + 1; i < rows.length; i++) { v = (v * (period - 1) + tr[i]) / period; out[i] = v; }
  return out;
}

/** Wilder ADX with +DI/-DI. */
export function adxSeries(rows: Kline[], period = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = rows.length, adx = new Array(n).fill(NaN), pdi = new Array(n).fill(NaN), mdi = new Array(n).fill(NaN);
  if (n < period * 2 + 1) return { adx, plusDI: pdi, minusDI: mdi };
  const tr: number[] = [0], pdm: number[] = [0], mdm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = rows[i][2] - rows[i - 1][2], dn = rows[i - 1][3] - rows[i][3];
    pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4])));
  }
  let sTR = tr.slice(1, period + 1).reduce((a, b) => a + b, 0), sP = pdm.slice(1, period + 1).reduce((a, b) => a + b, 0), sM = mdm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = period; i < n; i++) {
    if (i > period) { sTR = sTR - sTR / period + tr[i]; sP = sP - sP / period + pdm[i]; sM = sM - sM / period + mdm[i]; }
    const p = sTR ? 100 * sP / sTR : 0, m = sTR ? 100 * sM / sTR : 0;
    pdi[i] = p; mdi[i] = m;
    dx.push(p + m ? 100 * Math.abs(p - m) / (p + m) : 0);
    if (dx.length === period) adx[i] = mean(dx);
    else if (dx.length > period) adx[i] = (adx[i - 1] * (period - 1) + dx[dx.length - 1]) / period;
  }
  return { adx, plusDI: pdi, minusDI: mdi };
}

// ---------- A. Volume-weighted directional momentum ----------
export interface VolumeMomentum {
  score: number;                 // -100..+100
  buyingPressure: number; sellingPressure: number; // share of volume 0..1
  relativeVolume: number; volumeAcceleration: number;
  exhaustion: boolean; unusualVolume: boolean;
  divergence: "bullish" | "bearish" | "none";
  volumeConfirmsPrice: boolean;
}
export function volumeMomentum(rows: Kline[], lookback = 14): VolumeMomentum {
  const w = rows.slice(-lookback), base = rows.slice(-(lookback * 2 + 1), -1);
  let buy = 0, sell = 0;
  for (const r of w) {
    const range = r[2] - r[3];
    // Close-location value splits each candle's volume into buy/sell participation.
    const clv = range > 0 ? ((r[4] - r[3]) - (r[2] - r[4])) / range : 0;
    buy += r[5] * (1 + clv) / 2; sell += r[5] * (1 - clv) / 2;
  }
  const tot = buy + sell || 1;
  const bp = buy / tot, sp = sell / tot;
  const baseVol = mean(base.map(r => r[5])), lastVol = rows.at(-1)![5];
  const rv = baseVol > 0 ? lastVol / baseVol : 0;
  const half = Math.floor(w.length / 2);
  const early = mean(w.slice(0, half).map(r => r[5])), late = mean(w.slice(half).map(r => r[5]));
  const accel = early > 0 ? late / early - 1 : 0;
  const net = (bp - sp);                                 // -1..1
  const priceChange = w.at(-1)![4] - w[0][4];
  const priceDir = Math.sign(priceChange), flowDir = Math.sign(net);
  const confirms = priceDir === 0 || flowDir === priceDir;
  // Low participation damps the score: thin-volume moves are not genuine directional participation.
  const participation = clamp(rv, 0.3, 1.5) / 1.5;
  const score = clamp(net * 100 * (0.5 + 0.5 * participation) * (confirms ? 1 : 0.6), -100, 100);
  // Divergence: price makes a new extreme over the window while flow fails to confirm.
  const mid = Math.floor(rows.length) - 1;
  const hi = Math.max(...w.map(r => r[2])), lo = Math.min(...w.map(r => r[3]));
  const atHigh = rows[mid][2] >= hi, atLow = rows[mid][3] <= lo;
  const divergence = atHigh && net < 0 ? "bearish" : atLow && net > 0 ? "bullish" : "none";
  // Exhaustion: extended price move with fading volume.
  const exhaustion = Math.abs(priceChange) > 0 && accel < -0.3 && Math.abs(net) > 0.25;
  return { score: Number(score.toFixed(2)), buyingPressure: bp, sellingPressure: sp, relativeVolume: rv, volumeAcceleration: accel, exhaustion, unusualVolume: rv >= 2.5, divergence, volumeConfirmsPrice: confirms };
}

// ---------- B. Dual EMA momentum ----------
export interface DualEma {
  fast: number; slow: number; separationAtr: number; slope: number;
  state: "bull" | "bear" | "flat"; crossover: "bullish" | "bearish" | "none"; barsSinceCross: number | null;
  momentum: "accelerating" | "decelerating" | "steady"; exhaustionRisk: boolean;
  /** A crossover alone never produces a signal; this flag says whether it is independently confirmed. */
  crossConfirmed: boolean;
}
export function dualEma(rows: Kline[], fastP = 12, slowP = 26, atrNow = NaN): DualEma {
  const close = rows.map(r => r[4]);
  const f = ema(close, fastP), s = ema(close, slowP), n = close.length - 1;
  const diff = f.map((v, i) => v - s[i]);
  let since: number | null = null, cross: "bullish" | "bearish" | "none" = "none";
  for (let i = n; i > 0 && i > n - 50; i--) if (Math.sign(diff[i]) !== Math.sign(diff[i - 1]) && diff[i] !== 0) { since = n - i; cross = diff[i] > 0 ? "bullish" : "bearish"; break; }
  const a = Number.isFinite(atrNow) && atrNow > 0 ? atrNow : Math.abs(close[n]) * 0.01;
  const sep = diff[n] / a;
  const slope = (s[n] - s[Math.max(0, n - 5)]) / (5 * a);
  const d1 = diff[n] - diff[Math.max(0, n - 3)], d0 = diff[Math.max(0, n - 3)] - diff[Math.max(0, n - 6)];
  const sameSign = Math.sign(diff[n]) !== 0;
  const momentum = sameSign && Math.abs(d1) > Math.abs(d0) * 1.1 && Math.sign(d1) === Math.sign(diff[n]) ? "accelerating" : Math.abs(d1) < Math.abs(d0) * 0.9 ? "decelerating" : "steady";
  const state = Math.abs(sep) < 0.05 ? "flat" : sep > 0 ? "bull" : "bear";
  // Confirmation requires separation to widen after the cross and slope to agree with it.
  const crossConfirmed = cross !== "none" && since !== null && since >= 1 && Math.sign(slope) === Math.sign(diff[n]) && Math.abs(sep) >= 0.15;
  return { fast: f[n], slow: s[n], separationAtr: sep, slope, state, crossover: cross, barsSinceCross: since, momentum, exhaustionRisk: Math.abs(sep) > 3 && momentum === "decelerating", crossConfirmed };
}

// ---------- C. ATR volatility intelligence ----------
export type VolClass = "low" | "normal" | "high" | "extreme";
export interface Volatility { atr: number; atrPercent: number; percentile: number; classification: VolClass; expansion: boolean; contraction: boolean }
export function volatility(rows: Kline[], period = 14, window = 100): Volatility {
  const a = atrSeries(rows, period), valid = a.filter(Number.isFinite);
  const now = valid.at(-1)!, price = rows.at(-1)![4];
  const hist = valid.slice(-window), pct = hist.filter(v => v <= now).length / hist.length;
  const prev = valid.at(-Math.min(valid.length, 11))!;
  return { atr: now, atrPercent: now / price * 100, percentile: pct, classification: pct >= 0.95 ? "extreme" : pct >= 0.75 ? "high" : pct <= 0.2 ? "low" : "normal", expansion: now > prev * 1.25, contraction: now < prev * 0.8 };
}
/** Volatility-scaled stop distance. Multiplier shrinks in extreme vol (reduce exposure) and never equals a fixed distance across assets. */
export function atrLevels(atr: number, price: number, cls: VolClass, mults = { stop: 1.5, trail: 2.5 }) {
  const regimeAdj = { low: 0.9, normal: 1, high: 1.2, extreme: 1.4 }[cls];
  return { stopDistance: Math.max(atr * mults.stop * regimeAdj, price * 0.001), trailDistance: Math.max(atr * mults.trail * regimeAdj, price * 0.002), regimeAdj };
}
/** Fixed-fractional position size from risk budget; returns 0 if the stop is degenerate. */
export function positionSize(equity: number, riskFraction: number, entry: number, stop: number, volCls: VolClass): number {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || !(equity > 0)) return 0;
  const volScale = { low: 1, normal: 1, high: 0.6, extreme: 0.3 }[volCls];
  return (equity * riskFraction * volScale) / dist;
}

// ---------- D. Adaptive trailing bands ----------
export interface AdaptiveBands {
  trend: "bull" | "bear"; upper: number; lower: number; active: number;
  flipped: boolean; barsInTrend: number; flipsLast50: number; choppy: boolean; reversalConfirmed: boolean;
}
export function adaptiveBands(rows: Kline[], period = 14, mult = 2.5, flipBuffer = 0.25): AdaptiveBands {
  const a = atrSeries(rows, period);
  let trend: "bull" | "bear" = "bull", upper = NaN, lower = NaN, since = 0, flipped = false;
  const flips: number[] = [];
  for (let i = period + 1; i < rows.length; i++) {
    const r = rows[i], hl2 = (r[2] + r[3]) / 2, d = a[i] * mult;
    const bu = hl2 + d, bl = hl2 - d, prevClose = rows[i - 1][4];
    if (Number.isNaN(upper)) { upper = bu; lower = bl; trend = r[4] >= hl2 ? "bull" : "bear"; since = 0; continue; }
    // Ratchet: bands only tighten in the direction of the trend.
    lower = prevClose > lower ? Math.max(bl, lower) : bl;
    upper = prevClose < upper ? Math.min(bu, upper) : bu;
    flipped = false;
    // Hysteresis: a flip needs a close beyond the band by flipBuffer*ATR, which suppresses sideways whipsaw.
    if (trend === "bull" && r[4] < lower - flipBuffer * a[i]) { trend = "bear"; flipped = true; since = 0; flips.push(i); upper = bu; }
    else if (trend === "bear" && r[4] > upper + flipBuffer * a[i]) { trend = "bull"; flipped = true; since = 0; flips.push(i); lower = bl; }
    else since++;
  }
  const n = rows.length - 1, recent = flips.filter(i => i > n - 50).length;
  const last = rows[n][4];
  // Independent evidence for a reversal: volume flow and EMA slope must agree with the new direction.
  const vm = volumeMomentum(rows), de = dualEma(rows, 12, 26, a[n]);
  const dir = trend === "bull" ? 1 : -1;
  const reversalConfirmed = flipped && Math.sign(vm.score) === dir && Math.sign(de.slope) === dir;
  return { trend, upper, lower, active: trend === "bull" ? lower : upper, flipped, barsInTrend: since, flipsLast50: recent, choppy: recent >= 3, reversalConfirmed };
}

// ---------- E. EMA trend confirmation filter ----------
export interface EmaFilter {
  short: Trend; intermediate: Trend; long: Trend;
  alignment: "bull" | "bear" | "mixed"; slope: number; strength: number; consistency: number;
  countertrendAllowedAgainst: Trend;
}
export function emaFilter(rows: Kline[], periods = [20, 50, 200], atrNow = NaN): EmaFilter {
  const close = rows.map(r => r[4]), n = close.length - 1, price = close[n];
  const e = periods.map(p => ema(close, p)), v = e.map(x => x[n]);
  const t = (a: number, b: number): Trend => (Math.abs(a - b) / b < 0.0005 ? "neutral" : a > b ? "bull" : "bear");
  const short = t(price, v[0]), inter = t(v[0], v[1]), long = t(v[1], v[2]);
  const alignment = price > v[0] && v[0] > v[1] && v[1] > v[2] ? "bull" : price < v[0] && v[0] < v[1] && v[1] < v[2] ? "bear" : "mixed";
  const a = Number.isFinite(atrNow) && atrNow > 0 ? atrNow : price * 0.01;
  const slope = (e[1][n] - e[1][Math.max(0, n - 10)]) / (10 * a);
  const spread = Math.abs(v[0] - v[2]) / a;
  // Consistency: share of the last 50 bars where price sat on the same side of the mid EMA as now.
  const side = Math.sign(price - v[1]);
  const lastBars = close.slice(-50), mid = e[1].slice(-50);
  const consistency = lastBars.filter((c, i) => Math.sign(c - mid[i]) === side).length / lastBars.length;
  const strength = clamp((alignment === "mixed" ? 0.3 : 0.7) * 50 + Math.min(spread, 10) * 3 + consistency * 20 - (alignment === "mixed" ? 10 : 0), 0, 100);
  return { short, intermediate: inter, long, alignment, slope, strength: Number(strength.toFixed(1)), consistency, countertrendAllowedAgainst: alignment === "mixed" ? "neutral" : alignment };
}
/** Countertrend setups are only allowed when reversal evidence AND reward/risk are both strong. */
export function countertrendAllowed(filter: EmaFilter, direction: 1 | -1, reversalEvidence: number, rewardRisk: number): boolean {
  const against = (filter.alignment === "bull" && direction < 0) || (filter.alignment === "bear" && direction > 0);
  if (!against) return true;
  return reversalEvidence >= 70 && rewardRisk >= 3;
}

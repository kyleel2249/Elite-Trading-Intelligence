/** Small pure numeric helpers shared by the Global Alpha modules (no I/O). */
import type { Kline } from "../market.ts";

export const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : NaN);
export const stdev = (a: number[]) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, d = 2) => Number.isFinite(v) ? Number(v.toFixed(d)) : 0;

export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1); const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}
export function smaAt(values: number[], period: number, end = values.length): number {
  if (end < period) return NaN; let s = 0; for (let i = end - period; i < end; i++) s += values[i]; return s / period;
}
export function trueRanges(rows: Kline[]): number[] {
  return rows.map((r, i) => i === 0 ? r[2] - r[3] : Math.max(r[2] - r[3], Math.abs(r[2] - rows[i - 1][4]), Math.abs(r[3] - rows[i - 1][4])));
}
/** Simple average true range of the last `period` bars ending before index `end` (exclusive). */
export function atrAt(rows: Kline[], period = 14, end = rows.length): number {
  if (end < period + 1) return NaN; const tr = trueRanges(rows.slice(0, end)); return mean(tr.slice(-period));
}
/** Chaikin accumulation/distribution line (cumulative money-flow volume). */
export function adLine(rows: Kline[]): number[] {
  let acc = 0; return rows.map(r => { const range = r[2] - r[3]; acc += range > 0 ? (((r[4] - r[3]) - (r[2] - r[4])) / range) * r[5] : 0; return acc; });
}
/** Least-squares slope of values against index, normalised by mean absolute value (per-bar fraction). */
export function normSlope(values: number[]): number {
  const n = values.length; if (n < 3) return NaN;
  const mx = (n - 1) / 2, my = mean(values); let num = 0, den = 0;
  values.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  const scale = mean(values.map(Math.abs)); return scale > 0 && den > 0 ? num / den / scale : 0;
}
/** Plain least-squares slope (units per bar). */
export function slope(values: number[]): number {
  const n = values.length; if (n < 3) return NaN;
  const mx = (n - 1) / 2, my = mean(values); let num = 0, den = 0;
  values.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den > 0 ? num / den : 0;
}
export function percentRank(sample: number[], v: number): number {
  if (!sample.length) return NaN; return sample.filter(x => x <= v).length / sample.length;
}
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= period; l /= period; out[period] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; g = (g * (period - 1) + Math.max(d, 0)) / period; l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}
/** Wilder ADX with +DI/-DI, full series. */
export function adxSeries(rows: Kline[], period = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = rows.length, adx = new Array(n).fill(NaN), pdi = new Array(n).fill(NaN), mdi = new Array(n).fill(NaN);
  if (n < period * 2 + 1) return { adx, plusDI: pdi, minusDI: mdi };
  const tr: number[] = [0], pm: number[] = [0], mm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = rows[i][2] - rows[i - 1][2], dn = rows[i - 1][3] - rows[i][3];
    pm.push(up > dn && up > 0 ? up : 0); mm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4])));
  }
  let sTR = sum(tr.slice(1, period + 1)), sP = sum(pm.slice(1, period + 1)), sM = sum(mm.slice(1, period + 1));
  const dx: number[] = new Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) { sTR = sTR - sTR / period + tr[i]; sP = sP - sP / period + pm[i]; sM = sM - sM / period + mm[i]; }
    const p = sTR ? 100 * sP / sTR : 0, m = sTR ? 100 * sM / sTR : 0;
    pdi[i] = p; mdi[i] = m; dx[i] = p + m ? 100 * Math.abs(p - m) / (p + m) : 0;
  }
  let a = mean(dx.slice(period, period * 2)); adx[period * 2 - 1] = a;
  for (let i = period * 2; i < n; i++) { a = (a * (period - 1) + dx[i]) / period; adx[i] = a; }
  return { adx, plusDI: pdi, minusDI: mdi };
}
/** Inverse standard normal CDF (Acklam approximation, |error| < 1.2e-9). */
export function normInv(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const lo = 0.02425, hi = 1 - lo; let q: number, r: number;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Small deterministic PRNG (LCG) used for the seeded control strategy and test data. */
export function prng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

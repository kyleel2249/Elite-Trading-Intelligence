import type { Depth, Kline } from "./types.ts";

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function finite(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
export const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function mean(a: number[]): number { if (!a.length) return NaN; let s = 0; for (const x of a) s += x; return s / a.length; }
export function variance(a: number[]): number { if (a.length < 2) return NaN; const m = mean(a); let s = 0; for (const x of a) s += (x - m) ** 2; return s / (a.length - 1); }
export const stdev = (a: number[]) => Math.sqrt(variance(a));
export const lastFinite = (a: number[]): number => { for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i]; return NaN; };

export function sma(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) out[i] = s / p; }
  return out;
}
export function ema(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  if (v.length < p) return out;
  let e = mean(v.slice(0, p)); out[p - 1] = e; const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
export function rsi(close: number[], p = 14): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  if (close.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = close[i] - close[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
export function atrSeries(c: Kline[], p = 14): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  if (c.length <= p) return out;
  const tr: number[] = [NaN];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])));
  let a = mean(tr.slice(1, p + 1)); out[p] = a;
  for (let i = p + 1; i < c.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; }
  return out;
}
export function macd(close: number[], f = 12, s = 26, sg = 9) {
  const ef = ema(close, f), es = ema(close, s), n = close.length;
  const line = new Array<number>(n).fill(NaN), signal = new Array<number>(n).fill(NaN), hist = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) line[i] = ef[i] - es[i];
  const first = line.findIndex((x) => Number.isFinite(x));
  if (first >= 0) {
    const seg = line.slice(first), sgl = ema(seg, sg);
    for (let i = 0; i < seg.length; i++) { signal[first + i] = sgl[i]; if (Number.isFinite(sgl[i])) hist[first + i] = seg[i] - sgl[i]; }
  }
  return { line, signal, hist };
}
export function logReturns(close: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < close.length; i++) if (close[i] > 0 && close[i - 1] > 0) r.push(Math.log(close[i] / close[i - 1]));
  return r;
}
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); if (n < 10) return NaN;
  const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
export function beta(asset: number[], bench: number[]): number {
  const n = Math.min(asset.length, bench.length); if (n < 10) return NaN;
  const x = asset.slice(-n), y = bench.slice(-n), mx = mean(x), my = mean(y);
  let sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); syy += (y[i] - my) ** 2; }
  return syy > 0 ? sxy / syy : NaN;
}
export const autocorr1 = (r: number[]): number => (r.length < 12 ? NaN : correlation(r.slice(1), r.slice(0, -1)));
export function varianceRatio(r: number[], q: number): number {
  if (r.length < q * 4) return NaN;
  const v1 = variance(r); if (!(v1 > 0)) return NaN;
  const sums: number[] = [];
  for (let i = q - 1; i < r.length; i++) { let s = 0; for (let j = 0; j < q; j++) s += r[i - j]; sums.push(s); }
  return variance(sums) / (q * v1);
}
export function skewness(a: number[]): number {
  const n = a.length; if (n < 8) return NaN; const m = mean(a), s = stdev(a); if (!(s > 0)) return NaN;
  let t = 0; for (const x of a) t += ((x - m) / s) ** 3; return t / n;
}
export function excessKurtosis(a: number[]): number {
  const n = a.length; if (n < 8) return NaN; const m = mean(a), s = stdev(a); if (!(s > 0)) return NaN;
  let t = 0; for (const x of a) t += ((x - m) / s) ** 4; return t / n - 3;
}
export function maxDrawdown(close: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const c of close) { if (c > peak) peak = c; if (peak > 0) dd = Math.max(dd, (peak - c) / peak); }
  return dd;
}
/** Wilson score interval for a binomial proportion. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface BookStats {
  bid: number; ask: number; mid: number; spreadBps: number; bidUsd1pct: number; askUsd1pct: number;
  imbalance: number; bidWallShare: number; askWallShare: number;
}
/** Expects a validated book: bids descending, asks ascending (as produced by worker/market.ts). */
export function bookStats(d: Depth): BookStats {
  const bid = d.bids[0][0], ask = d.asks[0][0], mid = (bid + ask) / 2;
  const usd = (side: [number, number][], lo: number, hi: number) => side.filter(([p]) => p >= lo && p <= hi).reduce((s, [p, q]) => s + p * q, 0);
  const bidUsd1pct = usd(d.bids, mid * 0.99, mid), askUsd1pct = usd(d.asks, mid, mid * 1.01);
  const wall = (side: [number, number][]) => {
    const tot = side.reduce((s, [p, q]) => s + p * q, 0);
    return tot > 0 ? Math.max(...side.map(([p, q]) => p * q)) / tot : 0;
  };
  const tot = bidUsd1pct + askUsd1pct;
  return { bid, ask, mid, spreadBps: ((ask - bid) / mid) * 1e4, bidUsd1pct, askUsd1pct, imbalance: tot > 0 ? (bidUsd1pct - askUsd1pct) / tot : 0, bidWallShare: wall(d.bids), askWallShare: wall(d.asks) };
}

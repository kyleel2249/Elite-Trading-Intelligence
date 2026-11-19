// Advanced technical indicator suite. Every series is CAUSAL: the value at bar i uses only bars 0..i, so a signal read at a closed candle never changes
// afterwards (no repainting). The only forward-looking arrays are the Ichimoku cloud projection and the chikou span, which are labelled as plotting aids and are
// never used as signal inputs beyond what was already known at that bar.
import type { Kline } from "../market.ts";
import { adxSeries, atrSeries, ema } from "../algo/indicators.ts";

export { adxSeries, atrSeries, ema };
const nanArr = (n: number): number[] => new Array<number>(n).fill(NaN);
const fin = (x: number) => Number.isFinite(x);

export function sma(values: number[], period: number): number[] {
  const out = nanArr(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) { if (!fin(values[j])) { ok = false; break; } s += values[j]; }
    if (ok) out[i] = s / period;
  }
  return out;
}

/** Wilder RSI. Values start at index `period`. A flat series is 50; a series with no losses is 100. */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out = nanArr(closes.length);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  const rsi = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = rsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsi();
  }
  return out;
}

export function macdSeries(closes: number[], fast = 12, slow = 26, signalPeriod = 9): { macd: number[]; signal: number[]; hist: number[] } {
  const n = closes.length, macd = nanArr(n), signal = nanArr(n), hist = nanArr(n);
  if (n < slow + signalPeriod) return { macd, signal, hist };
  const ef = ema(closes, fast), es = ema(closes, slow);
  for (let i = slow - 1; i < n; i++) macd[i] = ef[i] - es[i];
  const sig = ema(macd.slice(slow - 1), signalPeriod);
  for (let i = slow - 1; i < n; i++) if (i - (slow - 1) >= signalPeriod - 1) { signal[i] = sig[i - (slow - 1)]; hist[i] = macd[i] - signal[i]; }
  return { macd, signal, hist };
}

export function bollingerSeries(closes: number[], period = 20, k = 2) {
  const n = closes.length, mid = sma(closes, period), upper = nanArr(n), lower = nanArr(n), pctB = nanArr(n), bandwidth = nanArr(n);
  for (let i = period - 1; i < n; i++) {
    let v = 0; for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + k * sd; lower[i] = mid[i] - k * sd;
    pctB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i]);
    bandwidth[i] = mid[i] === 0 ? NaN : (upper[i] - lower[i]) / mid[i];
  }
  return { mid, upper, lower, pctB, bandwidth };
}

export interface IchimokuResult {
  tenkan: number[]; kijun: number[];
  /** Cloud edges AS PLOTTED at each bar (computed from data `displacement` bars earlier), so they are causal. */
  cloudA: number[]; cloudB: number[];
  /** Projection of the cloud over the next `displacement` bars: known now because it comes from past bars. */
  futureA: number[]; futureB: number[];
  /** +1 when the close is above the close `displacement` bars ago (chikou confirmation), -1 below, 0 unknown. */
  chikou: number[];
}
export function ichimoku(rows: Kline[], conv = 9, base = 26, spanBPeriod = 52, displacement = 26): IchimokuResult {
  const n = rows.length, tenkan = nanArr(n), kijun = nanArr(n), rawA = nanArr(n), rawB = nanArr(n);
  const mid = (i: number, p: number) => { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { hi = Math.max(hi, rows[j][2]); lo = Math.min(lo, rows[j][3]); } return (hi + lo) / 2; };
  for (let i = 0; i < n; i++) {
    if (i >= conv - 1) tenkan[i] = mid(i, conv);
    if (i >= base - 1) kijun[i] = mid(i, base);
    if (fin(tenkan[i]) && fin(kijun[i])) rawA[i] = (tenkan[i] + kijun[i]) / 2;
    if (i >= spanBPeriod - 1) rawB[i] = mid(i, spanBPeriod);
  }
  const cloudA = nanArr(n), cloudB = nanArr(n), chikou = new Array<number>(n).fill(0);
  for (let i = displacement; i < n; i++) {
    cloudA[i] = rawA[i - displacement]; cloudB[i] = rawB[i - displacement];
    chikou[i] = rows[i][4] > rows[i - displacement][4] ? 1 : rows[i][4] < rows[i - displacement][4] ? -1 : 0;
  }
  const futureA: number[] = [], futureB: number[] = [];
  for (let k = 1; k <= displacement; k++) { const src = n - 1 + k - displacement; futureA.push(src >= 0 && src < n ? rawA[src] : NaN); futureB.push(src >= 0 && src < n ? rawB[src] : NaN); }
  return { tenkan, kijun, cloudA, cloudB, futureA, futureB, chikou };
}

export interface SupertrendResult { line: number[]; dir: number[]; flippedAt: number[] }
export function supertrend(rows: Kline[], period = 10, mult = 3): SupertrendResult {
  const n = rows.length, atr = atrSeries(rows, period), line = nanArr(n), dir = new Array<number>(n).fill(0), flippedAt = new Array<number>(n).fill(-1);
  const fu = nanArr(n), fl = nanArr(n);
  for (let i = 0; i < n; i++) {
    if (!fin(atr[i])) continue;
    const hl2 = (rows[i][2] + rows[i][3]) / 2, bu = hl2 + mult * atr[i], bl = hl2 - mult * atr[i];
    if (!fin(fu[i - 1])) {
      fu[i] = bu; fl[i] = bl; dir[i] = rows[i][4] >= hl2 ? 1 : -1; line[i] = dir[i] === 1 ? fl[i] : fu[i]; continue;
    }
    fu[i] = bu < fu[i - 1] || rows[i - 1][4] > fu[i - 1] ? bu : fu[i - 1];
    fl[i] = bl > fl[i - 1] || rows[i - 1][4] < fl[i - 1] ? bl : fl[i - 1];
    dir[i] = dir[i - 1];
    if (dir[i - 1] === -1 && rows[i][4] > fu[i]) dir[i] = 1; else if (dir[i - 1] === 1 && rows[i][4] < fl[i]) dir[i] = -1;
    flippedAt[i] = dir[i] !== dir[i - 1] ? i : flippedAt[i - 1];
    line[i] = dir[i] === 1 ? fl[i] : fu[i];
  }
  return { line, dir, flippedAt };
}

/** Session VWAP anchored to the UTC day, with a volume-weighted 1-sigma band. Zero-volume bars contribute nothing; a session with no volume has no VWAP. */
export function vwapSession(rows: Kline[]) {
  const n = rows.length, vwap = nanArr(n), upper = nanArr(n), lower = nanArr(n);
  let day = -1, pv = 0, vv = 0, pv2 = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(rows[i][0] / 86_400_000);
    if (d !== day) { day = d; pv = 0; vv = 0; pv2 = 0; }
    const tp = (rows[i][2] + rows[i][3] + rows[i][4]) / 3, v = Math.max(0, rows[i][5]);
    pv += tp * v; vv += v; pv2 += tp * tp * v;
    if (vv > 0) { const m = pv / vv, sd = Math.sqrt(Math.max(0, pv2 / vv - m * m)); vwap[i] = m; upper[i] = m + sd; lower[i] = m - sd; }
  }
  return { vwap, upper, lower };
}

export function cciSeries(rows: Kline[], period = 20): number[] {
  const n = rows.length, tp = rows.map((r) => (r[2] + r[3] + r[4]) / 3), m = sma(tp, period), out = nanArr(n);
  for (let i = period - 1; i < n; i++) {
    let dev = 0; for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
    dev /= period; out[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
  }
  return out;
}

export function obvSeries(rows: Kline[]): number[] {
  const out: number[] = []; let acc = 0;
  rows.forEach((r, i) => { if (i > 0) acc += r[4] > rows[i - 1][4] ? r[5] : r[4] < rows[i - 1][4] ? -r[5] : 0; out.push(acc); });
  return out;
}

export function mfiSeries(rows: Kline[], period = 14): number[] {
  const n = rows.length, out = nanArr(n), tp = rows.map((r) => (r[2] + r[3] + r[4]) / 3), flow = rows.map((r, i) => tp[i] * r[5]);
  for (let i = period; i < n; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) { if (tp[j] > tp[j - 1]) pos += flow[j]; else if (tp[j] < tp[j - 1]) neg += flow[j]; }
    out[i] = pos === 0 && neg === 0 ? NaN : neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** Candle-based cumulative volume delta PROXY. Bybit/Bitget candles carry no taker-side volume, so volume is split by where the close sits in the range.
 *  It is an approximation, labelled as such everywhere it is shown; exchange-trade CVD is computed separately from recent trades. */
export function cvdProxy(rows: Kline[]): { delta: number[]; cvd: number[] } {
  const delta = rows.map((r) => (r[2] === r[3] ? 0 : r[5] * (((r[4] - r[3]) - (r[2] - r[4])) / (r[2] - r[3])))), cvd: number[] = []; let acc = 0;
  for (const d of delta) { acc += d; cvd.push(acc); }
  return { delta, cvd };
}

export function swingFib(rows: Kline[], lookback = 120) {
  const w = rows.slice(-lookback); if (w.length < 20) return null;
  let hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
  w.forEach((r, i) => { if (r[2] >= hi) { hi = r[2]; hiI = i; } if (r[3] <= lo) { lo = r[3]; loI = i; } });
  if (!(hi > lo)) return null;
  const up = loI < hiI, range = hi - lo, ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const levels = ratios.map((r) => ({ ratio: r, price: up ? hi - range * r : lo + range * r }));
  const ext = [1.272, 1.618].map((r) => ({ ratio: r, price: up ? lo + range * r : hi - range * r }));
  return { direction: up ? "up" : "down" as "up" | "down", high: hi, low: lo, levels, extensions: ext, highTime: w[hiI][0], lowTime: w[loI][0] };
}

export interface Suite {
  n: number; close: number[];
  ema20: number[]; ema50: number[]; ema200: number[]; rsi: number[]; macd: ReturnType<typeof macdSeries>; bb: ReturnType<typeof bollingerSeries>;
  ich: IchimokuResult; st: SupertrendResult; vwap: ReturnType<typeof vwapSession>; cci: number[]; obv: number[]; obvEma: number[]; mfi: number[];
  atr: number[]; adx: ReturnType<typeof adxSeries>; cvd: ReturnType<typeof cvdProxy>;
}
export function computeSuite(rows: Kline[]): Suite {
  const close = rows.map((r) => r[4]), obv = obvSeries(rows);
  return {
    n: rows.length, close, ema20: ema(close, 20), ema50: ema(close, 50), ema200: ema(close, 200), rsi: rsiSeries(close), macd: macdSeries(close), bb: bollingerSeries(close),
    ich: ichimoku(rows), st: supertrend(rows), vwap: vwapSession(rows), cci: cciSeries(rows), obv, obvEma: ema(obv, 20), mfi: mfiSeries(rows), atr: atrSeries(rows, 14),
    adx: adxSeries(rows, 14), cvd: cvdProxy(rows),
  };
}

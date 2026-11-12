// Volume profile from OHLCV candles. Without tick data each candle's volume is spread evenly across the price bins its
// high-low range covers: an approximation that is good for locating value, not for exact auction statistics.
import type { Kline } from "../market.ts";
import { round } from "./types.ts";

export interface ProfileNode { price: number; volume: number }
export interface VolumeProfile {
  poc: number; vah: number; val: number; low: number; high: number; totalVolume: number;
  hvn: number[]; lvn: number[]; bins: ProfileNode[];
  location: "above_value" | "below_value" | "inside_value"; distanceFromPocPct: number; method: string;
}
export function volumeProfile(rows: Kline[], bins = 48, valueAreaPct = 0.7): VolumeProfile | null {
  if (rows.length < 20) return null;
  const lo = Math.min(...rows.map(r => r[3])), hi = Math.max(...rows.map(r => r[2]));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins, vol = new Array(bins).fill(0);
  for (const r of rows) {
    const a = Math.max(0, Math.min(bins - 1, Math.floor((r[3] - lo) / step))), b = Math.max(0, Math.min(bins - 1, Math.floor((r[2] - lo) / step)));
    const per = r[5] / (b - a + 1);
    for (let i = a; i <= b; i++) vol[i] += per;
  }
  const total = vol.reduce((s, v) => s + v, 0);
  let pocI = 0; vol.forEach((v, i) => { if (v > vol[pocI]) pocI = i; });
  // Value area: expand from the POC toward the larger neighbour until valueAreaPct of volume is enclosed.
  let L = pocI, R = pocI, acc = vol[pocI];
  while (acc < valueAreaPct * total && (L > 0 || R < bins - 1)) {
    const lv = L > 0 ? vol[L - 1] : -1, rv = R < bins - 1 ? vol[R + 1] : -1;
    if (rv >= lv) { R++; acc += vol[R]; } else { L--; acc += vol[L]; }
  }
  const mid = (i: number) => lo + step * (i + 0.5);
  const sm = vol.map((v, i) => (v + (vol[i - 1] ?? v) + (vol[i + 1] ?? v)) / 3), mean = total / bins;
  const hvn: number[] = [], lvn: number[] = [];
  for (let i = 1; i < bins - 1; i++) {
    if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] >= 1.3 * mean) hvn.push(round(mid(i), 8));
    if (sm[i] < sm[i - 1] && sm[i] <= sm[i + 1] && sm[i] <= 0.6 * mean) lvn.push(round(mid(i), 8));
  }
  const price = rows.at(-1)![4], vah = lo + step * (R + 1), val = lo + step * L;
  return { poc: round(mid(pocI), 8), vah: round(vah, 8), val: round(val, 8), low: lo, high: hi, totalVolume: total, hvn, lvn,
    bins: vol.map((v, i) => ({ price: round(mid(i), 8), volume: v })), location: price > vah ? "above_value" : price < val ? "below_value" : "inside_value",
    distanceFromPocPct: round((price - mid(pocI)) / price * 100, 3), method: "OHLCV approximation: candle volume distributed evenly across the bins its high-low range spans; value area = 70% of volume around the POC." };
}

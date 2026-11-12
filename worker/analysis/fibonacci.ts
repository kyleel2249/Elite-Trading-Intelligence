// Fibonacci retracements and extensions anchored to the most recent SIGNIFICANT confirmed swing leg (>= 2 ATR).
// Fibonacci levels carry no predictive power by themselves; they are only reported with confluence against other levels.
import type { Kline } from "../market.ts";
import { atr14, lastAtr } from "./atr.ts";
import { round } from "./types.ts";
import type { Pivot } from "./structure.ts";

export const RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
export const EXTENSIONS = [1.0, 1.272, 1.618, 2.0] as const;
export interface FibLevel { ratio: number; price: number; kind: "retracement" | "extension"; confluence: string[] }
export interface FibAnalysis {
  direction: "up_leg" | "down_leg"; swingStart: Pivot; swingEnd: Pivot; legAtr: number;
  retracements: FibLevel[]; extensions: FibLevel[]; currentRetracement: number; nearest: FibLevel | null; inGoldenPocket: boolean; note: string;
}
export function analyzeFibonacci(rows: Kline[], pivots: Pivot[], otherLevels: { label: string; price: number }[] = []): FibAnalysis | null {
  const a = lastAtr(rows), price = rows.at(-1)![4];
  if (!(a > 0) || pivots.length < 2) return null;
  let start: Pivot | null = null, end: Pivot | null = null;
  for (let i = pivots.length - 1; i > 0; i--) {
    const e = pivots[i], s = pivots[i - 1];
    if (e.kind !== s.kind && Math.abs(e.price - s.price) >= 2 * a) { start = s; end = e; break; }
  }
  if (!start || !end) return null;
  const up = end.kind === "high", leg = Math.abs(end.price - start.price);
  const at = (ratio: number, ext: boolean) => (up ? (ext ? start!.price + leg * ratio : end!.price - leg * ratio) : (ext ? start!.price - leg * ratio : end!.price + leg * ratio));
  const conf = (p: number) => otherLevels.filter(o => Math.abs(o.price - p) <= 0.3 * a).map(o => o.label);
  const retr = RETRACEMENTS.map(r => ({ ratio: r, price: at(r, false), kind: "retracement" as const, confluence: conf(at(r, false)) }));
  const ext = EXTENSIONS.map(r => ({ ratio: r, price: at(r, true), kind: "extension" as const, confluence: conf(at(r, true)) }));
  const cur = up ? (end.price - price) / leg : (price - end.price) / leg;
  const all = [...retr, ...ext], nearest = all.reduce((b, l) => (!b || Math.abs(l.price - price) < Math.abs(b.price - price) ? l : b), null as FibLevel | null);
  return { direction: up ? "up_leg" : "down_leg", swingStart: start, swingEnd: end, legAtr: round(leg / a), retracements: retr, extensions: ext, currentRetracement: round(cur, 3), nearest,
    inGoldenPocket: cur >= 0.618 - 0.02 && cur <= 0.65 + 0.02, note: "Fibonacci levels are only treated as meaningful where they coincide with independent levels (confluence); they are not predictive alone." };
}

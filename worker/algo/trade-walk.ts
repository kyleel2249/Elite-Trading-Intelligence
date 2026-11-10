// One implementation of "walk a position through bars": used by the backtest screen and by journal outcome resolution,
// and behaviourally identical to PaperEngine (parity.test.ts). Stops only ever tighten; the stop is tested first on every bar.
import type { Kline } from "../market.ts";
import { manageStop, type TradeLevels } from "./levels.ts";

export const PARTIALS = [0.4, 0.3, 0.3] as const;
export type WalkReason = "stop" | "breakeven" | "trail" | "tp3" | "time" | "end";
export interface WalkResult { exitIdx: number; exit: number; realizedR: number; targetsHit: number; reason: WalkReason; trailed: boolean }

/**
 * @param from    first bar to process (the bar on/after the fill)
 * @param last    last bar allowed (time stop / data end)
 * @param endIdx  index of the final available bar, so a position still open there reports "end" rather than "time"
 * @param targets absolute prices of TP1..TP3 in the trade direction
 */
export function walkPosition(rows: Kline[], from: number, last: number, dir: 1 | -1, entry: number, stop0: number, targets: readonly [number, number, number], feeBuffer: number, endIdx: number = last): WalkResult | null {
  const dist = Math.abs(entry - stop0);
  if (!(dist > 0) || last < from) return null;
  const rOf = (tp: number) => Math.abs(tp - entry) / dist;
  const beStop = entry + dir * feeBuffer, lv = { direction: dir, entry, trailDistance: dist * 1.7 } as unknown as TradeLevels;   // same trail distance PaperEngine uses
  let stop = stop0, hit = 0, rem = 1, realized = 0, trailed = false, highWater = entry, exitIdx = -1, exit = NaN, reason: WalkReason = "end";
  for (let j = from; j <= last; j++) {
    const [, o, h, l, c] = rows[j];
    if (dir > 0 ? l <= stop : h >= stop) { exit = dir > 0 ? Math.min(o, stop) : Math.max(o, stop); exitIdx = j; reason = hit === 0 ? "stop" : trailed ? "trail" : "breakeven"; break; }
    while (hit < 3) {
      const tp = targets[hit];
      if (dir > 0 ? h >= tp : l <= tp) { realized += PARTIALS[hit] * rOf(tp); rem -= PARTIALS[hit]; hit++; } else break;
    }
    if (hit >= 3) { exit = targets[2]; exitIdx = j; reason = "tp3"; rem = 0; break; }
    const m = manageStop(lv, { stop, hitTargets: hit, highWater }, dir > 0 ? h : l, feeBuffer);
    stop = m.stop; highWater = m.highWater;
    if (hit >= 2 && (dir > 0 ? stop > beStop : stop < beStop)) trailed = true;
    if (j === last) { exit = c; exitIdx = j; reason = j === endIdx ? "end" : "time"; }
  }
  if (rem > 1e-9 && Number.isFinite(exit)) realized += rem * ((exit - entry) * dir / dist);
  return { exitIdx, exit, realizedR: realized, targetsHit: hit, reason, trailed };
}

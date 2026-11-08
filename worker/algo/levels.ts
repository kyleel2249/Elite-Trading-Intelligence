// Dynamic entry, stop-loss and three take-profit levels.
import type { Kline } from "../market.ts";
import { atrLevels, type VolClass } from "./indicators.ts";
import type { Structure } from "./timeframes.ts";

export interface TradeLevels {
  direction: 1 | -1; entry: number; entryZone: [number, number]; stop: number; stopDistance: number; stopSource: "atr" | "structure"; stopPercent: number;
  targets: { label: "TP1" | "TP2" | "TP3"; price: number; rewardRisk: number; closeFraction: number; limitedByStructure: boolean }[];
  breakEvenAfter: "TP1"; trailAfter: "TP2"; trailDistance: number; riskRewardToTP3: number; exceedsMaxStop: boolean;
}
export interface LevelOptions { stopMult?: number; maxStopPct?: number; partials?: [number, number, number]; rMultiples?: [number, number, number]; fees?: number }

export function computeLevels(price: number, dir: 1 | -1, atr: number, volClass: VolClass, structure: Structure, o: LevelOptions = {}): TradeLevels {
  const { stopMult = 1.5, maxStopPct = 5, partials = [0.4, 0.3, 0.3], rMultiples = [1.2, 2.2, 3.5] } = o;
  const al = atrLevels(atr, price, volClass, { stop: stopMult, trail: stopMult * 1.7 });
  // Structural invalidation: the nearest swing beyond price on the protective side, with a small ATR buffer.
  const sw = dir > 0 ? structure.support : structure.resistance;
  let dist = al.stopDistance, source: "atr" | "structure" = "atr";
  if (sw !== null) {
    const sd = Math.abs(price - sw) + 0.2 * atr;
    // Only use structure when it is close enough to be meaningful but not tighter than normal noise.
    if (sd >= al.stopDistance * 0.75 && sd <= al.stopDistance * 2.5) { dist = sd; source = "structure"; }
  }
  const stop = price - dir * dist;
  const labels = ["TP1", "TP2", "TP3"] as const;
  const walls = dir > 0 ? structure.resistances : structure.supports;
  const targets = labels.map((label, i) => {
    let tp = price + dir * dist * rMultiples[i], limited = false;
    // Cap at the nearest opposing structure that lies inside the raw target, if it still pays at least 0.6R.
    const wall = walls.find(w => (dir > 0 ? w > price && w < tp : w < price && w > tp));
    if (wall !== undefined) { const capped = wall - dir * 0.001 * price; if (Math.abs(capped - price) >= dist * 0.6) { tp = capped; limited = true; } }
    return { label, price: tp, rewardRisk: Number((Math.abs(tp - price) / dist).toFixed(2)), closeFraction: partials[i], limitedByStructure: limited };
  });
  // Keep targets strictly ordered away from entry.
  for (let i = 1; i < 3; i++) if ((targets[i].price - targets[i - 1].price) * dir <= 0) { targets[i].price = targets[i - 1].price + dir * dist * 0.5; targets[i].rewardRisk = Number((Math.abs(targets[i].price - price) / dist).toFixed(2)); }
  return { direction: dir, entry: price, entryZone: dir > 0 ? [price - 0.25 * atr, price] : [price, price + 0.25 * atr], stop, stopDistance: dist, stopSource: source, stopPercent: dist / price * 100,
    targets, breakEvenAfter: "TP1", trailAfter: "TP2", trailDistance: al.trailDistance, riskRewardToTP3: targets[2].rewardRisk, exceedsMaxStop: dist / price * 100 > maxStopPct };
}

/** Stops may only move toward profit. A request that would widen risk is ignored and the current stop is returned unchanged. */
export function tightenStop(currentStop: number, proposed: number, dir: 1 | -1): number {
  return dir > 0 ? Math.max(currentStop, proposed) : Math.min(currentStop, proposed);
}
export interface ManagedState { stop: number; hitTargets: number; highWater: number }
/** Break-even after TP1, ATR trailing after TP2. Never widens the stop. */
export function manageStop(levels: TradeLevels, state: ManagedState, lastPrice: number, feeBuffer = 0): ManagedState {
  const d = levels.direction;
  const high = d > 0 ? Math.max(state.highWater, lastPrice) : Math.min(state.highWater, lastPrice);
  let stop = state.stop;
  if (state.hitTargets >= 1) stop = tightenStop(stop, levels.entry + d * feeBuffer, d);
  if (state.hitTargets >= 2) stop = tightenStop(stop, high - d * levels.trailDistance, d);
  return { stop, hitTargets: state.hitTargets, highWater: high };
}
export function lastClose(rows: Kline[]) { return rows.at(-1)![4]; }

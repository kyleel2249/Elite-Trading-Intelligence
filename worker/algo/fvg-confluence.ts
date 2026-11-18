// FVG confluence for the signal pipeline (analytical, read-only).
// A Fair Value Gap is evidence, never a trigger: this module is only consulted AFTER the fused trade has passed validation, it can only
// nudge the heuristic confidence score by a bounded amount (+/-MAX_DELTA) and attach an ADVISORY entry-optimisation note. It cannot create,
// flip, upgrade or downgrade a decision, and it never edits the entry zone, stop-loss or take-profits that the risk engine produced.
import type { Kline } from "../market.ts";
import { analyzeFvgMtf, FVG_TF_MS, type FvgZone } from "../analysis/fvg.ts";
import { fvgMtfAlignmentPoints } from "../analysis/fvg-intel.ts";
import { findPivots, analyzeStructure } from "../analysis/structure.ts";
import { detectLiquiditySweeps, detectOrderBlocks } from "../analysis/smc.ts";
import { atrSeries } from "./indicators.ts";
import { round } from "../analysis/types.ts";
import { analyzeFvgPrecision, type FvgPrecisionResult } from "../analysis/fvg-precision.ts";

export const FVG_MAX_CONFIDENCE_DELTA = 8;
export interface FvgFactor { name: string; points: number; detail: string }
export interface FvgEntryOptimization {
  /** Advisory limit-entry price: the 50% level (consequent encroachment) of a supporting active FVG that lies between the stop and the planned entry. */
  price: number; zone: [number, number]; timeframe: string; rewardRiskTP1: number | null; plannedRewardRiskTP1: number | null; note: string;
}
export interface FvgConfluence {
  available: boolean; stance: "supports" | "opposes" | "neutral"; confidenceDelta: number; score: number; factors: FvgFactor[];
  supporting: FvgZoneBrief[]; opposing: FvgZoneBrief[]; entryOptimization: FvgEntryOptimization | null;
  /** Active (unfilled or partially filled) gaps considered, by direction, and the timeframes they sit on. */
  unfilled?: { bullish: number; bearish: number; partial: number; timeframes: string[] };\n  /** Full qualification, entry, invalidation and target analysis. Advisory only; never changes the fused order plan. */\n  precision: FvgPrecisionResult | null;
  summary: string; canTriggerTrade: false; advisoryOnly: true;
}
export interface FvgZoneBrief { id: string; timeframe: string; direction: "bullish" | "bearish"; upper: number; lower: number; mid: number; sizeAtr: number; strength: number; status: string; mitigationPct: number; confluence: number; distanceAtr: number }
export interface FvgPlan { entryZone: [number, number] | null; stopLoss: number | null; takeProfits: { price: number; rewardRisk?: number }[] | null }

const EMPTY = (summary: string): FvgConfluence => ({ available: false, stance: "neutral", confidenceDelta: 0, score: 0, factors: [], supporting: [], opposing: [], entryOptimization: null, precision: null, summary, canTriggerTrade: false, advisoryOnly: true });
const brief = (z: FvgZone, price: number, atr: number): FvgZoneBrief => ({ id: z.id, timeframe: z.timeframe, direction: z.direction, upper: z.upper, lower: z.lower, mid: z.mid, sizeAtr: z.sizeAtr, strength: z.strength, status: z.status, mitigationPct: z.mitigationPct, confluence: z.confluence.length, distanceAtr: round((price > z.upper ? price - z.upper : price < z.lower ? z.lower - price : 0) / atr, 2) });
const overlaps = (aLo: number, aHi: number, bLo: number, bHi: number) => Math.min(aHi, bHi) > Math.max(aLo, bLo);

/**
 * Weighs the active FVGs on the execution timeframe and the higher timeframes against a proposed trade direction.
 * `rowsByTf` holds closed-and-forming candles per timeframe; only the execution timeframe and higher ones are used.
 */
export function assessFvgConfluence(rowsByTf: Partial<Record<string, Kline[]>>, execTf: string, dir: 1 | -1, plan: FvgPlan, now: number): FvgConfluence {
  const rows = rowsByTf[execTf];
  if (!rows || rows.length < 30 || !FVG_TF_MS[execTf]) return EMPTY(`FVG analysis unavailable: fewer than 30 ${execTf} candles`);
  const inputs = Object.entries(rowsByTf).filter(([tf, r]) => r && r.length >= 30 && FVG_TF_MS[tf] >= FVG_TF_MS[execTf]).map(([timeframe, r]) => ({ timeframe, rows: r! }));
  const price = rows.at(-1)![4], atrNow = atrSeries(rows).at(-1)!;
  if (!(atrNow > 0)) return EMPTY("FVG analysis unavailable: ATR is not defined yet");
  const mtf = analyzeFvgMtf(execTf, inputs, { now, price, atr: atrNow, maxZones: 40, window: 200 });
  const wantDir = dir > 0 ? "bullish" : "bearish";
  const active = mtf.zones.filter(z => z.active);
  const factors: FvgFactor[] = [];
  const add = (name: string, points: number, detail: string) => { if (points !== 0) factors.push({ name, points: round(points, 2), detail }); };
  const tfw = (z: FvgZone) => 0.6 + 0.4 * (z.timeframe === execTf ? 0.5 : 1);

  // Supporting zones: same direction as the trade, on the near side of price (a bullish gap at/below price for a BUY, a bearish gap at/above for a SELL), within 3 ATR.
  const near = (z: FvgZone) => (price > z.upper ? price - z.upper : price < z.lower ? z.lower - price : 0) / atrNow;
  const supporting = active.filter(z => z.direction === wantDir && (dir > 0 ? z.lower <= price : z.upper >= price) && near(z) <= 3).sort((a, b) => b.relevance - a.relevance);
  const best = supporting[0];
  if (best) {
    const proximity = 1 - Math.min(1, near(best) / 3) * 0.5;
    const pts = (best.strength / 100) * 3 * tfw(best) * proximity;
    add("supporting FVG", pts, `${best.timeframe} ${best.direction} gap ${best.lower}-${best.upper} (strength ${best.strength}, ${best.status.replace("_", " ")}, ${round(near(best), 2)} ATR from price)`);
    if (best.confluence.length) add("multi-timeframe confluence", Math.min(2, best.confluence.length), `overlaps ${best.confluence.map(c => c.timeframe).join(", ")} gap(s)`);
    if (best.status === "partially_mitigated" && best.mitigationPct >= 75) add("mostly filled", -1, `only ${100 - best.mitigationPct}% of the supporting gap is left`);
  }

  // Opposing zones: an active gap of the other direction that sits in the trade's path (between price and the first target, or containing price).
  const tp1 = plan.takeProfits?.[0]?.price;
  const opposing = active.filter(z => z.direction !== wantDir && (dir > 0 ? z.upper >= price : z.lower <= price) && near(z) <= 3 && (tp1 === undefined || (dir > 0 ? z.lower <= tp1 : z.upper >= tp1))).sort((a, b) => b.relevance - a.relevance);
  const worst = opposing[0];
  if (worst) add("opposing FVG in the path", -(worst.strength / 100) * 3 * tfw(worst) * (1 - Math.min(1, near(worst) / 3) * 0.5), `${worst.timeframe} ${worst.direction} gap ${worst.lower}-${worst.upper} (strength ${worst.strength}) between price and the first target`);
  if (opposing.length > 1) add("additional opposing FVGs", -Math.min(1, (opposing.length - 1) * 0.5), `${opposing.length - 1} more opposing gap(s) ahead`);

  // Multi-timeframe alignment of unfilled gaps: several timeframes leaving an unfilled gap on the same side of the trade is stronger evidence than one.
  const align = fvgMtfAlignmentPoints(supporting.map(z => z.timeframe), opposing.map(z => z.timeframe));
  if (align.points !== 0) add("multi-timeframe unfilled-gap alignment", align.points, align.detail);

  // Structure context on the execution timeframe: BOS, liquidity sweeps, order blocks. Each is one point and only counts when it agrees with the same-direction gap.
  const n = rows.length;
  const pivots = findPivots(rows), structure = analyzeStructure(rows, pivots);
  const recent = (i: number) => n - 1 - i <= 20;
  const bos = structure.events.filter(e => e.type === "BOS" && recent(e.index)).at(-1);
  if (bos) add("break of structure", bos.direction === wantDir ? 1 : -1, `${bos.direction} BOS within the last 20 candles`);
  const sweep = detectLiquiditySweeps(rows, pivots, 30).filter(s => s.reclaimed && recent(s.index)).at(-1);
  if (sweep) add("liquidity sweep", sweep.direction === wantDir ? 1 : -1, `${sweep.side.replace("_", "-")} liquidity swept at ${sweep.level} and reclaimed (${sweep.direction} trap)`);
  const obs = detectOrderBlocks(rows, 80).filter(o => !o.mitigated && !o.invalidated);
  if (best) {
    const ob = obs.find(o => o.kind === wantDir && overlaps(o.low, o.high, best.lower, best.upper));
    if (ob) add("order block + FVG", 1, `${ob.kind} order block ${ob.low}-${ob.high} overlaps the supporting gap`);
  }

  const raw = factors.reduce((s, f) => s + f.points, 0);
  const delta = Math.round(Math.max(-FVG_MAX_CONFIDENCE_DELTA, Math.min(FVG_MAX_CONFIDENCE_DELTA, raw)));
  const stance: FvgConfluence["stance"] = delta >= 2 ? "supports" : delta <= -2 ? "opposes" : "neutral";

  // Advisory entry optimisation: a limit order at the CE of a supporting gap that lies between the stop and the planned entry improves reward:risk.
  let entryOptimization: FvgEntryOptimization | null = null;
  if (plan.entryZone && plan.stopLoss !== null && plan.takeProfits?.length) {
    const entry = (plan.entryZone[0] + plan.entryZone[1]) / 2, stop = plan.stopLoss, risk = Math.abs(entry - stop);
    const cand = supporting.find(z => (dir > 0 ? z.mid < entry && z.mid > stop : z.mid > entry && z.mid < stop) && Math.abs(z.mid - stop) >= 0.4 * risk);
    if (cand && tp1 !== undefined) {
      const rr = (p: number) => round(Math.abs(tp1 - p) / Math.abs(p - stop), 2);
      entryOptimization = { price: round(cand.mid, 8), zone: [cand.lower, cand.upper], timeframe: cand.timeframe, rewardRiskTP1: rr(cand.mid), plannedRewardRiskTP1: rr(entry),
        note: `Optional limit entry at the midpoint of the ${cand.timeframe} ${cand.direction} gap improves reward:risk to TP1 from ${rr(entry)} to ${rr(cand.mid)}; the price may never retrace there, so the planned entry, stop and targets are unchanged.` };
    }
  }

  const label = (z: FvgZone) => `${z.timeframe} ${z.direction} ${z.lower}-${z.upper}`;
  const summary = !active.length ? "No active fair value gaps near price." : `FVG ${stance}${delta ? ` (${delta > 0 ? "+" : ""}${delta} confidence)` : ""}: ${best ? `supported by ${label(best)}` : "no supporting gap nearby"}${worst ? `; opposed by ${label(worst)}` : ""}.`;
  const unfilled = { bullish: active.filter(z => z.direction === "bullish").length, bearish: active.filter(z => z.direction === "bearish").length, partial: active.filter(z => z.status === "partially_mitigated").length, timeframes: [...new Set(active.map(z => z.timeframe))] };
  const closedByTf: Partial<Record<string, Kline[]>> = {};
  for (const [tf, data] of Object.entries(rowsByTf)) {
    if (!data || !FVG_TF_MS[tf]) continue;
    let end = data.length;
    while (end > 0 && data[end - 1][0] + FVG_TF_MS[tf] > now) end--;
    closedByTf[tf] = data.slice(0, end);
  }
  const precision = analyzeFvgPrecision(closedByTf[execTf] ?? [], execTf, {
    higherTimeframes: Object.fromEntries(Object.entries(closedByTf).filter(([tf]) => tf !== execTf)),
  });
  const precisionSummary = precision.best ? ` Precision engine: ${precision.best.direction} ${precision.best.state} at ${precision.best.entry.price}.` : " Precision engine: no fully qualified entry; wait.";
  return { available: true, stance, confidenceDelta: delta, score: round(raw, 2), factors, supporting: supporting.slice(0, 3).map(z => brief(z, price, atrNow)), opposing: opposing.slice(0, 3).map(z => brief(z, price, atrNow)), entryOptimization, precision, unfilled, summary: summary + precisionSummary, canTriggerTrade: false, advisoryOnly: true };
}

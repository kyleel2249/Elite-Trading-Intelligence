// Unified Smart Money Concepts detections with auditable metadata.
// This module EXTENDS smc.ts / structure.ts: it re-uses their detectors and adds (a) a common detection record carrying timeframe,
// confirmation status, source candles, invalidation and an evidence-quality confidence, (b) inverse fair value gaps and
// (c) premium / discount / equilibrium zones. Callers must pass CLOSED candles only; nothing here can submit an order.
import type { Kline } from "../market.ts";
import { lastAtr } from "./atr.ts";
import { clamp, round } from "./types.ts";
import { analyzeStructure, findPivots, type MarketStructure } from "./structure.ts";
import { detectFVG, detectLiquiditySweeps, detectOrderBlocks, findLiquidityPools, SMC_RULES, type FairValueGap } from "./smc.ts";

export type SmcKind = "order_block" | "fair_value_gap" | "inverse_fvg" | "bos" | "choch" | "liquidity_pool" | "liquidity_sweep";
export type SmcDirection = "bullish" | "bearish" | "neutral";
export type SmcState = "active" | "mitigated" | "open" | "partially_filled" | "filled" | "invalidated" | "swept" | "reclaimed";
export const SMC_MIN_CANDLES = 30;
/** Confidence is a transparent sum of evidence points, capped well below certainty. It is not a probability of a reaction. */
export const SMC_CONFIDENCE_CAP = 85;

export interface SmcDetection {
  id: string;
  kind: SmcKind;
  direction: SmcDirection;
  timeframe: string;
  zone: { low: number; high: number };
  /** Open time (ms) of the candle that anchors the detection. */
  time: number;
  /** Open times (ms) of the closed candles the detection was derived from. */
  sourceCandleTimes: number[];
  confirmation: "confirmed" | "unconfirmed";
  confirmationReason: string;
  state: SmcState;
  invalidation: { price: number; condition: string };
  confidence: number;
  confidenceType: "evidence_quality_not_probability";
  /** Closed bars between the anchor candle and the latest closed candle. */
  freshnessBars: number;
  evidence: string[];
}
export interface PremiumDiscount {
  timeframe: string;
  rangeHigh: number; rangeLow: number; equilibrium: number; price: number;
  /** 0 = range low, 100 = range high; outside 0..100 means price has left the range. */
  positionPct: number;
  zone: "premium" | "discount" | "equilibrium";
  outsideRange: boolean;
  basis: { highTime: number; lowTime: number };
}
export interface SmcAnalysis {
  timeframe: string;
  status: "ready" | "insufficient_history";
  candles: number;
  lastClosedTime: number | null;
  price: number | null;
  trend: MarketStructure["trend"] | "undetermined";
  stance: MarketStructure["stance"] | "neutral";
  detections: SmcDetection[];
  premiumDiscount: PremiumDiscount | null;
  reason?: string;
  canTriggerTrade: false; submitsOrder: false; liveExecutionAllowed: false;
}

const cap = (n: number) => clamp(Math.round(n), 0, SMC_CONFIDENCE_CAP);
const mk = (d: Omit<SmcDetection, "confidenceType" | "confidence"> & { points: number }): SmcDetection => {
  const { points, ...rest } = d;
  return { ...rest, confidence: cap(points), confidenceType: "evidence_quality_not_probability" };
};

/** Inverse FVG: a gap that price CLOSED completely through. The gap flips polarity and may then act as support/resistance from the other side. */
export function detectInverseFvg(rows: Kline[], gaps: FairValueGap[]): { gap: FairValueGap; flippedAt: number; direction: "bullish" | "bearish"; stillValid: boolean }[] {
  const out: { gap: FairValueGap; flippedAt: number; direction: "bullish" | "bearish"; stillValid: boolean }[] = [];
  for (const g of gaps) {
    let flippedAt = -1;
    for (let k = g.index + 2; k < rows.length; k++) {
      const close = rows[k][4];
      if (g.kind === "bullish" ? close < g.low : close > g.high) { flippedAt = k; break; }
    }
    if (flippedAt < 0) continue;
    const direction = g.kind === "bullish" ? "bearish" : "bullish";
    let stillValid = true;
    for (let k = flippedAt + 1; k < rows.length; k++) {
      const close = rows[k][4];
      // The flipped zone fails when price closes back through its far side.
      if (direction === "bearish" ? close > g.high : close < g.low) { stillValid = false; break; }
    }
    out.push({ gap: g, flippedAt, direction, stillValid });
  }
  return out;
}

export function premiumDiscount(rows: Kline[], timeframe: string, eqBandPct = 5): PremiumDiscount | null {
  const pivots = findPivots(rows);
  const hi = [...pivots].reverse().find(p => p.kind === "high"), lo = [...pivots].reverse().find(p => p.kind === "low");
  if (!hi || !lo || !(hi.price > lo.price)) return null;
  const price = rows[rows.length - 1][4], pos = ((price - lo.price) / (hi.price - lo.price)) * 100;
  const zone = Math.abs(pos - 50) <= eqBandPct ? "equilibrium" : pos > 50 ? "premium" : "discount";
  return { timeframe, rangeHigh: hi.price, rangeLow: lo.price, equilibrium: round((hi.price + lo.price) / 2, 8), price, positionPct: round(pos, 1), zone, outsideRange: pos < 0 || pos > 100, basis: { highTime: hi.time, lowTime: lo.time } };
}

export function analyzeSmc(rows: Kline[], timeframe: string, opts: { window?: number; includeFilled?: boolean } = {}): SmcAnalysis {
  const flags = { canTriggerTrade: false as const, submitsOrder: false as const, liveExecutionAllowed: false as const };
  if (rows.length < SMC_MIN_CANDLES) return { timeframe, status: "insufficient_history", candles: rows.length, lastClosedTime: rows.length ? rows[rows.length - 1][0] : null, price: rows.length ? rows[rows.length - 1][4] : null, trend: "undetermined", stance: "neutral", detections: [], premiumDiscount: null, reason: `At least ${SMC_MIN_CANDLES} closed candles are required (got ${rows.length}).`, ...flags };
  const n = rows.length, last = n - 1, window = opts.window ?? 120, atr = lastAtr(rows);
  const pivots = findPivots(rows), structure = analyzeStructure(rows, pivots);
  const fresh = (i: number) => Math.max(0, last - i);
  const dets: SmcDetection[] = [];

  // Fair value gaps. Three closed candles define the gap, so it is confirmed by construction.
  const gaps = detectFVG(rows, window);
  for (const g of gaps) {
    const state: SmcState = g.status === "filled" ? "filled" : g.status === "partially_filled" ? "partially_filled" : "open";
    if (state === "filled" && !opts.includeFilled) continue;
    const ev = [`Three-candle imbalance of ${g.sizeAtr} ATR`, `${g.filledPct}% filled by later wicks`];
    let pts = 40 + Math.min(20, g.sizeAtr * 10);
    if (state === "open") { pts += 15; ev.push("Untested since formation"); } else if (state === "partially_filled") pts -= 5;
    dets.push(mk({ id: `fvg:${timeframe}:${g.kind}:${g.time}`, kind: "fair_value_gap", direction: g.kind, timeframe, zone: { low: g.low, high: g.high }, time: g.time, sourceCandleTimes: [rows[g.index - 1]?.[0], rows[g.index][0], rows[g.index + 1]?.[0]].filter((t): t is number => typeof t === "number"), confirmation: "confirmed", confirmationReason: "All three candles are closed", state, invalidation: { price: g.kind === "bullish" ? g.low : g.high, condition: g.kind === "bullish" ? "A close below the gap low turns it into an inverse (bearish) FVG" : "A close above the gap high turns it into an inverse (bullish) FVG" }, freshnessBars: fresh(g.index + 1), evidence: ev, points: pts }));
  }

  // Inverse FVGs (always computed from the unfiltered gap set so a filled gap can still flip).
  const allGaps = opts.includeFilled ? gaps : detectFVG(rows, window);
  for (const f of detectInverseFvg(rows, allGaps)) {
    const g = f.gap, ev = [`${g.kind} gap closed through at ${new Date(rows[f.flippedAt][0]).toISOString()}`, f.stillValid ? "Flipped zone has not been closed back through" : "Flipped zone was later closed back through"];
    dets.push(mk({ id: `ifvg:${timeframe}:${f.direction}:${g.time}`, kind: "inverse_fvg", direction: f.direction, timeframe, zone: { low: g.low, high: g.high }, time: g.time, sourceCandleTimes: [rows[g.index][0], rows[f.flippedAt][0]], confirmation: "confirmed", confirmationReason: "Polarity flip confirmed by a closed candle beyond the gap", state: f.stillValid ? "active" : "invalidated", invalidation: { price: f.direction === "bearish" ? g.high : g.low, condition: f.direction === "bearish" ? "A close above the gap high invalidates the bearish inversion" : "A close below the gap low invalidates the bullish inversion" }, freshnessBars: fresh(f.flippedAt), evidence: ev, points: f.stillValid ? 45 + Math.min(15, g.sizeAtr * 8) : 15 }));
  }

  // Order blocks. The detector already requires a displacement and a structure break and drops invalidated blocks.
  for (const ob of detectOrderBlocks(rows, window)) {
    const unconf = ob.displacementIndex >= last;
    const ev = ["Last opposing candle before a displacement that broke prior 12-bar structure", ob.hasFVG ? "Displacement left a fair value gap" : "No fair value gap with the displacement (lower grade)", ob.touches === 0 ? "Not revisited (fresh)" : `Revisited ${ob.touches} time(s)`];
    let pts = 40 + (ob.hasFVG ? 20 : 0) + (ob.touches === 0 ? 15 : 0) - Math.min(15, ob.touches * 5);
    if (unconf) pts -= 15;
    dets.push(mk({ id: `ob:${timeframe}:${ob.kind}:${ob.time}`, kind: "order_block", direction: ob.kind, timeframe, zone: { low: ob.low, high: ob.high }, time: ob.time, sourceCandleTimes: [rows[ob.index][0], rows[ob.displacementIndex][0]], confirmation: unconf ? "unconfirmed" : "confirmed", confirmationReason: unconf ? "The displacement candle is the latest closed candle; there is no follow-through candle yet" : "Displacement followed by at least one further closed candle without invalidation", state: ob.mitigated ? "mitigated" : "active", invalidation: { price: ob.kind === "bullish" ? ob.low : ob.high, condition: ob.kind === "bullish" ? "A close below the block low invalidates it" : "A close above the block high invalidates it" }, freshnessBars: fresh(ob.index), evidence: ev, points: pts }));
  }

  // Structure events: BOS / CHoCH come from confirmed pivots and closes.
  for (const e of structure.events.slice(-8)) {
    dets.push(mk({ id: `${e.type.toLowerCase()}:${timeframe}:${e.direction}:${e.time}`, kind: e.type === "BOS" ? "bos" : "choch", direction: e.direction, timeframe, zone: { low: e.level, high: e.level }, time: e.time, sourceCandleTimes: [e.time], confirmation: "confirmed", confirmationReason: "Close beyond a confirmed swing", state: "active", invalidation: { price: e.level, condition: e.direction === "bullish" ? "A close back below the broken level" : "A close back above the broken level" }, freshnessBars: fresh(e.index), evidence: [e.note], points: e.type === "CHoCH" ? 50 : 55 }));
  }

  // Liquidity pools (equal highs / lows) and confirmed sweeps.
  if (atr > 0) for (const p of findLiquidityPools(rows, pivots)) {
    const kind = p.side === "buy_side" ? "high" : "low";
    const touching = pivots.filter(v => v.kind === kind && Math.abs(v.price - p.price) <= SMC_RULES.equalLevelAtr * atr * 2);
    const newest = touching.length ? Math.max(...touching.map(t => t.index)) : last;
    let swept = false; for (let k = newest + 1; k < rows.length; k++) if (p.side === "buy_side" ? rows[k][2] > p.price : rows[k][3] < p.price) { swept = true; break; }
    dets.push(mk({ id: `pool:${timeframe}:${p.side}:${round(p.price, 8)}`, kind: "liquidity_pool", direction: "neutral", timeframe, zone: { low: p.price, high: p.price }, time: touching.length ? rows[newest][0] : rows[last][0], sourceCandleTimes: touching.map(t => t.time), confirmation: "confirmed", confirmationReason: "Equal pivots within 0.15 ATR", state: swept ? "swept" : "open", invalidation: { price: p.price, condition: p.side === "buy_side" ? "Price trading above the level takes the resting liquidity (sweep)" : "Price trading below the level takes the resting liquidity (sweep)" }, freshnessBars: fresh(newest), evidence: [`${p.touches} equal ${kind === "high" ? "highs" : "lows"} (${p.side.replace("_", "-")} liquidity)`], points: 35 + Math.min(30, p.touches * 10) }));
  }
  for (const s of detectLiquiditySweeps(rows, pivots, 40)) {
    const r = rows[s.index];
    dets.push(mk({ id: `sweep:${timeframe}:${s.side}:${s.time}`, kind: "liquidity_sweep", direction: s.direction, timeframe, zone: { low: s.level, high: s.level }, time: s.time, sourceCandleTimes: [s.time], confirmation: "confirmed", confirmationReason: "Wick through the level and a close back inside within two bars", state: "reclaimed", invalidation: { price: s.direction === "bullish" ? r[3] : r[2], condition: s.direction === "bullish" ? "A close below the sweep wick low" : "A close above the sweep wick high" }, freshnessBars: fresh(s.index), evidence: [s.note], points: 50 }));
  }
  dets.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  return { timeframe, status: "ready", candles: n, lastClosedTime: rows[last][0], price: rows[last][4], trend: structure.trend, stance: structure.stance, detections: dets, premiumDiscount: premiumDiscount(rows, timeframe), ...flags };
}

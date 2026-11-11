// Displacement, fair value gaps, liquidity sweeps and order blocks. Each has an explicit, testable definition.
// These are descriptive price-action constructs; none of them is a guarantee of reaction.
import type { Kline } from "../market.ts";
import { atr14, lastAtr } from "./atr.ts";
import { round } from "./types.ts";
import type { Pivot } from "./structure.ts";

export const SMC_RULES = { displacementBodyAtr: 1.3, displacementBodyShare: 0.65, fvgMinAtr: 0.15, sweepReturnBars: 2, equalLevelAtr: 0.15, obLookahead: 5, obStructureLookback: 12 } as const;

// ---------- displacement ----------
export interface Displacement { index: number; time: number; direction: "bullish" | "bearish"; bodyAtr: number; volumeRatio: number }
/** Methodology: a candle with body >= 1.3 ATR AND body >= 65% of its range = displacement (one-sided, aggressive move). Volume ratio is vs the prior 20-bar mean. */
export function detectDisplacement(rows: Kline[], window = 40): Displacement[] {
  const atr = atr14(rows), out: Displacement[] = [];
  for (let i = Math.max(21, rows.length - window); i < rows.length; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    const r = rows[i], b = Math.abs(r[4] - r[1]), rg = r[2] - r[3];
    if (b >= SMC_RULES.displacementBodyAtr * a && rg > 0 && b / rg >= SMC_RULES.displacementBodyShare) {
      let vs = 0; for (let q = i - 20; q < i; q++) vs += rows[q][5]; const vm = vs / 20 || 1;
      out.push({ index: i, time: r[0], direction: r[4] > r[1] ? "bullish" : "bearish", bodyAtr: round(b / a), volumeRatio: round(r[5] / vm) });
    }
  }
  return out;
}

// ---------- fair value gaps ----------
export interface FairValueGap { kind: "bullish" | "bearish"; low: number; high: number; index: number; time: number; sizeAtr: number; filledPct: number; status: "open" | "partially_filled" | "filled" }
/** Methodology: 3-candle imbalance. Bullish FVG = high[n-2] < low[n] (gap between candle 1's high and candle 3's low); bearish mirrored. Min size 0.15 ATR. Fill is tracked by later wicks. */
export function detectFVG(rows: Kline[], window = 80): FairValueGap[] {
  const atr = atr14(rows), out: FairValueGap[] = [];
  for (let i = Math.max(2, rows.length - window); i < rows.length; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    const c1 = rows[i - 2], c3 = rows[i];
    let kind: FairValueGap["kind"] | null = null, lo = 0, hi = 0;
    if (c1[2] < c3[3]) { kind = "bullish"; lo = c1[2]; hi = c3[3]; }
    else if (c1[3] > c3[2]) { kind = "bearish"; lo = c3[2]; hi = c1[3]; }
    if (!kind || hi - lo < SMC_RULES.fvgMinAtr * a) continue;
    let fill = 0;
    for (let k = i + 1; k < rows.length; k++) {
      const pen = kind === "bullish" ? hi - rows[k][3] : rows[k][2] - lo;
      fill = Math.max(fill, Math.min(1, Math.max(0, pen / (hi - lo))));
      if (fill >= 1) break;
    }
    out.push({ kind, low: lo, high: hi, index: i - 1, time: rows[i - 1][0], sizeAtr: round((hi - lo) / a), filledPct: round(fill * 100, 0), status: fill >= 1 ? "filled" : fill > 0 ? "partially_filled" : "open" });
  }
  return out;
}

// ---------- liquidity ----------
export interface LiquidityPool { side: "buy_side" | "sell_side"; price: number; touches: number }
export interface LiquiditySweep { side: "buy_side" | "sell_side"; level: number; index: number; time: number; reclaimed: boolean; direction: "bearish" | "bullish"; note: string }
/**
 * Methodology: liquidity pools sit above equal highs (buy-side) and below equal lows (sell-side): >= 2 pivots within 0.15 ATR.
 * A SWEEP is a wick through a pool/swing extreme followed by a CLOSE back inside within 2 bars. A sweep that reclaims is a potential reversal trap
 * (bearish after a buy-side sweep, bullish after a sell-side sweep). A close that holds beyond the level is a breakout, not a sweep.
 */
export function findLiquidityPools(rows: Kline[], pivots: Pivot[]): LiquidityPool[] {
  const a = lastAtr(rows), pools: LiquidityPool[] = [];
  if (!(a > 0)) return pools;
  for (const kind of ["high", "low"] as const) {
    const ps = pivots.filter(p => p.kind === kind).sort((x, y) => x.price - y.price);
    let group: Pivot[] = [];
    const flush = () => { if (group.length >= 2) pools.push({ side: kind === "high" ? "buy_side" : "sell_side", price: kind === "high" ? Math.max(...group.map(g => g.price)) : Math.min(...group.map(g => g.price)), touches: group.length }); group = []; };
    for (const p of ps) { if (group.length && p.price - group[group.length - 1].price > SMC_RULES.equalLevelAtr * a) flush(); group.push(p); }
    flush();
  }
  return pools;
}
export function detectLiquiditySweeps(rows: Kline[], pivots: Pivot[], window = 30): LiquiditySweep[] {
  const out: LiquiditySweep[] = [], pools = findLiquidityPools(rows, pivots), n = rows.length;
  const targets: { side: LiquiditySweep["side"]; price: number; since: number }[] = [
    ...pools.map(p => ({ side: p.side, price: p.price, since: 0 })),
    ...pivots.map(p => ({ side: p.kind === "high" ? "buy_side" as const : "sell_side" as const, price: p.price, since: p.index + 3 })),
  ];
  const seen = new Set<string>();
  for (let i = Math.max(5, n - window); i < n; i++) for (const t of targets) {
    if (i <= t.since) continue;
    const r = rows[i], pierce = t.side === "buy_side" ? r[2] > t.price : r[3] < t.price;
    if (!pierce) continue;
    // The level must still have been intact before this bar (no earlier close beyond it since it formed).
    let intact = true; for (let q = Math.max(t.since, 0); q < i; q++) { const c = rows[q][4]; if (t.side === "buy_side" ? c > t.price : c < t.price) { intact = false; break; } }
    if (!intact) continue;
    const window2 = rows.slice(i, i + SMC_RULES.sweepReturnBars + 1);
    const reclaimed = window2.some(x => (t.side === "buy_side" ? x[4] < t.price : x[4] > t.price));
    const closedBeyond = t.side === "buy_side" ? r[4] > t.price : r[4] < t.price;
    if (!reclaimed) continue;
    const key = `${t.side}:${round(t.price, 6)}:${i}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ side: t.side, level: t.price, index: i, time: r[0], reclaimed: true, direction: t.side === "buy_side" ? "bearish" : "bullish",
      note: `${t.side === "buy_side" ? "Highs" : "Lows"} at ${round(t.price, 4)} were swept${closedBeyond ? " (closed beyond, then reclaimed)" : " by a wick"} and price returned inside the range` });
  }
  // keep the most significant sweep per bar/side
  const best = new Map<string, LiquiditySweep>();
  for (const s of out) { const k = `${s.index}:${s.side}`; const cur = best.get(k); if (!cur || (s.side === "buy_side" ? s.level > cur.level : s.level < cur.level)) best.set(k, s); }
  return [...best.values()].sort((a, b) => a.index - b.index);
}

// ---------- order blocks ----------
export interface OrderBlock { kind: "bullish" | "bearish"; high: number; low: number; mean: number; index: number; time: number; displacementIndex: number; hasFVG: boolean; breaksStructure: boolean; mitigated: boolean; invalidated: boolean; touches: number }
export const ORDER_BLOCK_METHOD = "Bullish order block = the LAST bearish (down-close) candle before a bullish displacement that closes above the highest high of the prior 12 bars (structure break). Bearish order block is the mirror. Zone = that candle's full high-low range; its 50% 'mean threshold' is reported. A block is mitigated once price trades back into the zone and invalidated once a CLOSE passes through the far side. Blocks need displacement AND a structure break; blocks without a gap (FVG) are lower grade. This is a descriptive definition, not evidence that institutions placed orders.";
export function detectOrderBlocks(rows: Kline[], window = 80): OrderBlock[] {
  const disp = detectDisplacement(rows, window), out: OrderBlock[] = [];
  const fvgs = detectFVG(rows, window + 5);
  for (const d of disp) {
    const lb = rows.slice(Math.max(0, d.index - SMC_RULES.obStructureLookback), d.index);
    if (lb.length < 5) continue;
    const r = rows[d.index];
    const breaks = d.direction === "bullish" ? r[4] > Math.max(...lb.map(x => x[2])) : r[4] < Math.min(...lb.map(x => x[3]));
    if (!breaks) continue;
    let k = d.index - 1;
    while (k >= Math.max(0, d.index - 6) && (d.direction === "bullish" ? !(rows[k][4] < rows[k][1]) : !(rows[k][4] > rows[k][1]))) k--;
    if (k < 0 || k < d.index - 6) continue;
    const c = rows[k], hi = c[2], lo = c[3];
    let touches = 0, mitigated = false, invalidated = false, inside = false;
    for (let j = d.index + 1; j < rows.length; j++) {
      const x = rows[j], enters = d.direction === "bullish" ? x[3] <= hi : x[2] >= lo;
      if (enters && !inside) { touches++; mitigated = true; inside = true; } else if (!enters) inside = false;
      if (d.direction === "bullish" ? x[4] < lo : x[4] > hi) { invalidated = true; break; }
    }
    const hasFVG = fvgs.some(f => f.kind === d.direction && f.index >= d.index - 1 && f.index <= d.index + 1);
    out.push({ kind: d.direction, high: hi, low: lo, mean: (hi + lo) / 2, index: k, time: c[0], displacementIndex: d.index, hasFVG, breaksStructure: true, mitigated, invalidated, touches });
  }
  return out.filter(o => !o.invalidated);
}

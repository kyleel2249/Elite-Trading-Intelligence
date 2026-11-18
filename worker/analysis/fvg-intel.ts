// FVG intelligence layer: lifecycle classification, history registry, dashboard summary, cross-market agreement and MTF alignment.
// Pure functions and one in-memory class, no I/O. It EXTENDS worker/analysis/fvg.ts (which still owns detection) and never changes its output.
// The browser mirror lives in worker/ui/fvg-intel-layer.ts; worker/fvg-intel.test.ts requires both to agree.
import type { Kline } from "../market.ts";
import { FVG_RULES, FVG_TF_MS, type FvgStatus, type FvgZone } from "./fvg.ts";

export type FvgLifecycle = "unfilled" | "partially_filled" | "filled_pending" | "filled" | "invalidated" | "expired";

export const FVG_LIFECYCLE_TEXT: Record<FvgLifecycle, string> = {
  unfilled: "UNFILLED", partially_filled: "PARTIALLY FILLED", filled_pending: "FILL PENDING CLOSE", filled: "FILLED", invalidated: "INVALIDATED", expired: "EXPIRED",
};

/** Open time of the candle that is still forming, or null when the last candle has closed. */
export function formingOpenTime(rows: Kline[], timeframeMs: number | undefined, now: number | undefined): number | null {
  const last = rows.length ? rows[rows.length - 1] : undefined;
  if (!last || !timeframeMs || now === undefined) return null;
  return last[0] + timeframeMs > now ? last[0] : null;
}

/**
 * Lifecycle of a zone. The UNFILLED / PARTIALLY FILLED designation is only dropped once the candle that filled (or closed through) the gap has CLOSED:
 * while that candle is still forming the zone is FILL PENDING CLOSE, so a live wick or a live close can never silently retire a zone.
 */
export function fvgLifecycle(z: Pick<FvgZone, "status" | "endTime">, forming: number | null | undefined): FvgLifecycle {
  if (z.status === "fresh") return "unfilled";
  if (z.status === "partially_mitigated") return "partially_filled";
  if (z.status === "expired") return "expired";
  const pending = forming !== null && forming !== undefined && z.endTime !== null && z.endTime >= forming;
  if (pending) return "filled_pending";
  return z.status === "fully_mitigated" ? "filled" : "invalidated";
}

export const isOpenLifecycle = (lc: FvgLifecycle) => lc === "unfilled" || lc === "partially_filled";
export const isTerminalLifecycle = (lc: FvgLifecycle) => lc === "filled" || lc === "invalidated" || lc === "expired";

/** e.g. "BULLISH FVG – UNFILLED", "BEARISH FVG – PARTIALLY FILLED". */
export function fvgLabel(z: Pick<FvgZone, "direction">, lc: FvgLifecycle): string {
  return `${z.direction === "bullish" ? "BULLISH" : "BEARISH"} FVG – ${FVG_LIFECYCLE_TEXT[lc]}`;
}

export interface FvgRecord {
  key: string; market: string; zone: FvgZone; lifecycle: FvgLifecycle;
  firstSeen: number; lastSeen: number;
  /** Open time of the last candle already folded into the zone's fill state. */
  trackedThrough: number;
  /** A locked record is history: its resolution was confirmed on a closed candle and can never be repainted. */
  locked: boolean;
}
export interface FvgRegistryContext {
  now: number;
  /** Open time of the forming candle per timeframe (null when the last candle is closed). */
  forming?: Record<string, number | null>;
  rowsByTf?: Record<string, Kline[]>;
}

function edgesOf(z: FvgZone, pen: number): { remainingUpper: number; remainingLower: number } {
  return z.direction === "bullish" ? { remainingUpper: z.upper - pen * z.sizeAbs, remainingLower: z.lower } : { remainingUpper: z.upper, remainingLower: z.lower + pen * z.sizeAbs };
}
const round = (v: number, d: number) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

/**
 * Continues fill tracking for a zone whose formation candles have rolled out of the candle window, using the candles that are available now.
 * Wick mitigation counts on any candle; invalidation (a close beyond the far edge) only counts on CLOSED candles.
 */
export function retrackZone(rec: Pick<FvgRecord, "zone" | "trackedThrough">, rows: Kline[], now: number, maxAge: number = FVG_RULES.maxAgeBars): FvgZone {
  const z: FvgZone = { ...rec.zone }, bull = z.direction === "bullish", ms = FVG_TF_MS[z.timeframe] ?? 0;
  let pen = z.mitigationPct / 100, end: number | null = null, status: FvgStatus = z.status, ce = z.ceTouched;
  const last = rows.length ? rows[rows.length - 1][0] : rec.trackedThrough;
  for (const r of rows) {
    if (r[0] < rec.trackedThrough || r[0] <= z.confirmTime) continue;
    const touching = bull ? r[3] <= z.upper : r[2] >= z.lower;
    if (touching) {
      const p = Math.min(1, (bull ? z.upper - r[3] : r[2] - z.lower) / z.sizeAbs);
      if (p > pen) pen = p;
      if (bull ? r[3] <= z.mid : r[2] >= z.mid) ce = true;
    }
    const closed = !ms || r[0] + ms <= now;
    if (closed && (bull ? r[4] < z.lower : r[4] > z.upper)) { status = "invalidated"; pen = 1; end = r[0]; break; }
    if (pen >= 1) { status = "fully_mitigated"; end = r[0]; break; }
  }
  const age = ms ? Math.max(0, Math.round(((end !== null ? end : last) - z.confirmTime) / ms)) : z.ageBars;
  if (end === null && age > maxAge) { status = "expired"; end = last; }
  if (end === null) status = pen > 0 ? "partially_mitigated" : "fresh";
  const e = edgesOf(z, pen);
  z.status = status; z.active = status === "fresh" || status === "partially_mitigated"; z.mitigationPct = round(pen * 100, 0); z.endTime = end; z.ceTouched = ce; z.ageBars = age;
  z.remainingUpper = e.remainingUpper; z.remainingLower = e.remainingLower; z.freshness = status === "fresh" ? 1 : status === "partially_mitigated" ? round(1 - pen, 3) : 0;
  return z;
}

/**
 * In-memory history of every zone seen, keyed by market + zone id so a zone can never be duplicated. Guarantees:
 *  - fill depth only ever grows (a rolling candle window cannot make a partially filled zone look fresh again),
 *  - a zone whose resolution was confirmed on a closed candle is locked and never reclassified (no repainting),
 *  - zones that scroll out of the candle window keep being tracked, and stay available as history.
 */
export class FvgRegistry {
  private m = new Map<string, FvgRecord>();
  readonly maxRecords: number;
  constructor(maxRecords = 600) { this.maxRecords = maxRecords; }

  update(market: string, detected: FvgZone[], ctx: FvgRegistryContext): void {
    const seen = new Set<string>();
    for (const z of detected) {
      const key = `${market}|${z.id}`;
      seen.add(key);
      const prev = this.m.get(key);
      if (prev?.locked) { prev.lastSeen = ctx.now; continue; }
      let zone = z;
      if (prev && (z.status === "fresh" || z.status === "partially_mitigated") && prev.zone.mitigationPct > z.mitigationPct) {
        zone = { ...z, status: "partially_mitigated", active: true, mitigationPct: prev.zone.mitigationPct, remainingUpper: prev.zone.remainingUpper, remainingLower: prev.zone.remainingLower,
          touches: Math.max(z.touches, prev.zone.touches), ceTouched: z.ceTouched || prev.zone.ceTouched, freshness: round(1 - prev.zone.mitigationPct / 100, 3) };
      }
      const lifecycle = fvgLifecycle(zone, ctx.forming?.[zone.timeframe] ?? null);
      const rr = ctx.rowsByTf?.[zone.timeframe];
      this.m.set(key, { key, market, zone, lifecycle, firstSeen: prev ? prev.firstSeen : ctx.now, lastSeen: ctx.now,
        trackedThrough: rr && rr.length ? rr[rr.length - 1][0] : ctx.now, locked: isTerminalLifecycle(lifecycle) });
    }
    for (const [key, rec] of this.m) {
      if (rec.market !== market || seen.has(key) || rec.locked) continue;
      const rows = ctx.rowsByTf?.[rec.zone.timeframe];
      if (!rows || !rows.length) continue;
      const zone = retrackZone(rec, rows, ctx.now), lifecycle = fvgLifecycle(zone, ctx.forming?.[zone.timeframe] ?? null);
      rec.zone = zone; rec.lifecycle = lifecycle; rec.lastSeen = ctx.now; rec.trackedThrough = rows[rows.length - 1][0]; rec.locked = isTerminalLifecycle(lifecycle);
    }
    this.prune();
  }
  private prune(): void {
    if (this.m.size <= this.maxRecords) return;
    const order = [...this.m.values()].sort((a, b) => Number(b.locked) - Number(a.locked) || a.lastSeen - b.lastSeen);
    for (const r of order) { if (this.m.size <= this.maxRecords) break; this.m.delete(r.key); }
  }
  records(market?: string): FvgRecord[] { return [...this.m.values()].filter(r => market === undefined || r.market === market); }
  get size(): number { return this.m.size; }
}

export interface FvgDashboardZone { id: string; timeframe: string; direction: "bullish" | "bearish"; upper: number; lower: number; lifecycle: FvgLifecycle; filledPct: number; distancePct: number }
export interface FvgDashboard {
  bullishUnfilled: number; bearishUnfilled: number; bullishPartial: number; bearishPartial: number;
  /** Unfilled + partially filled, the zones still drawn as live imbalances. */
  bullishActive: number; bearishActive: number;
  inside: number; pending: number; history: number;
  byTimeframe: Record<string, { bullish: number; bearish: number }>;
  nearestAbove: FvgDashboardZone | null; nearestBelow: FvgDashboardZone | null;
}

/** Dashboard summary of the active bullish and bearish unfilled gaps for one market view. */
export function summarizeFvgDashboard(records: FvgRecord[], price: number): FvgDashboard {
  const d: FvgDashboard = { bullishUnfilled: 0, bearishUnfilled: 0, bullishPartial: 0, bearishPartial: 0, bullishActive: 0, bearishActive: 0, inside: 0, pending: 0, history: 0, byTimeframe: {}, nearestAbove: null, nearestBelow: null };
  let bestAbove = Infinity, bestBelow = Infinity;
  for (const r of records) {
    const z = r.zone, bull = z.direction === "bullish";
    if (r.lifecycle === "filled_pending") { d.pending++; continue; }
    if (!isOpenLifecycle(r.lifecycle)) { d.history++; continue; }
    if (r.lifecycle === "unfilled") { if (bull) d.bullishUnfilled++; else d.bearishUnfilled++; } else if (bull) d.bullishPartial++; else d.bearishPartial++;
    if (bull) d.bullishActive++; else d.bearishActive++;
    const b = (d.byTimeframe[z.timeframe] ??= { bullish: 0, bearish: 0 });
    if (bull) b.bullish++; else b.bearish++;
    const dist = price > z.upper ? price - z.upper : price < z.lower ? z.lower - price : 0;
    if (dist === 0) { d.inside++; continue; }
    const brief: FvgDashboardZone = { id: z.id, timeframe: z.timeframe, direction: z.direction, upper: z.upper, lower: z.lower, lifecycle: r.lifecycle, filledPct: z.mitigationPct, distancePct: price > 0 ? round(dist / price * 100, 3) : 0 };
    if (price > z.upper) { if (dist < bestBelow) { bestBelow = dist; d.nearestBelow = brief; } } else if (dist < bestAbove) { bestAbove = dist; d.nearestAbove = brief; }
  }
  return d;
}

/**
 * Cross-market agreement: the same gap (same timeframe, direction and displacement candle, overlapping by at least `minOverlap` of the smaller one)
 * seen on several markets of one symbol (spot, margin, futures). Returns zone id -> sorted list of markets that show it (including its own).
 */
export function fvgMarketAgreement(byMarket: Record<string, FvgZone[]>, minOverlap = 0.5): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const markets = Object.keys(byMarket);
  for (const m of markets) for (const z of byMarket[m]) {
    const set = new Set<string>([m]);
    for (const o of markets) {
      if (o === m) continue;
      for (const w of byMarket[o]) {
        if (w.timeframe !== z.timeframe || w.direction !== z.direction || w.formationTime !== z.formationTime) continue;
        const ov = Math.min(z.upper, w.upper) - Math.max(z.lower, w.lower);
        if (ov > 0 && ov / Math.min(z.sizeAbs, w.sizeAbs) >= minOverlap) set.add(o);
      }
    }
    out[z.id] = [...new Set([...(out[z.id] ?? []), ...set])].sort();
  }
  return out;
}

/**
 * Multi-timeframe alignment of unfilled gaps for a proposed trade: two timeframes agreeing is worth 1 point, three or more 1.5; opposing timeframes subtract the same way.
 * A single timeframe scores 0 (that case is already weighed by the supporting / opposing gap factors).
 */
export function fvgMtfAlignmentPoints(supportTfs: string[], opposeTfs: string[]): { points: number; detail: string } {
  const s = new Set(supportTfs).size, o = new Set(opposeTfs).size, f = (n: number) => (n >= 3 ? 1.5 : n === 2 ? 1 : 0);
  return { points: f(s) - f(o), detail: `unfilled gaps agree with the trade on ${s} timeframe(s) and oppose it on ${o}` };
}

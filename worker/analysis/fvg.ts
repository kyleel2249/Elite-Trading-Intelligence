// Fair Value Gap (FVG) engine: detection, live tracking, multi-timeframe projection and ranking.
// Pure functions, no I/O. An FVG is a descriptive price-imbalance construct; it is analytical evidence only and can never open, size or
// authorise a trade on its own (see worker/algo/fvg-confluence.ts for how it is weighed against the other engines).
//
// The browser layer (worker/ui/fvg-layer.ts) carries a hand-written mirror of detectFvgZones / analyzeFvgMtf so the live chart can recompute
// on every tick without a server round trip. worker/fvg.test.ts runs both implementations over the same candles and requires identical output.
import type { Kline } from "../market.ts";
import { atrSeries } from "../algo/indicators.ts";
import { round } from "./types.ts";

export const FVG_RULES = {
  /** Minimum gap size as a multiple of ATR(14) at the confirming candle: smaller gaps are noise. */
  minSizeAtr: 0.15,
  /** A zone that is still unresolved this many bars after it formed is expired. */
  maxAgeBars: 200,
  /** Two same-direction zones from different timeframes are in confluence when they overlap by at least this share of the smaller one. */
  confluenceOverlap: 0.25,
  /** Same-direction zones overlapping by this share of the smaller one are drawn once (the higher-ranked one) to limit clutter. */
  dedupeOverlap: 0.8,
  defaultMaxZones: 12,
} as const;

export type FvgDirection = "bullish" | "bearish";
export type FvgStatus = "fresh" | "partially_mitigated" | "fully_mitigated" | "invalidated" | "expired";

export const FVG_TF_MS: Record<string, number> = {
  "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "6h": 21600e3, "8h": 28800e3,
  "12h": 43200e3, "1d": 86400e3, "3d": 259200e3, "1w": 604800e3, "1M": 31 * 86400e3,
};
/** Relative importance of a timeframe: a gap left on a higher timeframe is a larger, slower-to-fill imbalance. */
export const FVG_TF_WEIGHT: Record<string, number> = {
  "1m": 1, "3m": 1.2, "5m": 1.5, "15m": 2, "30m": 2.5, "1h": 3, "2h": 3.5, "4h": 4, "6h": 4.5, "8h": 4.8, "12h": 5, "1d": 6, "3d": 6.5, "1w": 7, "1M": 8,
};

export const FVG_METHODOLOGY =
  "Three-candle imbalance on CLOSED candles only (nothing repaints): bullish FVG = high[n-2] < low[n], zone = [high[n-2], low[n]]; bearish FVG = low[n-2] > high[n], zone = [high[n], low[n-2]]; " +
  "minimum size 0.15 x ATR(14). Formation price is the close of the confirming (third) candle. Tracking uses every later candle, including the live one: " +
  "a bullish zone is touched when a low trades at or below its upper edge and mitigation is the deepest wick penetration as a share of the gap; " +
  "it is FULLY MITIGATED when a wick reaches the far edge, INVALIDATED when a candle CLOSES beyond the far edge (checked first), and EXPIRED after 200 bars unresolved. " +
  "Active = fresh or partially mitigated; only active zones are extended to the live edge of the chart. Strength (0-100) = size 30 + displacement body 25 + volume 15 + freshness 20 + age 10. " +
  "An FVG is a descriptive imbalance, not a guarantee of reaction, and is never a trade trigger on its own.";

export interface FvgZone {
  id: string;
  timeframe: string;
  direction: FvgDirection;
  upper: number;
  lower: number;
  /** Consequent encroachment: the 50% level of the gap. */
  mid: number;
  sizeAbs: number;
  sizePct: number;
  sizeAtr: number;
  /** Open time of the middle (displacement) candle: where the rectangle starts. */
  formationTime: number;
  /** Open time of the confirming third candle; the zone is only known once that candle has closed. */
  confirmTime: number;
  formationIndex: number;
  /** Close of the confirming candle. */
  formationPrice: number;
  status: FvgStatus;
  active: boolean;
  /** Deepest wick penetration into the gap, 0-100. */
  mitigationPct: number;
  /** Open time of the candle that resolved the zone (mitigated, invalidated or expired); null while active. */
  endTime: number | null;
  touches: number;
  ceTouched: boolean;
  ageBars: number;
  /** Unfilled part of the gap after partial mitigation. */
  remainingUpper: number;
  remainingLower: number;
  displacementAtr: number;
  volumeRatio: number;
  /** 1 untouched, 1-mitigation for a partially mitigated zone, 0 once resolved. */
  freshness: number;
  strength: number;
  /** Other-timeframe active zones of the same direction that overlap this one (set by analyzeFvgMtf). */
  confluence: { id: string; timeframe: string; overlapPct: number }[];
  /** Ranking score used to choose which zones to draw (set by analyzeFvgMtf). */
  relevance: number;
}

export interface FvgOptions {
  timeframe: string;
  /** Candle length; defaults to FVG_TF_MS[timeframe]. With `now` it decides which trailing candle is still forming. */
  timeframeMs?: number;
  now?: number;
  minSizeAtr?: number;
  maxAgeBars?: number;
  /** Only the most recent N closed candles are scanned for new gaps (default: all). */
  window?: number;
}

export function closedCount(rows: Kline[], timeframeMs: number | undefined, now: number | undefined): number {
  let n = rows.length;
  if (timeframeMs && now !== undefined) while (n > 0 && rows[n - 1][0] + timeframeMs > now) n--;
  return n;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function detectFvgZones(rows: Kline[], o: FvgOptions): FvgZone[] {
  const minAtr = o.minSizeAtr ?? FVG_RULES.minSizeAtr, maxAge = o.maxAgeBars ?? FVG_RULES.maxAgeBars;
  const n = rows.length, closed = closedCount(rows, o.timeframeMs ?? FVG_TF_MS[o.timeframe], o.now);
  const atr = atrSeries(rows, 14), out: FvgZone[] = [];
  const first = Math.max(2, o.window ? closed - o.window : 0);
  for (let i = first; i < closed; i++) {
    const a = atr[i];
    if (!(a > 0)) continue;
    const c1 = rows[i - 2], c2 = rows[i - 1], c3 = rows[i];
    let direction: FvgDirection | null = null, lower = 0, upper = 0;
    if (c1[2] < c3[3]) { direction = "bullish"; lower = c1[2]; upper = c3[3]; }
    else if (c1[3] > c3[2]) { direction = "bearish"; upper = c1[3]; lower = c3[2]; }
    if (!direction) continue;
    const size = upper - lower;
    if (size < minAtr * a) continue;
    const bull = direction === "bullish", mid = (upper + lower) / 2;

    // Live tracking over every later candle, including the one still forming.
    let maxPen = 0, touches = 0, inside = false, ceTouched = false, status: FvgStatus = "fresh", endIdx = -1;
    for (let k = i + 1; k < n; k++) {
      const r = rows[k];
      if (k - i > maxAge) { status = "expired"; endIdx = k; break; }
      const touching = bull ? r[3] <= upper : r[2] >= lower;
      const pen = touching ? Math.min(1, (bull ? upper - r[3] : r[2] - lower) / size) : 0;
      if (touching && !inside) touches++;
      inside = touching;
      if (pen > maxPen) maxPen = pen;
      if (bull ? r[3] <= mid : r[2] >= mid) ceTouched = true;
      if (bull ? r[4] < lower : r[4] > upper) { status = "invalidated"; maxPen = 1; endIdx = k; break; }
      if (maxPen >= 1) { status = "fully_mitigated"; endIdx = k; break; }
    }
    if (endIdx < 0) status = maxPen > 0 ? "partially_mitigated" : "fresh";
    const active = status === "fresh" || status === "partially_mitigated";
    const ageBars = (endIdx >= 0 ? endIdx : n - 1) - i;

    // Strength from facts known at formation plus the current state.
    const body = bull ? c2[4] - c2[1] : c2[1] - c2[4];
    const displacementAtr = body > 0 ? body / a : 0;
    let vs = 0, vc = 0;
    for (let q = Math.max(0, i - 21); q <= i - 2; q++) { vs += rows[q][5]; vc++; }
    const vm = vc ? vs / vc : 0, volumeRatio = vm > 0 ? c2[5] / vm : 1;
    const freshness = status === "fresh" ? 1 : status === "partially_mitigated" ? 1 - maxPen : 0;
    const strength = clamp(
      Math.min(1, size / a / 1.5) * 30 + Math.min(1, displacementAtr / 1.5) * 25 + clamp(volumeRatio - 1, 0, 1) * 15 + freshness * 20 + clamp(1 - ageBars / maxAge, 0, 1) * 10, 0, 100);
    out.push({
      id: `${o.timeframe}:${direction}:${c2[0]}`, timeframe: o.timeframe, direction, upper, lower, mid, sizeAbs: size, sizePct: round(size / c3[4] * 100, 4), sizeAtr: round(size / a, 3),
      formationTime: c2[0], confirmTime: c3[0], formationIndex: i - 1, formationPrice: c3[4], status, active, mitigationPct: round(maxPen * 100, 0),
      endTime: endIdx >= 0 ? rows[endIdx][0] : null, touches, ceTouched, ageBars,
      remainingUpper: bull ? upper - maxPen * size : upper, remainingLower: bull ? lower : lower + maxPen * size,
      displacementAtr: round(displacementAtr, 3), volumeRatio: round(volumeRatio, 3), freshness: round(freshness, 3), strength: round(strength, 0), confluence: [], relevance: 0,
    });
  }
  return out;
}

export interface FvgTfInput { timeframe: string; rows: Kline[] }
export interface FvgMtfOptions {
  now?: number;
  /** Reference price; defaults to the last close of the chart timeframe. */
  price?: number;
  /** Reference ATR for proximity ranking; defaults to the last ATR(14) of the chart timeframe. */
  atr?: number;
  maxZones?: number;
  minSizeAtr?: number;
  maxAgeBars?: number;
  /** Include mitigated, invalidated and expired zones after the active ones. */
  includeInactive?: boolean;
  window?: number;
}
export interface FvgSummary {
  active: number; bullishActive: number; bearishActive: number;
  byTimeframe: Record<string, { active: number; bullish: number; bearish: number }>;
  /** Strongest active bullish zone at or below price (acts as support) and strongest active bearish zone at or above price (resistance). */
  nearestSupport: FvgZone | null; nearestResistance: FvgZone | null;
  /** Active zones containing the current price. */
  inside: FvgZone[];
  confluentZones: number;
}
export interface FvgMtfResult { chartTimeframe: string; price: number; atr: number; zones: FvgZone[]; totalDetected: number; summary: FvgSummary; methodology: string; canTriggerTrade: false }

const overlapOf = (a: FvgZone, b: FvgZone) => Math.min(a.upper, b.upper) - Math.max(a.lower, b.lower);
/** Distance from price to a zone in price units (0 when price is inside it). */
export const zoneDistance = (z: Pick<FvgZone, "upper" | "lower">, price: number) => (price > z.upper ? price - z.upper : price < z.lower ? z.lower - price : 0);

export function analyzeFvgMtf(chartTimeframe: string, inputs: FvgTfInput[], o: FvgMtfOptions = {}): FvgMtfResult {
  const chart = inputs.find(i => i.timeframe === chartTimeframe);
  const lastRow = chart?.rows.at(-1);
  const price = o.price ?? (lastRow ? lastRow[4] : 0);
  let atr = o.atr ?? 0;
  if (!(atr > 0) && chart) { const s = atrSeries(chart.rows, 14); for (let i = s.length - 1; i >= 0; i--) if (Number.isFinite(s[i])) { atr = s[i]; break; } }
  if (!(atr > 0)) atr = price * 0.01;

  const all: FvgZone[] = [];
  for (const inp of inputs) all.push(...detectFvgZones(inp.rows, { timeframe: inp.timeframe, now: o.now, minSizeAtr: o.minSizeAtr, maxAgeBars: o.maxAgeBars, window: o.window }));

  const active = all.filter(z => z.active);
  for (const z of all) {
    if (!z.active) continue;
    for (const w of active) {
      if (w === z || w.timeframe === z.timeframe || w.direction !== z.direction) continue;
      const ov = overlapOf(z, w);
      if (ov <= 0) continue;
      const pct = ov / Math.min(z.sizeAbs, w.sizeAbs);
      if (pct >= FVG_RULES.confluenceOverlap) z.confluence.push({ id: w.id, timeframe: w.timeframe, overlapPct: round(pct * 100, 0) });
    }
  }
  for (const z of all) {
    const prox = 1 / (1 + zoneDistance(z, price) / (3 * atr));
    const tfw = 0.6 + 0.4 * (FVG_TF_WEIGHT[z.timeframe] ?? 1) / 8;
    z.relevance = z.active ? round(z.strength * tfw * prox + z.confluence.length * 5, 2) : 0;
  }

  const ranked = [...all.filter(z => z.active)].sort((a, b) => b.relevance - a.relevance || b.formationTime - a.formationTime);
  const shown: FvgZone[] = [], max = o.maxZones ?? FVG_RULES.defaultMaxZones;
  for (const z of ranked) {
    if (shown.length >= max) break;
    const dupe = shown.some(s => s.direction === z.direction && overlapOf(s, z) > 0 && overlapOf(s, z) / Math.min(s.sizeAbs, z.sizeAbs) >= FVG_RULES.dedupeOverlap);
    if (!dupe) shown.push(z);
  }
  if (o.includeInactive) {
    for (const z of all.filter(z => !z.active).sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0))) { if (shown.length >= max) break; shown.push(z); }
  }

  const byTimeframe: FvgSummary["byTimeframe"] = {};
  for (const z of active) { const b = (byTimeframe[z.timeframe] ??= { active: 0, bullish: 0, bearish: 0 }); b.active++; if (z.direction === "bullish") b.bullish++; else b.bearish++; }
  const pick = (zs: FvgZone[]) => zs.sort((a, b) => b.relevance - a.relevance)[0] ?? null;
  const summary: FvgSummary = {
    active: active.length, bullishActive: active.filter(z => z.direction === "bullish").length, bearishActive: active.filter(z => z.direction === "bearish").length, byTimeframe,
    nearestSupport: pick(active.filter(z => z.direction === "bullish" && z.lower <= price)), nearestResistance: pick(active.filter(z => z.direction === "bearish" && z.upper >= price)),
    inside: active.filter(z => price >= z.lower && price <= z.upper), confluentZones: active.filter(z => z.confluence.length > 0).length,
  };
  return { chartTimeframe, price, atr, zones: shown, totalDetected: all.length, summary, methodology: FVG_METHODOLOGY, canTriggerTrade: false };
}

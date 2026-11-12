// Market structure, support/resistance, supply/demand zones, trendlines, breakouts, false breakouts and retests.
// Pivots are CONFIRMED fractals: a pivot at bar i is only reported once `right` later bars exist, so nothing repaints.
import type { Kline } from "../market.ts";
import { atr14, lastAtr } from "./atr.ts";
import { clamp, round, type Stance } from "./types.ts";

export interface Pivot { index: number; time: number; price: number; kind: "high" | "low" }
export function findPivots(rows: Kline[], left = 3, right = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i < rows.length - right; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= left; j++) { if (rows[i][2] <= rows[i - j][2]) hi = false; if (rows[i][3] >= rows[i - j][3]) lo = false; }
    for (let j = 1; j <= right; j++) { if (rows[i][2] < rows[i + j][2]) hi = false; if (rows[i][3] > rows[i + j][3]) lo = false; }
    if (hi) out.push({ index: i, time: rows[i][0], price: rows[i][2], kind: "high" });
    if (lo) out.push({ index: i, time: rows[i][0], price: rows[i][3], kind: "low" });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------- market structure ----------
export type SwingLabel = "HH" | "HL" | "LH" | "LL" | "EH" | "EL";
export interface LabelledPivot extends Pivot { label: SwingLabel | null }
export interface StructureEvent { type: "BOS" | "CHoCH"; direction: "bullish" | "bearish"; index: number; time: number; level: number; note: string }
export interface MarketStructure {
  trend: "uptrend" | "downtrend" | "range" | "undetermined";
  stance: Stance;
  pivots: LabelledPivot[];
  higherHighs: number; higherLows: number; lowerHighs: number; lowerLows: number;
  lastSwingHigh: Pivot | null; lastSwingLow: Pivot | null;
  events: StructureEvent[];
  /** The swing that, if broken by a CLOSE, invalidates the current trend. */
  invalidationLevel: number | null;
}
export function analyzeStructure(rows: Kline[], pivots = findPivots(rows), tolerancePct = 0.001, confirmBars = 3): MarketStructure {
  const labelled: LabelledPivot[] = [];
  let prevH: Pivot | null = null, prevL: Pivot | null = null, hh = 0, hl = 0, lh = 0, ll = 0;
  const window: string[] = [];
  for (const p of pivots) {
    let label: SwingLabel | null = null;
    if (p.kind === "high") {
      if (prevH) { const d = (p.price - prevH.price) / prevH.price; label = Math.abs(d) <= tolerancePct ? "EH" : d > 0 ? "HH" : "LH"; }
      prevH = p;
    } else {
      if (prevL) { const d = (p.price - prevL.price) / prevL.price; label = Math.abs(d) <= tolerancePct ? "EL" : d > 0 ? "HL" : "LL"; }
      prevL = p;
    }
    labelled.push({ ...p, label });
    if (label) window.push(label);
  }
  const recent = labelled.filter(p => p.label).slice(-6);
  for (const p of recent) { if (p.label === "HH") hh++; if (p.label === "HL") hl++; if (p.label === "LH") lh++; if (p.label === "LL") ll++; }
  const highs = labelled.filter(p => p.kind === "high"), lows = labelled.filter(p => p.kind === "low");
  const lastH = highs.at(-1) ?? null, lastL = lows.at(-1) ?? null;
  const lh1 = highs.at(-1)?.label, ll1 = lows.at(-1)?.label;
  let trend: MarketStructure["trend"] = "undetermined";
  if (highs.length >= 2 && lows.length >= 2) {
    if (lh1 === "HH" && ll1 === "HL") trend = "uptrend";
    else if (lh1 === "LH" && ll1 === "LL") trend = "downtrend";
    else trend = "range";
  }
  // BOS = a CLOSE beyond the last swing in the direction of the trend; CHoCH = a CLOSE beyond the last protected swing against it.
  const events: StructureEvent[] = [];
  const confirmedAt = (p: Pivot) => p.index + confirmBars;
  let activeH: Pivot | null = null, activeL: Pivot | null = null, dir: "up" | "down" | null = null;
  const byConfirm = new Map<number, Pivot[]>();
  for (const p of labelled) (byConfirm.get(confirmedAt(p)) ?? byConfirm.set(confirmedAt(p), []).get(confirmedAt(p))!).push(p);
  for (let i = 0; i < rows.length; i++) {
    for (const p of byConfirm.get(i) ?? []) { if (p.kind === "high") { activeH = p; } else { activeL = p; } }
    const close = rows[i][4];
    if (activeH && close > activeH.price) {
      events.push({ type: dir === "down" ? "CHoCH" : "BOS", direction: "bullish", index: i, time: rows[i][0], level: activeH.price, note: dir === "down" ? "Close above the last lower high: first sign of a bullish character change" : "Close above the last swing high: bullish continuation" });
      dir = "up"; activeH = null;
    } else if (activeL && close < activeL.price) {
      events.push({ type: dir === "up" ? "CHoCH" : "BOS", direction: "bearish", index: i, time: rows[i][0], level: activeL.price, note: dir === "up" ? "Close below the last higher low: first sign of a bearish character change" : "Close below the last swing low: bearish continuation" });
      dir = "down"; activeL = null;
    }
  }
  const invalidationLevel = trend === "uptrend" ? lastL?.price ?? null : trend === "downtrend" ? lastH?.price ?? null : null;
  return { trend, stance: trend === "uptrend" ? "bullish" : trend === "downtrend" ? "bearish" : "neutral", pivots: labelled, higherHighs: hh, higherLows: hl, lowerHighs: lh, lowerLows: ll,
    lastSwingHigh: lastH, lastSwingLow: lastL, events: events.slice(-8), invalidationLevel };
}

// ---------- support / resistance ----------
export interface Level { price: number; low: number; high: number; touches: number; lastTouchIndex: number; strength: number; kind: "support" | "resistance"; }
/** Clusters pivot prices within `tolAtr` x ATR. Strength rises with touches and recency; levels the price has closed through become flipped roles. */
export function supportResistance(rows: Kline[], pivots: Pivot[], tolAtr = 0.5, max = 8): Level[] {
  const a = lastAtr(rows), price = rows.at(-1)![4];
  if (!(a > 0)) return [];
  const clusters: { prices: number[]; idx: number[] }[] = [];
  for (const p of [...pivots].sort((x, y) => x.price - y.price)) {
    const c = clusters.at(-1);
    if (c && p.price - c.prices[c.prices.length - 1] <= tolAtr * a) { c.prices.push(p.price); c.idx.push(p.index); } else clusters.push({ prices: [p.price], idx: [p.index] });
  }
  const n = rows.length;
  const levels: Level[] = clusters.filter(c => c.prices.length >= 2).map(c => {
    const mid = c.prices.reduce((s, v) => s + v, 0) / c.prices.length, last = Math.max(...c.idx);
    const recency = 1 - (n - 1 - last) / n;
    return { price: round(mid, 8), low: Math.min(...c.prices), high: Math.max(...c.prices), touches: c.prices.length, lastTouchIndex: last,
      strength: Math.round(clamp(c.prices.length * 18 + recency * 25, 0, 100)), kind: mid < price ? "support" : "resistance" } as Level;
  });
  return levels.sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price)).slice(0, max);
}

// ---------- supply and demand zones ----------
export interface Zone { kind: "supply" | "demand"; proximal: number; distal: number; baseStart: number; baseEnd: number; legOutAtr: number; tests: number; fresh: boolean; invalidated: boolean; time: number }
export const ZONE_RULES = { baseMaxBars: 3, baseBodyAtr: 0.6, legOutAtr: 1.5, legOutBars: 3 } as const;
/**
 * Methodology: a BASE is 1-3 consecutive small-bodied candles (body <= 0.6 ATR). It becomes a zone only when followed within 3 bars
 * by an impulsive LEG-OUT of >= 1.5 ATR. Demand = leg-out upward; supply = leg-out downward. Proximal = edge nearest price,
 * distal = far edge. A zone is FRESH if price has not returned to it, TESTED once re-entered, INVALIDATED when a close breaks the distal edge.
 */
export function supplyDemandZones(rows: Kline[], maxZones = 6): Zone[] {
  const atr = atr14(rows), n = rows.length, cands: Zone[] = [];
  const body = rows.map(r => Math.abs(r[4] - r[1]));
  for (let i = 15; i < n - 1; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    for (let len = 1; len <= ZONE_RULES.baseMaxBars; len++) {
      const s = i - len + 1; if (s < 14) continue;
      let ok = true, hi = -Infinity, lo = Infinity, bodyHi = -Infinity, bodyLo = Infinity;
      for (let j = s; j <= i; j++) { if (body[j] > ZONE_RULES.baseBodyAtr * a) { ok = false; break; } const r = rows[j]; if (r[2] > hi) hi = r[2]; if (r[3] < lo) lo = r[3]; const t = Math.max(r[1], r[4]), u = Math.min(r[1], r[4]); if (t > bodyHi) bodyHi = t; if (u < bodyLo) bodyLo = u; }
      if (!ok) continue;
      let outHi = -Infinity, outLo = Infinity; const e = Math.min(n, i + 1 + ZONE_RULES.legOutBars);
      for (let j = i + 1; j < e; j++) { if (rows[j][2] > outHi) outHi = rows[j][2]; if (rows[j][3] < outLo) outLo = rows[j][3]; }
      if (e <= i + 1) continue;
      const up = outHi - hi, dn = lo - outLo;
      const kind = up >= ZONE_RULES.legOutAtr * a && up > dn ? "demand" : dn >= ZONE_RULES.legOutAtr * a && dn > up ? "supply" : null;
      if (!kind) continue;
      cands.push({ kind, proximal: kind === "demand" ? bodyHi : bodyLo, distal: kind === "demand" ? lo : hi, baseStart: s, baseEnd: i, legOutAtr: round((kind === "demand" ? up : dn) / a), tests: 0, fresh: true, invalidated: false, time: rows[i][0] });
      break;
    }
  }
  // De-duplicate overlapping zones of the same kind (most recent first) BEFORE the expensive history scan.
  const kept: Zone[] = [];
  for (const z of cands.sort((x, y) => y.baseEnd - x.baseEnd)) {
    if (kept.length >= maxZones * 3) break;
    if (!kept.some(k => k.kind === z.kind && Math.max(k.proximal, k.distal) >= Math.min(z.proximal, z.distal) && Math.min(k.proximal, k.distal) <= Math.max(z.proximal, z.distal))) kept.push(z);
  }
  for (const z of kept) {
    let tests = 0, inside = false;
    for (let k = z.baseEnd + 1 + ZONE_RULES.legOutBars; k < n; k++) {
      const r = rows[k], touches = z.kind === "demand" ? r[3] <= z.proximal : r[2] >= z.proximal;
      if (touches && !inside) { tests++; inside = true; } else if (!touches) inside = false;
      if (z.kind === "demand" ? r[4] < z.distal : r[4] > z.distal) { z.invalidated = true; break; }
    }
    z.tests = tests; z.fresh = tests === 0;
  }
  return kept.filter(z => !z.invalidated).slice(0, maxZones);
}

// ---------- trendlines ----------
export interface Trendline { kind: "support" | "resistance"; slope: number; intercept: number; touches: number; startIndex: number; endIndex: number; projectedNow: number; brokenAtIndex: number | null; distancePct: number }
/**
 * Methodology: for each pair among the last 6 pivot lows (ascending) / highs (descending), fit a line, count other pivots within 0.35 ATR
 * as touches, and reject lines pierced by a close between the anchors by more than 0.35 ATR. Needs >= 3 touches. The best line has the most touches, then recency.
 */
export function detectTrendlines(rows: Kline[], pivots: Pivot[]): Trendline[] {
  const a = lastAtr(rows), price = rows.at(-1)![4], last = rows.length - 1, out: Trendline[] = [];
  if (!(a > 0)) return out;
  for (const kind of ["support", "resistance"] as const) {
    const ps = pivots.filter(p => p.kind === (kind === "support" ? "low" : "high")).slice(-6);
    let best: Trendline | null = null;
    for (let x = 0; x < ps.length; x++) for (let y = x + 1; y < ps.length; y++) {
      const p1 = ps[x], p2 = ps[y], slope = (p2.price - p1.price) / (p2.index - p1.index);
      if (kind === "support" && slope <= 0) continue;
      if (kind === "resistance" && slope >= 0) continue;
      const at = (i: number) => p1.price + slope * (i - p1.index);
      const touches = ps.filter(p => Math.abs(p.price - at(p.index)) <= 0.35 * a).length;
      if (touches < 3) continue;
      let pierced = false;
      for (let i = p1.index; i <= p2.index; i++) { const d = kind === "support" ? at(i) - rows[i][4] : rows[i][4] - at(i); if (d > 0.35 * a) { pierced = true; break; } }
      if (pierced) continue;
      let broken: number | null = null;
      for (let i = p2.index + 1; i <= last; i++) { const d = kind === "support" ? at(i) - rows[i][4] : rows[i][4] - at(i); if (d > 0.35 * a) { broken = i; break; } }
      const cand: Trendline = { kind, slope, intercept: p1.price - slope * p1.index, touches, startIndex: p1.index, endIndex: p2.index, projectedNow: at(last), brokenAtIndex: broken, distancePct: round((price - at(last)) / price * 100, 3) };
      if (!best || cand.touches > best.touches || (cand.touches === best.touches && cand.endIndex > best.endIndex)) best = cand;
    }
    if (best) out.push(best);
  }
  return out;
}

// ---------- breakouts / false breakouts / retests ----------
export interface BreakEvent { type: "breakout" | "false_breakout" | "retest_hold" | "retest_fail"; direction: "up" | "down"; level: number; index: number; time: number; volumeConfirmed: boolean; note: string }
export const BREAK_RULES = { closeBeyondAtr: 0.25, volumeMultiple: 1.2, falseReturnBars: 3, retestAtr: 0.35 } as const;
/**
 * Methodology: BREAKOUT = a CLOSE beyond a level by >= 0.25 ATR; volume-confirmed if volume >= 1.2x its 20-bar mean.
 * FALSE BREAKOUT = price closes beyond the level, then closes back inside within 3 bars (a failed acceptance).
 * RETEST = after a confirmed breakout, price returns within 0.35 ATR of the level: HOLD if it closes on the breakout side, FAIL if it closes back through.
 */
export function analyzeBreaks(rows: Kline[], levels: Level[]): BreakEvent[] {
  const atr = atr14(rows), events: BreakEvent[] = [], n = rows.length;
  const volAvg = (i: number) => { const s = rows.slice(Math.max(0, i - 20), i); return s.length ? s.reduce((t, r) => t + r[5], 0) / s.length : 0; };
  for (const lv of levels) {
    for (let i = Math.max(21, n - 40); i < n; i++) {
      const a = atr[i]; if (!(a > 0)) continue;
      const prev = rows[i - 1][4], c = rows[i][4], buf = BREAK_RULES.closeBeyondAtr * a;
      const up = prev <= lv.price && c >= lv.price + buf, dn = prev >= lv.price && c <= lv.price - buf;
      if (!up && !dn) continue;
      const dir = up ? "up" : "down", va = volAvg(i), volOk = va > 0 && rows[i][5] >= BREAK_RULES.volumeMultiple * va;
      const after = rows.slice(i + 1, i + 1 + BREAK_RULES.falseReturnBars);
      const failed = after.some(r => (up ? r[4] < lv.price : r[4] > lv.price));
      if (failed) { events.push({ type: "false_breakout", direction: dir, level: lv.price, index: i, time: rows[i][0], volumeConfirmed: volOk, note: `Closed ${dir === "up" ? "above" : "below"} ${round(lv.price, 4)} then reclaimed the level within ${BREAK_RULES.falseReturnBars} bars: failed acceptance` }); continue; }
      events.push({ type: "breakout", direction: dir, level: lv.price, index: i, time: rows[i][0], volumeConfirmed: volOk, note: `Close ${dir === "up" ? "above" : "below"} ${round(lv.price, 4)}${volOk ? " on above-average volume" : " on ordinary volume (weaker evidence)"}` });
      for (let k = i + 2; k < n; k++) {
        const r = rows[k], near = up ? r[3] <= lv.price + BREAK_RULES.retestAtr * a : r[2] >= lv.price - BREAK_RULES.retestAtr * a;
        if (!near) continue;
        const holds = up ? r[4] > lv.price : r[4] < lv.price;
        events.push({ type: holds ? "retest_hold" : "retest_fail", direction: dir, level: lv.price, index: k, time: r[0], volumeConfirmed: volOk, note: holds ? `Retested ${round(lv.price, 4)} from the ${up ? "top" : "bottom"} and held` : `Retest of ${round(lv.price, 4)} failed: closed back through the level` });
        break;
      }
    }
  }
  return events.sort((x, y) => x.index - y.index);
}

/**
 * Candle-testable strategy modules extracted from documented trader philosophies.
 * Module ids match app/knowledge/strategies.py (the single source of truth for the registry).
 *
 * Combination rule ("do not combine incompatible strategies blindly"):
 *  - Trend regime (ADX >= 25): range-reversal modules are suppressed.
 *  - Range regime (ADX < 20): breakout modules are suppressed (false-breakout risk).
 *  - Transition: everything runs; disagreement lowers conviction instead of being averaged away.
 *  - Macro and fundamental modules need data candles do not carry, so they are reported as not_applicable, never faked.
 */
import type { Kline } from "./market.ts";
import type { IndicatorSnapshot } from "./signals.ts";

export type Vote = -1 | 0 | 1;
export type Family = "trend" | "breakout" | "range_reversal" | "validation" | "fundamental" | "macro";
export type ModuleStatus = "active" | "suppressed" | "not_applicable" | "validation";
export type Stance = "supporting" | "opposing" | "neutral" | "suppressed" | "not_applicable" | "validation";

export interface ModuleResult { moduleId: string; name: string; trader: string; documentedPrinciple: string; family: Family; status: ModuleStatus; vote: Vote; reason: string }
export interface Regime { state: "trend" | "range" | "transition"; adx: number; rule: string }
export interface AttributionEntry { trader: string; documentedPrinciple: string; contribution: string; moduleId: string; family: Family; stance: Stance; vote: Vote; status: ModuleStatus }
export interface StatEdge { sampleCount: number; winRate: number | null; z: number | null; verdict: "insufficient_sample" | "positive_edge" | "no_edge" | "negative_edge" }
export interface PositionSizing { method: string; suggestedRiskPercent: number; basis: string; note: string }

interface Meta { id: string; name: string; trader: string; principle: string; family: Family; requires?: string }
export const MODULE_META: Meta[] = [
  { id: "turtle_trend", name: "Systematic Trend Following (breakout)", trader: "Richard Dennis / William Eckhardt", principle: "Enter on N-bar price breakouts and stay with the trend with ATR-based risk", family: "breakout" },
  { id: "seykota_mechanical", name: "Mechanical Trend Alignment", trader: "Ed Seykota", principle: "Follow trends mechanically and cut losses with predefined rules", family: "trend" },
  { id: "minervini_vcp", name: "Trend Template (long-only)", trader: "Mark Minervini", principle: "Trade only confirmed stage-2 uptrends that pass a strict trend template", family: "trend" },
  { id: "darvas_box", name: "Price Box Breakout (long-only)", trader: "Nicolas Darvas", principle: "Buy confirmed breakouts above a tight consolidation box on rising volume", family: "breakout" },
  { id: "wyckoff_supply_demand", name: "Supply/Demand Range Reversal", trader: "Richard Wyckoff", principle: "Read accumulation and distribution in ranges via springs and upthrusts", family: "range_reversal" },
  { id: "ptj_structure_preservation", name: "Long-Term Structure and Preservation", trader: "Paul Tudor Jones", principle: "Respect the long-term moving-average structure; protect capital first", family: "trend" },
  { id: "simons_quant", name: "Statistical Validation", trader: "Jim Simons (high-level inspiration only)", principle: "Act only on patterns validated statistically; no claim to proprietary methods", family: "validation" },
  { id: "soros_reflexivity", name: "Reflexivity & Macro Imbalance", trader: "George Soros", principle: "Boom-bust sequences driven by feedback between price and fundamentals", family: "macro", requires: "macro and fundamental imbalance data" },
  { id: "druck_liquidity_macro", name: "Liquidity & Macro Trends", trader: "Stanley Druckenmiller", principle: "Follow liquidity regimes and size up only on asymmetric odds", family: "macro", requires: "liquidity and central-bank data" },
  { id: "oneil_canslim", name: "CAN SLIM Growth Momentum", trader: "William O'Neil", principle: "Growth-stock momentum backed by earnings and relative strength", family: "fundamental", requires: "earnings and a relative-strength stock universe" },
  { id: "buffett_munger_value", name: "Quality & Intrinsic Value", trader: "Warren Buffett / Charlie Munger", principle: "Buy quality businesses below intrinsic value", family: "fundamental", requires: "financial statements and valuation inputs" },
  { id: "lynch_fundamental", name: "Fundamental Growth Research", trader: "Peter Lynch", principle: "Invest in understandable growth businesses at reasonable prices", family: "fundamental", requires: "company fundamentals" },
  { id: "burry_contrarian", name: "Contrarian Valuation", trader: "Michael Burry", principle: "Exploit valuation discrepancies the crowd ignores", family: "fundamental", requires: "valuation and balance-sheet data" },
];

export function regimeOf(adx: number): Regime {
  const a = Number.isFinite(adx) ? Number(adx.toFixed(1)) : 0;
  const rule = "ADX>=25 trend: range-reversal modules suppressed; ADX<20 range: breakout modules suppressed; otherwise all active and disagreement lowers conviction";
  return { state: a >= 25 ? "trend" : a < 20 ? "range" : "transition", adx: a, rule };
}

export function runModules(rows: Kline[], ind: IndicatorSnapshot): { regime: Regime; results: ModuleResult[] } {
  const n = rows.length, c = rows[n - 1][4], closes = rows.map(r => r[4]);
  const sma = (len: number, end = n) => { let s = 0; for (let i = end - len; i < end; i++) s += closes[i]; return s / len; };
  const regime = regimeOf(ind.adx14);
  const votes: Record<string, { vote: Vote; reason: string }> = {};

  votes.turtle_trend = c > ind.breakoutHigh20 ? { vote: 1, reason: "close above the prior 20-bar high" } : c < ind.breakoutLow20 ? { vote: -1, reason: "close below the prior 20-bar low" } : { vote: 0, reason: "inside the 20-bar channel" };

  votes.seykota_mechanical = c > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200 ? { vote: 1, reason: "price above aligned EMA20/50/200" }
    : c < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200 ? { vote: -1, reason: "price below aligned EMA20/50/200" } : { vote: 0, reason: "EMAs not aligned" };

  const s200 = sma(200), s150 = sma(150), s50 = sma(50), s200Prev = n - 20 >= 200 ? sma(200, n - 20) : NaN;
  const win = rows.slice(-Math.min(n, 250)), hi52 = Math.max(...win.map(r => r[2])), lo52 = Math.min(...win.map(r => r[3]));
  const tpl = [c > s150 && c > s200, s150 > s200, s50 > s150, c > s50, s200 > s200Prev, c >= 1.3 * lo52, c >= 0.75 * hi52];
  const passed = tpl.filter(Boolean).length;
  votes.minervini_vcp = passed === tpl.length ? { vote: 1, reason: "all 7 trend-template conditions pass (candle-adapted, long-only)" } : { vote: 0, reason: passed + "/7 trend-template conditions pass; long-only, so no short vote" };

  const box = rows.slice(n - 11, n - 1), top = Math.max(...box.map(r => r[2])), bottom = Math.min(...box.map(r => r[3]));
  const tight = top - bottom <= 4 * ind.atr14;
  votes.darvas_box = c > top && tight && ind.volumeRatio >= 1.25 ? { vote: 1, reason: "close above a tight 10-bar box on volume (long-only)" }
    : { vote: 0, reason: c > top ? "box breakout lacks tightness or volume confirmation" : "no box breakout" };

  const base = rows.slice(n - 45, n - 5), lo = Math.min(...base.map(r => r[3])), hi = Math.max(...base.map(r => r[2])), recent = rows.slice(n - 5);
  votes.wyckoff_supply_demand = Math.min(...recent.map(r => r[3])) < lo && c > lo ? { vote: 1, reason: "spring: pierced the range low and closed back inside" }
    : Math.max(...recent.map(r => r[2])) > hi && c < hi ? { vote: -1, reason: "upthrust: pierced the range high and closed back inside" } : { vote: 0, reason: "no spring or upthrust in the last 5 bars" };

  votes.ptj_structure_preservation = c > s200 ? { vote: 1, reason: "price above the 200-bar average" } : c < s200 ? { vote: -1, reason: "price below the 200-bar average" } : { vote: 0, reason: "at the 200-bar average" };

  const results: ModuleResult[] = MODULE_META.map(m => {
    const base: Omit<ModuleResult, "status" | "vote" | "reason"> = { moduleId: m.id, name: m.name, trader: m.trader, documentedPrinciple: m.principle, family: m.family };
    if (m.requires) return { ...base, status: "not_applicable", vote: 0, reason: "needs " + m.requires + ", which candle data does not carry; not simulated" };
    if (m.family === "validation") return { ...base, status: "validation", vote: 0, reason: "evaluated against the per-chart replay" };
    if (m.family === "breakout" && regime.state === "range") return { ...base, status: "suppressed", vote: 0, reason: "range regime: breakouts fail often (" + votes[m.id].reason + ")" };
    if (m.family === "range_reversal" && regime.state === "trend") return { ...base, status: "suppressed", vote: 0, reason: "trend regime: counter-trend reversals suppressed (" + votes[m.id].reason + ")" };
    return { ...base, status: "active", vote: votes[m.id].vote, reason: votes[m.id].reason };
  });
  return { regime, results };
}

export function stanceOf(r: ModuleResult, direction: 1 | -1): Stance {
  if (r.status === "not_applicable") return "not_applicable";
  if (r.status === "suppressed") return "suppressed";
  if (r.status === "validation") return "validation";
  return r.vote === 0 ? "neutral" : r.vote === direction ? "supporting" : "opposing";
}

export function attributionFor(results: ModuleResult[], direction: 1 | -1): AttributionEntry[] {
  return results.map(r => {
    const stance = stanceOf(r, direction);
    return { trader: r.trader, documentedPrinciple: r.documentedPrinciple, moduleId: r.moduleId, family: r.family, stance, vote: r.vote, status: r.status, contribution: stance.toUpperCase().replace("_", " ") + ": " + r.reason };
  });
}

export function stanceCounts(results: ModuleResult[], direction: 1 | -1) {
  let supporting = 0, opposing = 0;
  for (const r of results) { const s = stanceOf(r, direction); if (s === "supporting") supporting++; else if (s === "opposing") opposing++; }
  return { supporting, opposing };
}

export function statEdge(v: { sampleCount: number; wins: number; winRate: number | null }): StatEdge {
  if (v.sampleCount < 20 || v.winRate === null) return { sampleCount: v.sampleCount, winRate: v.winRate, z: null, verdict: "insufficient_sample" };
  const z = Number(((v.wins - v.sampleCount / 2) / Math.sqrt(v.sampleCount / 4)).toFixed(2));
  return { sampleCount: v.sampleCount, winRate: v.winRate, z, verdict: z >= 1.64 ? "positive_edge" : z <= -1.64 ? "negative_edge" : "no_edge" };
}

export function edgeAttribution(e: StatEdge): AttributionEntry {
  const meta = MODULE_META.find(m => m.id === "simons_quant")!;
  const stance: Stance = e.verdict === "positive_edge" ? "supporting" : e.verdict === "negative_edge" ? "opposing" : "neutral";
  const text = e.verdict === "insufficient_sample" ? "fewer than 20 resolved replay samples; no statistical claim" : "replay win rate " + e.winRate + "% over n=" + e.sampleCount + " (z=" + e.z + "): " + e.verdict.replace("_", " ");
  return { trader: meta.trader, documentedPrinciple: meta.principle, moduleId: meta.id, family: "validation", stance, vote: 0, status: "validation", contribution: stance.toUpperCase() + ": " + text };
}

/** Half-Kelly sizing (Ed Thorp's documented sizing idea), applied only when the replay shows a statistically significant edge. */
export function kellySizing(v: { sampleCount: number; winRate: number | null }, e: StatEdge): PositionSizing {
  const method = "half-Kelly on the TP1-vs-stop replay (1R reward : 1R risk), capped at 1% of equity";
  if (e.verdict !== "positive_edge" || v.winRate === null) return { method, suggestedRiskPercent: 0, basis: "no statistically demonstrated edge (" + e.verdict.replace("_", " ") + ")", note: "Sizing is withheld rather than guessed. Educational output, not financial advice." };
  const p = v.winRate / 100, half = (2 * p - 1) / 2;
  return { method, suggestedRiskPercent: Number(Math.min(1, Math.max(0, half * 100)).toFixed(2)), basis: "win rate " + v.winRate + "% over n=" + v.sampleCount, note: "Simulation excludes fees and slippage; treat as an upper bound. Educational output, not financial advice." };
}

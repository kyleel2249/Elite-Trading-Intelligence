// Multi-timeframe analysis: 1Y, 1M, 1w, 1d, 4h, 1h, 30m, 15m, 5m, 1m.
// Higher timeframes establish CONTEXT; lower timeframes are for EXECUTION timing. Disagreement is reported, never averaged away.
// Only CLOSED candles are analysed, so no signal repaints when the forming candle moves.
import type { Kline } from "../market.ts";
import { technicalAnalysis, isFullAnalysis, MIN_CANDLES, type TechnicalAnalysis } from "./technical.ts";
import { clamp, round, stanceOf, unavailableReport, type EngineReport, type Finding, type Stance } from "./types.ts";

export const MTF_TIMEFRAMES = ["1Y", "1M", "1w", "1d", "4h", "1h", "30m", "15m", "5m", "1m"] as const;
export type MtfTimeframe = typeof MTF_TIMEFRAMES[number];
export type Layer = "context" | "setup" | "execution";
export type MtfStrategy = "scalp" | "intraday" | "swing" | "position";
export const TF_LAYER: Record<MtfTimeframe, Layer> = { "1Y": "context", "1M": "context", "1w": "context", "1d": "context", "4h": "setup", "1h": "setup", "30m": "execution", "15m": "execution", "5m": "execution", "1m": "execution" };
export const TF_SECS: Record<Exclude<MtfTimeframe, "1Y" | "1M">, number> = { "1w": 604800, "1d": 86400, "4h": 14400, "1h": 3600, "30m": 1800, "15m": 900, "5m": 300, "1m": 60 };
const IN_LAYER_WEIGHT: Record<MtfTimeframe, number> = { "1Y": 0.15, "1M": 0.25, "1w": 0.30, "1d": 0.30, "4h": 0.55, "1h": 0.45, "30m": 0.30, "15m": 0.30, "5m": 0.25, "1m": 0.15 };
export const LAYER_WEIGHT: Record<MtfStrategy, Record<Layer, number>> = {
  scalp: { context: 0.2, setup: 0.3, execution: 0.5 }, intraday: { context: 0.3, setup: 0.4, execution: 0.3 },
  swing: { context: 0.45, setup: 0.4, execution: 0.15 }, position: { context: 0.6, setup: 0.3, execution: 0.1 },
};
/** The 1-minute frame is noise for slow strategies, so it is only analysed where appropriate. */
export const oneMinuteAppropriate = (s: MtfStrategy) => s === "scalp" || s === "intraday";
/** Provider interval string for each timeframe (yearly is derived from monthly). */
export const PROVIDER_INTERVAL: Record<MtfTimeframe, string> = { "1Y": "1M", "1M": "1M", "1w": "1w", "1d": "1d", "4h": "4h", "1h": "1h", "30m": "30m", "15m": "15m", "5m": "5m", "1m": "1m" };

export function periodEnd(tf: MtfTimeframe, openTime: number): number {
  if (tf === "1M") { const d = new Date(openTime); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
  if (tf === "1Y") { const d = new Date(openTime); return Date.UTC(d.getUTCFullYear() + 1, 0, 1); }
  return openTime + TF_SECS[tf] * 1000;
}
/** Removes the still-forming last candle (and any candle from the future). */
export function closedCandles(tf: MtfTimeframe, rows: Kline[], now = Date.now()): Kline[] {
  let end = rows.length;
  while (end > 0 && periodEnd(tf, rows[end - 1][0]) > now) end--;
  return rows.slice(0, end);
}
/** Aggregates monthly candles into calendar-year candles (UTC). The first year may be partial if the provider history starts mid-year. */
export function aggregateYearly(monthly: Kline[]): { rows: Kline[]; partialFirstYear: boolean } {
  const byYear = new Map<number, Kline[]>();
  for (const r of [...monthly].sort((a, b) => a[0] - b[0])) { const y = new Date(r[0]).getUTCFullYear(); (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(r); }
  const rows: Kline[] = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, ms]) => [Date.UTC(y, 0, 1), ms[0][1], Math.max(...ms.map(m => m[2])), Math.min(...ms.map(m => m[3])), ms.at(-1)![4], ms.reduce((s, m) => s + m[5], 0)] as Kline);
  const first = [...monthly].sort((a, b) => a[0] - b[0])[0];
  return { rows, partialFirstYear: !!first && new Date(first[0]).getUTCMonth() !== 0 };
}

/** Light macro-context for series too short for full structure analysis (typical for 1Y and sometimes 1M). Confidence is capped low by design. */
export function macroContext(symbol: string, tf: MtfTimeframe, rows: Kline[], minCandles: number, now = Date.now()): EngineReport {
  if (rows.length < minCandles) return unavailableReport(`macro:${tf}`, "technical", symbol, `Only ${rows.length} closed ${tf} candles; ${minCandles} needed for a context read`, [`${tf} history`], now);
  const last = rows.at(-1)!, prev = rows.at(-2)!, prev2 = rows.at(-3);
  const hi = Math.max(...rows.map(r => r[2])), lo = Math.min(...rows.map(r => r[3])), pos = (last[4] - lo) / (hi - lo || 1);
  const findings: Finding[] = [];
  let score = 0;
  const closeUp = last[4] > prev[4];
  score += closeUp ? 25 : -25; findings.push({ id: "close", kind: "close_vs_prior", stance: closeUp ? "bullish" : "bearish", strength: 50, description: `Latest closed ${tf} candle closed ${closeUp ? "above" : "below"} the prior one` });
  const hh = last[2] > prev[2], hl = last[3] > prev[3], lh = last[2] < prev[2], ll = last[3] < prev[3];
  if (hh && hl) { score += 25; findings.push({ id: "hhhl", kind: "market_structure", stance: "bullish", strength: 55, description: `${tf}: higher high and higher low versus the prior candle` }); }
  else if (lh && ll) { score -= 25; findings.push({ id: "lhll", kind: "market_structure", stance: "bearish", strength: 55, description: `${tf}: lower high and lower low versus the prior candle` }); }
  if (prev2) { const run = last[4] > prev[4] && prev[4] > prev2[4] ? 1 : last[4] < prev[4] && prev[4] < prev2[4] ? -1 : 0; score += run * 15; if (run) findings.push({ id: "run", kind: "momentum", stance: run > 0 ? "bullish" : "bearish", strength: 45, description: `Three consecutive ${run > 0 ? "higher" : "lower"} ${tf} closes` }); }
  const zone = pos > 0.66 ? 1 : pos < 0.33 ? -1 : 0; score += zone * 10;
  findings.push({ id: "range", kind: "range_position", stance: zone > 0 ? "bullish" : zone < 0 ? "bearish" : "neutral", strength: 35, description: `Price is in the ${zone > 0 ? "upper" : zone < 0 ? "lower" : "middle"} third of the full ${tf} range (${round(pos * 100, 0)}th percentile of ${round(lo, 4)}-${round(hi, 4)})` });
  const dd = (hi - last[4]) / hi * 100;
  if (dd > 50) { score -= 10; findings.push({ id: "dd", kind: "drawdown", stance: "bearish", strength: 40, description: `Price is ${round(dd, 0)}% below the ${tf}-range high` }); }
  score = clamp(score, -100, 100);
  return { engine: `macro:${tf}`, domain: "technical", subject: symbol, stance: stanceOf(score, 25), score, confidence: round(Math.min(40, 10 + rows.length * 2), 0), confidenceType: "evidence_quality_not_probability", status: "partial", completeness: round(Math.min(1, rows.length / MIN_CANDLES), 2), findings,
    warnings: [`Only ${rows.length} ${tf} candles: a limited sample, so this is a coarse context read; confidence is capped`], missing: [`${tf} history for full structure analysis (${MIN_CANDLES} candles)`], sources: [{ name: `${tf} OHLCV candles`, retrievedAt: new Date(now).toISOString() }], asOf: new Date(last[0]).toISOString(),
    methodology: "Coarse candle-to-candle structure, 3-close run, range position and drawdown. Used only where history is too short for swing-pivot structure analysis." };
}

export interface TimeframeResult { timeframe: MtfTimeframe; layer: Layer; closedCandles: number; mode: "full" | "macro" | "unavailable" | "skipped"; report: EngineReport; analysis: TechnicalAnalysis | null; note?: string }
export interface LayerView { layer: Layer; stance: Stance; score: number; confidence: number; used: MtfTimeframe[]; unavailable: MtfTimeframe[] }
export interface MtfAnalysis {
  symbol: string; strategy: MtfStrategy; timeframes: TimeframeResult[]; layers: Record<Layer, LayerView>;
  alignment: "aligned_bullish" | "aligned_bearish" | "conflicted" | "mixed" | "insufficient"; conflicts: string[]; guidance: string[]; report: EngineReport;
}
export interface MtfInput { symbol: string; strategy: MtfStrategy; candles: Partial<Record<MtfTimeframe, Kline[]>>; now?: number; includeOneMinute?: boolean; detail?: "full" | "lite"; benchmark?: { symbol: string; candles: Partial<Record<MtfTimeframe, Kline[]>> } }

export function multiTimeframeAnalysis(inp: MtfInput): MtfAnalysis {
  const now = inp.now ?? Date.now(), strategy = inp.strategy, results: TimeframeResult[] = [];
  const useOneMin = inp.includeOneMinute ?? oneMinuteAppropriate(strategy);
  for (const tf of MTF_TIMEFRAMES) {
    const layer = TF_LAYER[tf];
    if (tf === "1m" && !useOneMin) { results.push({ timeframe: tf, layer, closedCandles: 0, mode: "skipped", report: unavailableReport("technical:1m", "technical", inp.symbol, `1m is excluded for the ${strategy} strategy (noise exceeds signal at this holding period)`, [], now), analysis: null, note: "skipped by design" }); continue; }
    let raw: Kline[] | undefined = inp.candles[tf], note: string | undefined;
    if (tf === "1Y") {
      const m = inp.candles["1Y"] ?? (inp.candles["1M"] ? aggregateYearly(closedCandles("1M", inp.candles["1M"], now)).rows : undefined);
      raw = m ? (inp.candles["1Y"] ? m : closedYears(m, now)) : undefined;
      if (inp.candles["1M"] && !inp.candles["1Y"] && aggregateYearly(inp.candles["1M"]).partialFirstYear) note = "First year in the history is partial (provider history starts mid-year)";
    }
    if (!raw || !raw.length) { results.push({ timeframe: tf, layer, closedCandles: 0, mode: "unavailable", report: unavailableReport(`technical:${tf}`, "technical", inp.symbol, `No ${tf} candles supplied`, [`${tf} candles`], now), analysis: null }); continue; }
    const closed = tf === "1Y" ? raw : closedCandles(tf, raw, now);
    const bench = inp.benchmark?.candles[tf];
    const secs = tf === "1Y" ? 31536000 : tf === "1M" ? 2629800 : TF_SECS[tf];
    if (closed.length >= MIN_CANDLES) {
      const a = technicalAnalysis(inp.symbol, tf, closed, { now, detail: inp.detail, timeframeSeconds: secs, benchmark: bench && inp.benchmark ? { symbol: inp.benchmark.symbol, candles: tf === "1Y" || tf === "1M" ? bench : closedCandles(tf, bench, now) } : undefined, maxStaleBars: tf === "1M" || tf === "1w" ? 2 : 3 });
      results.push({ timeframe: tf, layer, closedCandles: closed.length, mode: isFullAnalysis(a) ? "full" : "unavailable", report: a.report, analysis: isFullAnalysis(a) ? a : null, note });
    } else if (tf === "1Y" || tf === "1M" || tf === "1w") {
      results.push({ timeframe: tf, layer, closedCandles: closed.length, mode: "macro", report: macroContext(inp.symbol, tf, closed, tf === "1Y" ? 3 : 8, now), analysis: null, note });
    } else results.push({ timeframe: tf, layer, closedCandles: closed.length, mode: "unavailable", report: unavailableReport(`technical:${tf}`, "technical", inp.symbol, `Only ${closed.length} closed ${tf} candles (< ${MIN_CANDLES})`, [`${tf} candles`], now), analysis: null });
  }
  const layers = {} as Record<Layer, LayerView>;
  for (const layer of ["context", "setup", "execution"] as Layer[]) {
    const rs = results.filter(r => r.layer === layer && r.report.status !== "unavailable");
    const skipped = results.filter(r => r.layer === layer && r.report.status === "unavailable").map(r => r.timeframe);
    let wsum = 0, s = 0, c = 0;
    for (const r of rs) { const w = IN_LAYER_WEIGHT[r.timeframe] * (0.4 + 0.6 * r.report.confidence / 100); wsum += w; s += w * r.report.score; c += w * r.report.confidence; }
    const score = wsum ? s / wsum : 0, conf = wsum ? c / wsum : 0;
    layers[layer] = { layer, stance: wsum ? stanceOf(score, 15) : "unavailable", score: round(score), confidence: round(conf, 0), used: rs.map(r => r.timeframe), unavailable: skipped.filter(t => !(t === "1m" && !useOneMin)) };
  }
  const conflicts: string[] = [], guidance: string[] = [];
  const dir = (l: LayerView) => (l.stance === "bullish" ? 1 : l.stance === "bearish" ? -1 : 0);
  const pairs: [Layer, Layer][] = [["context", "setup"], ["context", "execution"], ["setup", "execution"]];
  for (const [a, b] of pairs) { const A = layers[a], B = layers[b]; if (dir(A) !== 0 && dir(B) !== 0 && dir(A) !== dir(B)) conflicts.push(`${a} (${A.stance}, ${A.score}) conflicts with ${b} (${B.stance}, ${B.score})`); }
  // Individual high-weight timeframes that disagree with their own layer are surfaced too.
  for (const r of results) { const L = layers[r.layer]; if (r.report.status !== "unavailable" && dir(L) !== 0 && r.report.stance !== "neutral" && ((r.report.stance === "bullish" ? 1 : -1) !== dir(L)) && Math.abs(r.report.score) >= 25) conflicts.push(`${r.timeframe} (${r.report.stance}, ${r.report.score}) disagrees with its ${r.layer} layer`); }
  const lw = LAYER_WEIGHT[strategy], avail = (["context", "setup", "execution"] as Layer[]).filter(l => layers[l].stance !== "unavailable");
  const wTot = avail.reduce((s, l) => s + lw[l], 0), score = wTot ? avail.reduce((s, l) => s + lw[l] * layers[l].score, 0) / wTot : 0;
  const conf0 = wTot ? avail.reduce((s, l) => s + lw[l] * layers[l].confidence, 0) / wTot : 0;
  const structural = conflicts.filter(c => /^(context|setup|execution)/.test(c)).length;
  let alignment: MtfAnalysis["alignment"];
  if (avail.length < 2) alignment = "insufficient";
  else if (structural > 0) alignment = "conflicted";
  else if (avail.every(l => layers[l].stance === "bullish")) alignment = "aligned_bullish";
  else if (avail.every(l => layers[l].stance === "bearish")) alignment = "aligned_bearish";
  else alignment = "mixed";
  const C = layers.context, E = layers.execution, S = layers.setup;
  if (alignment === "conflicted") {
    if (dir(C) !== 0 && dir(E) !== 0 && dir(C) !== dir(E)) guidance.push(`Context is ${C.stance} but execution timeframes are ${E.stance}: price is moving against the larger trend. This is a pullback or a potential reversal; the evidence does not distinguish them yet. Waiting for the execution layer to realign with context is the lower-risk reading; trading it as counter-trend carries structurally lower odds.`);
    else guidance.push("Timeframe layers disagree. No single direction is supported by the weight of evidence; each layer's view is shown separately.");
  } else if (alignment === "aligned_bullish" || alignment === "aligned_bearish") guidance.push(`All available layers lean ${alignment === "aligned_bullish" ? "bullish" : "bearish"}: context, setup and execution evidence agree. Agreement is evidence quality, not certainty.`);
  else if (alignment === "mixed") guidance.push("Some layers are neutral while none contradict another: the market lacks a clear multi-timeframe read.");
  else guidance.push("Fewer than two timeframe layers have usable data: no multi-timeframe conclusion is drawn.");
  if (S.stance !== "unavailable" && C.stance !== "unavailable" && dir(S) === dir(C) && dir(C) !== 0 && dir(E) === 0) guidance.push("Context and setup agree but execution is neutral: the higher timeframes have a direction, the lower ones have not yet offered a timing trigger.");
  const unavailable = results.filter(r => r.mode === "unavailable").map(r => r.timeframe);
  const missing = unavailable.map(t => `${t} candles`);
  const stance: Stance = alignment === "conflicted" ? "conflicted" : alignment === "insufficient" ? "unavailable" : stanceOf(score, 15);
  const conf = clamp(conf0 - structural * 12 - (unavailable.length > 3 ? 10 : 0), 0, 100);
  const findings: Finding[] = (["context", "setup", "execution"] as Layer[]).map(l => ({ id: `layer-${l}`, kind: "layer", stance: layers[l].stance, strength: Math.abs(layers[l].score), description: `${l}: ${layers[l].stance} (score ${layers[l].score}, confidence ${layers[l].confidence}) from ${layers[l].used.join(", ") || "no usable timeframes"}` }));
  const report: EngineReport = { engine: "multi_timeframe", domain: "multi_timeframe", subject: inp.symbol, stance, score: round(score), confidence: round(conf, 0), confidenceType: "evidence_quality_not_probability", status: avail.length === 3 && missing.length <= 2 ? "ok" : alignment === "insufficient" ? "unavailable" : "partial",
    completeness: round(results.filter(r => r.mode === "full" || r.mode === "macro").length / results.filter(r => r.mode !== "skipped").length, 2), findings, warnings: [...conflicts, ...results.filter(r => r.note).map(r => `${r.timeframe}: ${r.note}`)], missing,
    sources: [{ name: "Exchange OHLCV candles (closed candles only)", retrievedAt: new Date(now).toISOString() }], asOf: new Date(now).toISOString(),
    methodology: `Each timeframe is analysed independently on closed candles. Layers: context (1Y,1M,1w,1d), setup (4h,1h), execution (30m,15m,5m,1m${useOneMin ? "" : "; 1m skipped for this strategy"}). Layer weights for ${strategy}: ${JSON.stringify(lw)}. Layers are weighted by timeframe reliability but a layer disagreement is never averaged away: it yields a 'conflicted' stance.` };
  return { symbol: inp.symbol, strategy, timeframes: results, layers, alignment, conflicts: [...new Set(conflicts)], guidance, report };
}
function closedYears(rows: Kline[], now: number) { return rows.filter(r => periodEnd("1Y", r[0]) <= now); }

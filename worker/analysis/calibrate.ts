// Walk-forward calibration of the technical engine. At each step only candles up to that bar are visible (no look-ahead); the outcome is
// the price change `horizon` bars later. Samples are spaced >= horizon bars apart so forward windows never overlap.
import type { Kline } from "../market.ts";
import { lastAtr } from "./atr.ts";
import { isFullAnalysis, technicalAnalysis, MAX_ANALYSED_CANDLES } from "./technical.ts";
import { round } from "./types.ts";

export type Bucket = "strong_bearish" | "bearish" | "neutral" | "bullish" | "strong_bullish";
export interface BucketStats { bucket: Bucket; n: number; meanForwardReturnPct: number; meanForwardAtr: number; hitRate: number | null; hitRateCI95: [number, number] | null; edgeVsBaseline: "none_demonstrated" | "positive" | "negative" | "insufficient_sample" | "not_applicable" }
export interface Calibration {
  timeframe: string; horizonBars: number; samples: number; baselineUpRate: number; buckets: BucketStats[];
  summary: string; caveats: string[];
}
const bucketOf = (score: number): Bucket => (score >= 40 ? "strong_bullish" : score >= 20 ? "bullish" : score <= -40 ? "strong_bearish" : score <= -20 ? "bearish" : "neutral");
/** Wilson score interval: honest about small samples, unlike the naive normal approximation. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = hits / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
export function calibrateTechnical(rows: Kline[], o: { timeframe?: string; horizon?: number; warmup?: number; maxSamples?: number; detail?: "full" | "lite"; /** Test hook: receives the score computed at each sampled bar. */ collect?: { index: number; score: number }[] } = {}): Calibration {
  const horizon = Math.max(1, Math.min(100, o.horizon ?? 10)), warmup = Math.max(80, o.warmup ?? 120), tf = o.timeframe ?? "?", maxSamples = Math.max(10, Math.min(600, o.maxSamples ?? 150));
  const rec: { bucket: Bucket; score: number; ret: number; atr: number }[] = [];
  const last = rows.length - 1 - horizon;
  let start = warmup; const span = last - warmup;
  const step = Math.max(horizon, Math.ceil(span / maxSamples));
  for (let i = start; i <= last; i += step) {
    const win = rows.slice(Math.max(0, i + 1 - MAX_ANALYSED_CANDLES), i + 1), a = technicalAnalysis("CAL", tf, win, { now: win[win.length - 1][0] + 1, detail: o.detail ?? "lite" });
    if (!isFullAnalysis(a)) continue;
    o.collect?.push({ index: i, score: a.report.score });
    const atr = lastAtr(win) || 1, ret = rows[i + horizon][4] - rows[i][4];
    rec.push({ bucket: bucketOf(a.report.score), score: a.report.score, ret: ret / rows[i][4] * 100, atr: ret / atr });
  }
  const baseline = rec.length ? rec.filter(r => r.ret > 0).length / rec.length : 0.5;
  const names: Bucket[] = ["strong_bearish", "bearish", "neutral", "bullish", "strong_bullish"];
  const buckets: BucketStats[] = names.map(b => {
    const xs = rec.filter(r => r.bucket === b), n = xs.length, dir = b.includes("bull") ? 1 : b.includes("bear") ? -1 : 0;
    const mean = (f: (r: typeof xs[0]) => number) => (n ? xs.reduce((s, r) => s + f(r), 0) / n : 0);
    if (dir === 0 || n === 0) return { bucket: b, n, meanForwardReturnPct: round(mean(r => r.ret), 3), meanForwardAtr: round(mean(r => r.atr), 3), hitRate: null, hitRateCI95: null, edgeVsBaseline: "not_applicable" };
    const hits = xs.filter(r => (dir > 0 ? r.ret > 0 : r.ret < 0)).length, ci = wilson(hits, n);
    const ref = dir > 0 ? baseline : 1 - baseline;
    const edge: BucketStats["edgeVsBaseline"] = n < 30 ? "insufficient_sample" : ci[0] > ref ? "positive" : ci[1] < ref ? "negative" : "none_demonstrated";
    return { bucket: b, n, meanForwardReturnPct: round(mean(r => r.ret), 3), meanForwardAtr: round(mean(r => r.atr), 3), hitRate: round(hits / n, 3), hitRateCI95: [round(ci[0], 3), round(ci[1], 3)], edgeVsBaseline: edge };
  });
  const dirB = buckets.filter(b => b.edgeVsBaseline !== "not_applicable");
  const pos = dirB.filter(b => b.edgeVsBaseline === "positive").length, neg = dirB.filter(b => b.edgeVsBaseline === "negative").length, thin = dirB.every(b => b.edgeVsBaseline === "insufficient_sample" || b.n === 0);
  const summary = rec.length < 30 ? `Only ${rec.length} samples: too few to say anything about predictive value.` : thin ? "Directional buckets have too few samples for a conclusion." : neg > 0 ? "At least one directional bucket performed significantly WORSE than its baseline: do not rely on these scores here." : pos > 0 ? "At least one directional bucket beat its baseline with 95% confidence on this history. This is in-sample evidence for this market and timeframe, not a guarantee." : "No directional bucket demonstrated an edge over the baseline on this history.";
  return { timeframe: tf, horizonBars: horizon, samples: rec.length, baselineUpRate: round(baseline, 3), buckets, summary,
    caveats: ["Spaced samples avoid overlapping outcomes, but market regimes are not independent: confidence intervals are optimistic.", "Single-market, single-timeframe results do not generalise; costs, slippage and execution are ignored.", "Running many calibrations and keeping the best one is data-dredging: treat a lone positive result sceptically."] };
}

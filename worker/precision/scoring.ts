// Opportunity score (0-100). Ten configurable components; each maps real evidence to 0-100 with a documented curve.
// A component with no evidence is "unavailable": it is removed (not guessed), the remaining weights are renormalised,
// and the final score is capped (config.incompleteDataCap) so missing evidence can never read as an exceptional setup.
// The score is a research-priority ranking. It is not a probability, and it can never override a failed risk gate.
import type { Volatility, VolClass } from "../algo/indicators.ts";
import type { LiquidityAnalysis } from "../algo/liquidity.ts";
import type { RegimeResult } from "../algo/regime.ts";
import type { Strategy } from "../algo/timeframes.ts";
import type { ValidationResult } from "../algo/validation.ts";
import { BAND_TEXT, bandFor, scoreConfigHash, type PrecisionConfig } from "./config.ts";
import type { FundamentalAssessment, NewsAssessment } from "./context.ts";
import type { ComponentId, HigherTimeframeView, OpportunityScore, ScoreComponent } from "./types.ts";
import { COMPONENT_IDS } from "./types.ts";
import { clamp, interp, round } from "./util.ts";

export interface ScoringInput {
  strategy: Strategy;
  dir: 1 | -1;
  validation: ValidationResult;
  htf: HigherTimeframeView;
  liquidity: LiquidityAnalysis | null;
  bookAvailable: boolean;
  /** Directional order-book support, 0-100, from liquidityForDirection. */
  liquidityScore: number;
  vol: Volatility;
  regime: RegimeResult;
  stopPercent: number;
  costInR: number;
  netRewardRiskTP1: number;
  netRewardRiskFinal: number;
  fundamentals: FundamentalAssessment;
  news: NewsAssessment;
  expectancy: { expectancyR: number; samples: number } | null;
  cfg: PrecisionConfig;
}

export const LABELS: Record<ComponentId, string> = {
  trendAlignment: "Trend alignment", marketStructure: "Market structure", technicalConfirmation: "Technical confirmation", fundamentalAlignment: "Fundamental alignment",
  liquidity: "Liquidity", volatilitySuitability: "Volatility suitability", newsRisk: "News risk", strategyExpectancy: "Historical strategy expectancy",
  executionCosts: "Execution costs", riskReward: "Risk-to-reward (net of costs)",
};

/** Volatility suitability by class. Scalping is hurt most by thin movement (costs dominate); wide-stop strategies tolerate more volatility. */
const VOL_FIT: Record<Strategy, Record<VolClass, number>> = {
  scalp: { low: 50, normal: 90, high: 75, extreme: 20 },
  intraday: { low: 65, normal: 90, high: 65, extreme: 15 },
  swing: { low: 75, normal: 85, high: 65, extreme: 20 },
  position: { low: 80, normal: 85, high: 60, extreme: 20 },
};

type Raw = Omit<ScoreComponent, "effectiveWeight">;

export function buildComponents(i: ScoringInput): Raw[] {
  const w = i.cfg.weights;
  const mk = (id: ComponentId, score: number | null, detail: string): Raw => ({ id, label: LABELS[id], configuredWeight: w[id], score: score === null ? null : round(clamp(score), 1), status: score === null ? "unavailable" : "ok", detail });
  const v = i.validation, dir = i.dir;

  const tech = v.components.technical;
  const htfPart = i.htf.score === null ? null : clamp((i.htf.score * dir + 100) / 2);
  const trend = htfPart === null ? tech : 0.5 * tech + 0.5 * htfPart;

  const structFam = v.independentEvidence.find(f => f.family === "market structure");
  const techConf = 0.4 * v.components.consensus + 0.3 * v.components.volume + 0.3 * (v.supportingFamilies / 5 * 100);

  const liqScore: number | null = !i.bookAvailable ? null : i.liquidity ? i.liquidityScore : null;

  let vol = VOL_FIT[i.strategy][i.vol.classification];
  const stopHeavy = i.stopPercent > 0.8 * i.cfg.gates.maxStopPct;
  if (stopHeavy) vol -= 15;
  if (!i.regime.profile.allowNewEntries) vol = 0;

  const exp = i.expectancy;
  const expScore = !exp || exp.samples < i.cfg.minExpectancySamples ? null : exp.expectancyR <= 0 ? 0 : interp(exp.expectancyR, [[0, 20], [0.1, 45], [0.25, 70], [0.5, 92], [0.75, 100]]);

  const cost = interp(i.costInR, [[0, 100], [0.05, 95], [0.15, 70], [0.3, 30], [0.5, 0]]);
  let rr = interp(i.netRewardRiskFinal, [[0, 0], [1, 0], [1.5, 40], [2.5, 75], [3.5, 100]]);
  if (i.netRewardRiskTP1 < i.cfg.gates.minNetRewardRiskTP1) rr *= 0.8;

  return [
    mk("trendAlignment", trend, htfPart === null ? `EMA/adaptive-band trend ${tech.toFixed(0)}/100; no higher-timeframe data, so trend alignment rests on the setup timeframe alone` : `Setup-timeframe trend ${tech.toFixed(0)}/100, higher-timeframe agreement ${htfPart.toFixed(0)}/100 (${i.htf.direction})`),
    mk("marketStructure", v.components.structure, structFam ? `Structure ${structFam.detail}` : "Swing structure"),
    mk("technicalConfirmation", techConf, `Multi-timeframe consensus ${v.components.consensus.toFixed(0)}, volume flow ${v.components.volume.toFixed(0)}, ${v.supportingFamilies} of 5 independent evidence families supporting (${v.opposingFamilies} opposing)`),
    mk("fundamentalAlignment", i.fundamentals.score, i.fundamentals.status === "available" ? `Supplied fundamentals from ${i.fundamentals.source}` : i.fundamentals.points[0]),
    mk("liquidity", liqScore, !i.bookAvailable ? "No usable order book" : `Order book ${i.liquidity?.status ?? "n/a"}${i.liquidity?.spreadBps != null ? `, spread ${i.liquidity.spreadBps.toFixed(1)} bps` : ""}`),
    mk("volatilitySuitability", vol, `${i.vol.classification} volatility (ATR ${i.vol.atrPercent.toFixed(2)}%) for a ${i.strategy} strategy; regime ${i.regime.regime}${stopHeavy ? "; stop is close to the maximum allowed distance" : ""}`),
    mk("newsRisk", i.news.score, i.news.status === "available" ? (i.news.notes[0] ?? `Supplied news from ${i.news.source}`) : i.news.notes[0]),
    mk("strategyExpectancy", expScore, !exp ? "No measured expectancy is available for this strategy" : exp.samples < i.cfg.minExpectancySamples ? `Only ${exp.samples} outcomes (minimum ${i.cfg.minExpectancySamples}); expectancy not used` : `Measured expectancy ${exp.expectancyR.toFixed(2)}R over ${exp.samples} outcomes`),
    mk("executionCosts", cost, `Round-trip costs are ${i.costInR.toFixed(2)}R of the initial risk`),
    mk("riskReward", rr, `Net reward-to-risk ${i.netRewardRiskFinal.toFixed(2)} at the final target, ${i.netRewardRiskTP1.toFixed(2)} at TP1`),
  ];
}

export const DISCLAIMER = "Research-priority band, not a probability of success. A strong score never overrides a failed risk check.";

export function aggregate(raw: Raw[], cfg: PrecisionConfig): OpportunityScore {
  const total = raw.reduce((s, c) => s + c.configuredWeight, 0);
  const avail = raw.filter(c => c.score !== null && c.configuredWeight > 0);
  const availW = avail.reduce((s, c) => s + c.configuredWeight, 0);
  const unavailable = raw.filter(c => c.score === null && c.configuredWeight > 0).map(c => c.id);
  const components: ScoreComponent[] = raw.map(c => ({ ...c, effectiveWeight: c.score !== null && availW > 0 ? round(c.configuredWeight / availW * 100, 2) : 0 }));
  const hash = scoreConfigHash(cfg);
  if (availW <= 0 || total <= 0) {
    return { value: null, band: "avoid", interpretation: "Nothing could be scored", uncapped: null, capped: false, cap: null, coverage: 0, unavailableComponents: unavailable, components, configHash: hash, disclaimer: DISCLAIMER };
  }
  const uncapped = avail.reduce((s, c) => s + (c.configuredWeight / availW) * (c.score as number), 0);
  const capped = unavailable.length > 0 && uncapped > cfg.incompleteDataCap;
  const value = round(unavailable.length > 0 ? Math.min(uncapped, cfg.incompleteDataCap) : uncapped, 1);
  const band = bandFor(value, cfg);
  const note = unavailable.length ? ` Evidence is missing for: ${unavailable.join(", ")}; the score is limited to ${cfg.incompleteDataCap}.` : "";
  return { value, band, interpretation: BAND_TEXT[band] + (unavailable.length ? " (incomplete evidence)" : ""), uncapped: round(uncapped, 1), capped, cap: unavailable.length ? cfg.incompleteDataCap : null, coverage: round(availW / total, 3), unavailableComponents: unavailable, components, configHash: hash, disclaimer: DISCLAIMER + note };
}

export function scoreSetup(i: ScoringInput): OpportunityScore { return aggregate(buildComponents(i), i.cfg); }
export { COMPONENT_IDS };

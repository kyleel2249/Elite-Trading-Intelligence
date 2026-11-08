// Independent AI signal validation. The engine's proposed direction is treated as ONE input; this module
// re-investigates it from independent evidence families and may reject or downgrade it.
import type { Consensus } from "./timeframes.ts";
import type { RegimeResult } from "./regime.ts";
import type { LiquidityAnalysis } from "./liquidity.ts";
import { liquidityForDirection } from "./liquidity.ts";
import type { EmaFilter, VolumeMomentum, AdaptiveBands } from "./indicators.ts";
import { countertrendAllowed } from "./indicators.ts";
import type { Structure } from "./timeframes.ts";

export type SignalClass = "HIGH_CONVICTION" | "CONFIRMED" | "EARLY" | "HOLD" | "REJECTED";
export interface Weights { technical: number; consensus: number; volume: number; structure: number; liquidity: number; regime: number; riskReward: number; dataIntegrity: number }
export const DEFAULT_VALIDATION_WEIGHTS: Weights = { technical: 20, consensus: 15, volume: 10, structure: 10, liquidity: 15, regime: 10, riskReward: 15, dataIntegrity: 5 };
export interface Thresholds { early: number; confirmed: number; high: number; minRiskReward: number; maxSpreadBps: number }
export const DEFAULT_THRESHOLDS: Thresholds = { early: 50, confirmed: 65, high: 80, minRiskReward: 1.5, maxSpreadBps: 15 };

export interface DataIntegrity { fresh: boolean; providersAgree: boolean; candlesComplete: boolean; ageSec: number; provider: string; notes?: string[] }
export interface RiskContext { withinLimits: boolean; reasons: string[] }
export interface ValidationInput {
  direction: 1 | -1; emaFilter: EmaFilter; bands: AdaptiveBands; volume: VolumeMomentum; structure: Structure; consensus: Consensus; regime: RegimeResult;
  liquidity: LiquidityAnalysis | null; rewardRiskTP1: number; rewardRiskTP3: number; stopExceedsMax: boolean; data: DataIntegrity; risk: RiskContext;
  /** Validated expectancy in R per trade for this setup family; null when not yet measured (never assumed positive). */
  expectancyR: number | null; expectancySamples?: number; weights?: Weights; thresholds?: Thresholds;
}
export interface ValidationResult {
  score: number; classification: SignalClass; components: Record<keyof Weights, number>; weights: Weights; hardFailures: string[]; warnings: string[];
  independentEvidence: { family: string; vote: -1 | 0 | 1; detail: string }[]; supportingFamilies: number; opposingFamilies: number;
  disagreement: null | { proposed: "BUY" | "SELL"; independentView: "BUY" | "SELL" | "NEUTRAL"; explanation: string };
  checklist: { question: string; pass: boolean | null; detail: string }[]; degraded: boolean; liveExecutionAllowed: boolean; reasoning: string[];
}
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const norm = (w: Weights): Weights => { const t = Object.values(w).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / t * 100])) as unknown as Weights; };
const vote = (score: number): -1 | 0 | 1 => (score >= 60 ? 1 : score <= 40 ? -1 : 0);

export function validateSignal(i: ValidationInput): ValidationResult {
  const dir = i.direction, w = norm(i.weights ?? DEFAULT_VALIDATION_WEIGHTS), th = i.thresholds ?? DEFAULT_THRESHOLDS;
  const hard: string[] = [], warn: string[] = [], reasoning: string[] = [];
  const supportPct = (x: number) => clamp((x * dir + 100) / 2);
  const trendScore = clamp((i.emaFilter.alignment === "mixed" ? 50 : i.emaFilter.alignment === (dir > 0 ? "bull" : "bear") ? 85 : 15) * 0.5 + (i.bands.trend === (dir > 0 ? "bull" : "bear") ? 90 : 10) * 0.5);
  const technical = trendScore;
  const consensus = clamp(i.consensus.direction === "neutral" ? 40 : supportPct(i.consensus.weightedScore) * (0.6 + 0.4 * i.consensus.confidence / 100) - i.consensus.opposingWeightShare * 30);
  const volume = supportPct(i.volume.score) - (i.volume.volumeConfirmsPrice ? 0 : 15) - (i.volume.exhaustion ? 15 : 0);
  const structBias = i.structure.bias === "neutral" ? 50 : i.structure.bias === (dir > 0 ? "bull" : "bear") ? 85 : 15;
  const lq = i.liquidity ? liquidityForDirection(i.liquidity, dir, th.maxSpreadBps) : { score: 0, trapNearby: false, notes: ["Order book unavailable"] };
  const regimeFit = i.regime.profile.allowNewEntries ? clamp(({ trend: 85, breakout: 75, range_reversal: 60, defensive: 45, none: 0 } as const)[i.regime.profile.preferred] + (i.regime.regime.includes(dir > 0 ? "bullish" : "bearish") ? 10 : i.regime.regime.includes(dir > 0 ? "bearish" : "bullish") ? -40 : 0)) : 0;
  const rrScore = clamp((i.rewardRiskTP3 / 3.5) * 70 + (i.rewardRiskTP1 >= 1 ? 20 : 0) + (i.stopExceedsMax ? -40 : 10));
  const dataScore = (i.data.fresh ? 40 : 0) + (i.data.providersAgree ? 30 : 0) + (i.data.candlesComplete ? 30 : 0);
  const components = { technical, consensus, volume: clamp(volume), structure: structBias, liquidity: lq.score, regime: regimeFit, riskReward: rrScore, dataIntegrity: dataScore };
  const score = Object.entries(components).reduce((s, [k, v]) => s + (v * (w as any)[k]) / 100, 0);

  // Independent evidence families: correlated indicators inside a family count once.
  const fam = [
    { family: "trend (EMA structure + adaptive bands)", vote: vote(trendScore), detail: `EMA ${i.emaFilter.alignment}, bands ${i.bands.trend}` },
    { family: "volume flow", vote: vote(clamp(volume)), detail: `flow score ${i.volume.score}, confirms price: ${i.volume.volumeConfirmsPrice}` },
    { family: "market structure", vote: vote(structBias), detail: `swing bias ${i.structure.bias}` },
    { family: "order book / liquidity", vote: i.liquidity && i.liquidity.status !== "blocked" ? vote(lq.score) : 0, detail: i.liquidity ? `${i.liquidity.status}, imbalance ${i.liquidity.imbalance?.toFixed(2) ?? "n/a"}` : "unavailable" },
    { family: "multi-timeframe", vote: vote(consensus), detail: `${i.consensus.bullish} bull / ${i.consensus.bearish} bear / ${i.consensus.neutral} neutral` },
  ] as { family: string; vote: -1 | 0 | 1; detail: string }[];
  const supporting = fam.filter(f => f.vote === 1).length, opposing = fam.filter(f => f.vote === -1).length;

  // Hard failures: a high score can never override these.
  if (!i.data.fresh) hard.push("Market data is stale");
  if (!i.data.providersAgree) hard.push("Data providers disagree materially");
  if (!i.data.candlesComplete) hard.push("Candle data incomplete or inconsistent");
  if (!i.regime.profile.allowNewEntries) hard.push(`Regime '${i.regime.regime}' suspends new entries`);
  if (i.rewardRiskTP3 < th.minRiskReward) hard.push(`Reward/risk to TP3 ${i.rewardRiskTP3.toFixed(2)} below minimum ${th.minRiskReward}`);
  if (i.stopExceedsMax) hard.push("Structurally justified stop exceeds the maximum permitted stop distance");
  if (i.expectancyR !== null && i.expectancyR <= 0) hard.push(`Validated expectancy is not positive (${i.expectancyR.toFixed(2)}R over ${i.expectancySamples ?? "?"} samples)`);
  if (!i.risk.withinLimits) hard.push(...(i.risk.reasons.length ? i.risk.reasons : ["Account-level risk limits not satisfied"]));
  if (lq.trapNearby) hard.push("Nearby liquidity trap: large opposing resting order close to entry");
  if (i.liquidity && i.liquidity.status === "blocked") hard.push(...i.liquidity.issues.map(s => "Liquidity: " + s));
  const ctEvidence = clamp((supporting / 5) * 100);
  if (!countertrendAllowed(i.emaFilter, dir, ctEvidence, i.rewardRiskTP3)) hard.push("Countertrend setup lacks sufficient reversal evidence (need >=70/100 and >=3R)");
  if (i.expectancyR === null) warn.push("No validated expectancy yet for this setup family; treated as unproven");

  const degraded = !i.liquidity || i.liquidity.status !== "ok" || i.consensus.degraded;
  if (!i.liquidity) warn.push("Order book unavailable: signal is degraded and live execution is blocked");
  if (i.consensus.degraded) warn.push("Multi-timeframe data incomplete");

  // Disagreement: the proposed direction versus what independent evidence says.
  const net = fam.reduce((s, f) => s + f.vote, 0);
  const proposed = dir > 0 ? "BUY" : "SELL" as const;
  const independentView = net * dir < 0 && opposing >= 2 ? (dir > 0 ? "SELL" : "BUY") : opposing > supporting ? "NEUTRAL" : proposed;
  let disagreement: ValidationResult["disagreement"] = null;
  if (independentView !== proposed) disagreement = { proposed, independentView, explanation: `Proposed ${proposed}, but independent evidence shows ${supporting} supporting vs ${opposing} opposing families: ${fam.filter(f => f.vote === -1).map(f => f.family).join("; ") || "none opposing"}` };

  const need = Math.min(i.regime.profile.minConfirmations, 4);
  // Regimes that demand stricter confirmation (range, reversal, low-vol, breakout) also tighten the EARLY tier.
  const earlyNeed = i.regime.profile.minConfirmations >= 4 ? 3 : 2;
  let cls: SignalClass;
  if (hard.length) cls = "REJECTED";
  else if (opposing >= 3) { cls = "REJECTED"; hard.push("Three or more independent evidence families oppose the proposed direction"); }
  else if (score >= th.high && supporting >= Math.max(4, need)) cls = "HIGH_CONVICTION";
  else if (score >= th.confirmed && supporting >= need) cls = "CONFIRMED";
  else if (score >= th.early && supporting >= earlyNeed) cls = "EARLY";
  else cls = "HOLD";
  if (disagreement && (cls === "HIGH_CONVICTION" || cls === "CONFIRMED")) { cls = cls === "HIGH_CONVICTION" ? "CONFIRMED" : "EARLY"; warn.push("Class downgraded because independent evidence disagrees"); }
  if (i.expectancyR === null && cls === "HIGH_CONVICTION") { cls = "CONFIRMED"; warn.push("HIGH_CONVICTION requires validated positive expectancy; capped at CONFIRMED"); }
  reasoning.push(`Independent score ${score.toFixed(1)}/100; ${supporting} supporting, ${opposing} opposing, ${5 - supporting - opposing} neutral evidence families; class ${cls}.`);
  if (hard.length) reasoning.push("Hard failures: " + hard.join(" | "));

  const checklist = [
    { question: "Is the market trend supportive?", pass: trendScore >= 60, detail: fam[0].detail },
    { question: "Is momentum accelerating or weakening?", pass: !i.volume.exhaustion, detail: i.volume.exhaustion ? "Exhaustion signs" : `flow ${i.volume.score}` },
    { question: "Does volume confirm direction?", pass: i.volume.volumeConfirmsPrice && vote(clamp(volume)) === 1, detail: fam[1].detail },
    { question: "Do relevant timeframes agree?", pass: vote(consensus) === 1, detail: fam[4].detail },
    { question: "Is the market trending or ranging?", pass: null, detail: i.regime.regime },
    { question: "Is sufficient liquidity available?", pass: i.liquidity ? i.liquidity.status === "ok" : null, detail: i.liquidity ? i.liquidity.status : "unavailable" },
    { question: "Is the spread acceptable?", pass: i.liquidity?.spreadBps != null ? i.liquidity.spreadBps <= th.maxSpreadBps : null, detail: i.liquidity?.spreadBps != null ? `${i.liquidity.spreadBps.toFixed(1)} bps` : "n/a" },
    { question: "Is there a nearby liquidity trap?", pass: i.liquidity ? !lq.trapNearby : null, detail: lq.trapNearby ? "yes" : "no" },
    { question: "Is the stop-loss structurally justified?", pass: !i.stopExceedsMax, detail: i.stopExceedsMax ? "exceeds max stop" : "within limit" },
    { question: "Is the potential reward sufficient?", pass: i.rewardRiskTP3 >= th.minRiskReward, detail: `${i.rewardRiskTP3.toFixed(2)}R to TP3` },
    { question: "Does the strategy have positive validated expectancy?", pass: i.expectancyR === null ? null : i.expectancyR > 0, detail: i.expectancyR === null ? "unmeasured" : `${i.expectancyR.toFixed(2)}R` },
    { question: "Are there abnormal market conditions?", pass: i.regime.regime !== "abnormal", detail: i.regime.regime },
    { question: "Does it satisfy account-level risk limits?", pass: i.risk.withinLimits, detail: i.risk.reasons.join("; ") || "ok" },
  ];
  return { score: Number(score.toFixed(1)), classification: cls, components: components as any, weights: w, hardFailures: hard, warnings: warn, independentEvidence: fam, supportingFamilies: supporting, opposingFamilies: opposing,
    disagreement, checklist, degraded, liveExecutionAllowed: !hard.length && !degraded && cls !== "HOLD" && cls !== "REJECTED" && i.data.fresh, reasoning };
}

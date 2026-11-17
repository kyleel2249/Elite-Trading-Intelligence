// ETI Omnisignal X orchestrator (analytical, read-only): Swift engine + Gainz engine -> fusion -> independent validation.
// Produces a decision and trade plan only. It never submits an order and never grants itself permissions;
// any execution must go through the Worker's in-process order safeguards (see execution.ts / safeguards.ts).
import { adaptiveBands, atrSeries, emaFilter, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { analyzeLiquidity, type LiquidityAnalysis } from "./liquidity.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Consensus, type Timeframe, type TimeframeAnalysis } from "./timeframes.ts";
import { DEFAULT_THRESHOLDS, validateSignal, type RiskContext, type Thresholds, type ValidationResult, type Weights } from "./validation.ts";
import { ENGINE_IP, type FusionContext } from "./engine.ts";
import { swiftEngine } from "./swift.ts";
import { gainzEngine } from "./gainz.ts";
import { fuseEngines, type FusionResult } from "./fusion.ts";
import { applyCalibration, type AppliedCalibration, type CalibrationTable } from "./calibration.ts";
import { analyzeFlow, type FlowAnalysis } from "./flow.ts";
import { assessElite, type EliteAssessment } from "./elite.ts";
import { assessFvgConfluence, type FvgConfluence } from "./fvg-confluence.ts";
import { analyzeDerivativesContext, type DerivativesAnalysis } from "./derivatives.ts";
import { calculateTradePlan, type TradePlan } from "./trade-plan.ts";

export interface TimeframeSummary { trend: string; trendScore: number; momentum: number; emaAlignment: string; bandTrend: string; adx: number; atrPercent: number; relativeVolume: number; volumeConfirms: boolean; structureBias: string; divergence: string; choppy: boolean; signalStrength: number; reliability: number }
const summarize = (a: TimeframeAnalysis | null | undefined): TimeframeSummary | null => (a ? { trend: a.trend, trendScore: a.trendScore, momentum: a.momentum, emaAlignment: a.emaAlignment, bandTrend: a.bandTrend, adx: a.adx, atrPercent: a.atrPercent, relativeVolume: a.relativeVolume, volumeConfirms: a.volumeConfirms, structureBias: a.structure.bias, divergence: a.divergence, choppy: a.choppy, signalStrength: a.signalStrength, reliability: a.reliability } : null);
export type FinalDecision = "BUY" | "SELL" | "HOLD" | "REJECTED" | "DATA_UNRELIABLE";
export interface OmnisignalOptions { risk?: RiskContext; expectancyR?: number | null; expectancySamples?: number; providersAgree?: boolean; weights?: Weights; maxSpreadBps?: number; /** Assumed round-trip fees plus slippage in basis points of notional (default 30 = 2x0.10% fee + 2x0.05% slippage). */ roundTripCostBps?: number; maxCostR?: number; /** Fitted reliability table from recorded outcomes. Absent or insufficient means the score stays uncalibrated. */ calibrationTable?: CalibrationTable | null; /** When true, a trade the Elite Trader modules oppose (2+ opposing, none supporting) is downgraded to HOLD. Default false: advisory only. */ eliteGate?: boolean; /** Classification thresholds; merged over DEFAULT_THRESHOLDS. */ thresholds?: Partial<Thresholds>; enabledEngines?: { swift: boolean; gainz: boolean }; equity?: number; riskFraction?: number; maxNotionalFraction?: number; leverage?: number; feeBps?: number; slippageBps?: number; /** When true, active Fair Value Gaps (execution + higher timeframes) adjust the confidence of an already-validated BUY/SELL by at most +/-8 and add an advisory entry note. Never creates, flips or gates a decision. Default false. */ fvg?: boolean }
export interface OmnisignalResult {
  symbol: string; strategy: string; decision: FinalDecision; fusion: FusionResult; validation: ValidationResult | null; liquidity: LiquidityAnalysis | null;
  /** Compact per-timeframe evidence for the eight-timeframe matrix (null where fewer than the minimum candles exist). */
  timeframes: Record<string, TimeframeSummary | null>; consensus: Pick<Consensus, "executionEligible" | "direction" | "weightedScore" | "confidence" | "bullish" | "bearish" | "neutral" | "unavailable" | "conflicts" | "degraded" | "dominantTimeframe"> | null;
  /** Volume-footprint evidence: abnormal activity, absorption, buy/sell pressure proxy. Advisory. */ flow: FlowAnalysis | null;
  derivatives: DerivativesAnalysis | null; tradePlan: TradePlan | null; tradeable: boolean;
  /** Elite Trader research-database assessment of the proposed direction (null when there is no directional proposal). */ elite: EliteAssessment | null;
  /** Fair Value Gap confluence for the proposed direction (null unless enabled via options.fvg). Advisory; can only move confidence by +/-8. */ fvg: FvgConfluence | null;
  entryZone: [number, number] | null; stopLoss: number | null; takeProfits: FusionResult["takeProfits"]; riskRewardToTP3: number | null; confidence: number; confidenceType: "heuristic_score_not_probability";
  calibration: AppliedCalibration; reasons: string[]; generatedAt: string; expiresAt: string | null;
  submitsOrder: false; liveExecutionAllowed: false; intellectualProperty: string;
}
export const DEFAULT_ROUND_TRIP_COST_BPS = 30;
/** Cost assumption from the environment: ETI_ROUND_TRIP_COST_BPS (non-negative number); invalid or missing values fall back to the default. */
export function costBpsFrom(env: { ETI_ROUND_TRIP_COST_BPS?: string } | undefined): number { const v = Number(env?.ETI_ROUND_TRIP_COST_BPS); return env?.ETI_ROUND_TRIP_COST_BPS !== undefined && env.ETI_ROUND_TRIP_COST_BPS !== "" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_ROUND_TRIP_COST_BPS; }
const CAL = "Confidence is an analytical evidence score. It has not been calibrated against recorded outcomes and must not be read as a probability of profit.";

export function runOmnisignal(ctx: FusionContext, o: OmnisignalOptions = {}): OmnisignalResult {
  const r = runOmnisignalCore(ctx, o);
  return o.calibrationTable && r.confidence > 0 ? { ...r, calibration: applyCalibration(o.calibrationTable, r.confidence) } : r;
}
function runOmnisignalCore(ctx: FusionContext, o: OmnisignalOptions): OmnisignalResult {
  const now = ctx.now ?? Date.now(), execTf = EXECUTION_TF[ctx.strategy], rows = ctx.candles[execTf];
  const en = o.enabledEngines ?? { swift: true, gainz: true };
  const disabled = (name: "swift" | "gainz") => ({ engine: name, symbol: ctx.symbol, status: "NEUTRAL" as const, direction: 0 as const, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, confidenceType: "heuristic_score_not_probability" as const, expectedHolding: "n/a", regime: "unknown", evidence: [`${name} engine is disabled by configuration`], invalidation: [], generatedAt: new Date(now).toISOString(), expiresAt: null, details: {} });
  const swift = en.swift ? swiftEngine({ ...ctx, now }) : disabled("swift"), gainz = en.gainz ? gainzEngine({ ...ctx, now }) : disabled("gainz");
  const fusion = fuseEngines(swift, gainz, { ...ctx, now }, { expectancyR: o.expectancyR, expectancySamples: o.expectancySamples });
  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const r = ctx.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const consensusFull = buildConsensus(analyses, ctx.strategy);
  const consensus = { executionEligible: false as const, direction: consensusFull.direction, weightedScore: consensusFull.weightedScore, confidence: consensusFull.confidence, bullish: consensusFull.bullish, bearish: consensusFull.bearish, neutral: consensusFull.neutral, unavailable: consensusFull.unavailable, conflicts: consensusFull.conflicts, degraded: consensusFull.degraded, dominantTimeframe: consensusFull.dominantTimeframe };
  const timeframes = Object.fromEntries(TIMEFRAMES.map(tf => [tf, summarize(analyses[tf])]));
  const base = { symbol: ctx.symbol, strategy: ctx.strategy, fusion, timeframes, consensus, derivatives: ctx.derivatives ? analyzeDerivativesContext(ctx.derivatives, 0, now) : null, generatedAt: new Date(now).toISOString(), confidenceType: "heuristic_score_not_probability" as const, calibration: { status: "uncalibrated" as const, note: CAL }, submitsOrder: false as const, liveExecutionAllowed: false as const, intellectualProperty: ENGINE_IP };
  const result = (decision: FinalDecision, reasons: string[], extra: Partial<OmnisignalResult> = {}): OmnisignalResult => ({ ...base, decision, validation: null, liquidity: null, flow: null, derivatives: base.derivatives, tradePlan: null, tradeable: false, elite: null, fvg: null, entryZone: null, stopLoss: null, takeProfits: null, riskRewardToTP3: null, confidence: 0, reasons, expiresAt: null, ...extra });

  const age = rows && rows.length ? (now - rows.at(-1)![0]) / 1000 : Infinity;
  if (!rows || rows.length < 100 || age < -60 || age > TF_SECONDS[execTf] * 3) return result("DATA_UNRELIABLE", [!rows || rows.length < 100 ? `Execution timeframe ${execTf} has fewer than 100 valid candles` : `Execution candles are stale (${Math.round(age)}s old)`]);
  if (fusion.decision === "HOLD" || fusion.direction === 0) return result("HOLD", fusion.reasoning);

  // Independent validation of the fused trade: the validator re-investigates from its own evidence families and may reject it.
  const dir = fusion.direction as 1 | -1, price = rows.at(-1)![4];
  const derivatives = ctx.derivatives ? analyzeDerivativesContext(ctx.derivatives, dir, now) : null;
  const a = atrSeries(rows).at(-1)!, regime = classifyRegime(rows);
  const liquidity = ctx.depth === undefined ? null : analyzeLiquidity(ctx.depth, price, now, { maxSpreadBps: o.maxSpreadBps ?? DEFAULT_THRESHOLDS.maxSpreadBps });
  const stop = fusion.stopLoss!, tps = fusion.takeProfits!, entry = (fusion.entryZone![0] + fusion.entryZone![1]) / 2, stopPct = Math.abs(entry - stop) / entry * 100;
  const validation = validateSignal({ direction: dir, emaFilter: emaFilter(rows, [20, 50, 200], a), bands: adaptiveBands(rows), volume: volumeMomentum(rows), structure: marketStructure(rows), consensus: consensusFull, regime, liquidity,
    costR: (o.roundTripCostBps ?? DEFAULT_ROUND_TRIP_COST_BPS) / 100 / stopPct, maxCostR: o.maxCostR, rewardRiskTP1: tps[0].rewardRisk, rewardRiskTP3: tps[2].rewardRisk, stopExceedsMax: stopPct > 5, data: { fresh: true, providersAgree: o.providersAgree ?? true, candlesComplete: rows.length >= 100, ageSec: Math.round(age), provider: "unknown" },
    thresholds: { ...DEFAULT_THRESHOLDS, ...o.thresholds }, risk: o.risk ?? { withinLimits: true, reasons: [] }, expectancyR: o.expectancyR ?? null, expectancySamples: o.expectancySamples, weights: o.weights, derivativesAdjustment: derivatives?.scoreAdjustment ?? 0 });
  const flow = analyzeFlow(rows, dir);
  const elite = assessElite(rows, dir, { entryZone: fusion.entryZone, stopLoss: stop, takeProfits: tps }, timeframes[execTf], flow);
  elite.influencesDecision = o.eliteGate === true;
  const fvg = o.fvg === true ? assessFvgConfluence(ctx.candles as Partial<Record<string, import("../market.ts").Kline[]>>, execTf, dir, { entryZone: fusion.entryZone, stopLoss: stop, takeProfits: tps }, now) : null;
  const tradePlan = o.equity && o.riskFraction && (validation.classification === "EARLY" || validation.classification === "CONFIRMED" || validation.classification === "HIGH_CONVICTION") ? calculateTradePlan({ direction: dir, entry, stopLoss: stop, takeProfits: tps.map((t, i) => ({ label: t.label, price: t.price, closeFraction: [0.4, 0.3, 0.3][i] ?? 1 / tps.length })), equity: o.equity, riskFraction: o.riskFraction, maxNotionalFraction: o.maxNotionalFraction, leverage: o.leverage, feeBps: o.feeBps, slippageBps: o.slippageBps }) : null;
  const ctxOut = { validation, liquidity, flow, elite, fvg, derivatives, tradePlan, tradeable: false, entryZone: fusion.entryZone, stopLoss: stop, takeProfits: tps, riskRewardToTP3: tps[2].rewardRisk };
  const reasons = [...fusion.reasoning, ...validation.reasoning, ...validation.warnings, ...(derivatives?.notes ?? []), ...(tradePlan?.notes ?? []), ...(tradePlan?.blockers ?? []), ...(fvg?.available && fvg.factors.length ? [`FVG confluence: ${fvg.summary}`] : []), ...elite.warnings.map(w => `Elite Trader research: ${w}`), ...(flow.available && flow.supports === "opposes" ? ["Volume footprint opposes this direction (" + flow.stanceBias + " pressure proxy)"] : []), ...(flow.available ? flow.flags.filter(f => f.barsAgo === 0 && (f.kind === "thin_move" || f.kind === "climax")).map(f => `Volume footprint: ${f.detail}`) : [])];
  if (!o.providersAgree && o.providersAgree !== undefined) return result("DATA_UNRELIABLE", ["Data providers disagree materially", ...reasons], ctxOut);
  const cls = validation.classification;
  if (cls === "REJECTED") return result("REJECTED", [...reasons, ...validation.hardFailures], ctxOut);
  if (cls === "HOLD") return result("HOLD", reasons, ctxOut);
  if (o.eliteGate === true && elite.alignment === "opposes") return result("HOLD", [...reasons, "Elite Trader gate: documented methodologies oppose this trade, so no entry"], ctxOut);
  const expires = now + TF_SECONDS[execTf] * 6 * 1000;
  const decision = dir > 0 ? "BUY" : "SELL";
  return result(decision, reasons, { ...ctxOut, tradeable: !tradePlan || tradePlan.valid, confidence: fvg ? Math.max(1, Math.min(100, Math.round(Math.min(fusion.confidence, validation.score)) + fvg.confidenceDelta)) : Math.round(Math.min(fusion.confidence, validation.score)), expiresAt: new Date(expires).toISOString() });
}

// ETI Omnisignal X orchestrator (analytical, read-only): Swift engine + Gainz engine -> fusion -> independent validation.
// Produces a decision and trade plan only. It never submits an order and never grants itself permissions;
// any execution must go through the existing server-side risk gateway.
import { adaptiveBands, atrSeries, emaFilter, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { analyzeLiquidity, type LiquidityAnalysis } from "./liquidity.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Consensus, type Timeframe, type TimeframeAnalysis } from "./timeframes.ts";
import { DEFAULT_THRESHOLDS, validateSignal, type RiskContext, type ValidationResult, type Weights } from "./validation.ts";
import { ENGINE_IP, type FusionContext } from "./engine.ts";
import { swiftEngine } from "./swift.ts";
import { gainzEngine } from "./gainz.ts";
import { fuseEngines, type FusionResult } from "./fusion.ts";

export interface TimeframeSummary { trend: string; trendScore: number; momentum: number; emaAlignment: string; bandTrend: string; adx: number; atrPercent: number; relativeVolume: number; volumeConfirms: boolean; structureBias: string; divergence: string; choppy: boolean; signalStrength: number; reliability: number }
const summarize = (a: TimeframeAnalysis | null | undefined): TimeframeSummary | null => (a ? { trend: a.trend, trendScore: a.trendScore, momentum: a.momentum, emaAlignment: a.emaAlignment, bandTrend: a.bandTrend, adx: a.adx, atrPercent: a.atrPercent, relativeVolume: a.relativeVolume, volumeConfirms: a.volumeConfirms, structureBias: a.structure.bias, divergence: a.divergence, choppy: a.choppy, signalStrength: a.signalStrength, reliability: a.reliability } : null);
export type FinalDecision = "BUY" | "SELL" | "HOLD" | "REJECTED" | "DATA_UNRELIABLE";
export interface OmnisignalOptions { risk?: RiskContext; expectancyR?: number | null; expectancySamples?: number; providersAgree?: boolean; weights?: Weights; maxSpreadBps?: number; /** Assumed round-trip fees plus slippage in basis points of notional (default 30 = 2x0.10% fee + 2x0.05% slippage). */ roundTripCostBps?: number; maxCostR?: number; enabledEngines?: { swift: boolean; gainz: boolean } }
export interface OmnisignalResult {
  symbol: string; strategy: string; decision: FinalDecision; fusion: FusionResult; validation: ValidationResult | null; liquidity: LiquidityAnalysis | null;
  /** Compact per-timeframe evidence for the eight-timeframe matrix (null where fewer than the minimum candles exist). */
  timeframes: Record<string, TimeframeSummary | null>; consensus: Pick<Consensus, "direction" | "weightedScore" | "confidence" | "bullish" | "bearish" | "neutral" | "unavailable" | "conflicts" | "degraded" | "dominantTimeframe"> | null;
  entryZone: [number, number] | null; stopLoss: number | null; takeProfits: FusionResult["takeProfits"]; riskRewardToTP3: number | null; confidence: number; confidenceType: "heuristic_score_not_probability";
  calibration: { status: "uncalibrated"; note: string }; reasons: string[]; generatedAt: string; expiresAt: string | null;
  submitsOrder: false; liveExecutionAllowed: false; intellectualProperty: string;
}
export const DEFAULT_ROUND_TRIP_COST_BPS = 30;
/** Cost assumption from the environment: ETI_ROUND_TRIP_COST_BPS (non-negative number); invalid or missing values fall back to the default. */
export function costBpsFrom(env: { ETI_ROUND_TRIP_COST_BPS?: string } | undefined): number { const v = Number(env?.ETI_ROUND_TRIP_COST_BPS); return env?.ETI_ROUND_TRIP_COST_BPS !== undefined && env.ETI_ROUND_TRIP_COST_BPS !== "" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_ROUND_TRIP_COST_BPS; }
const CAL = "Confidence is an analytical evidence score. It has not been calibrated against recorded outcomes and must not be read as a probability of profit.";

export function runOmnisignal(ctx: FusionContext, o: OmnisignalOptions = {}): OmnisignalResult {
  const now = ctx.now ?? Date.now(), execTf = EXECUTION_TF[ctx.strategy], rows = ctx.candles[execTf];
  const en = o.enabledEngines ?? { swift: true, gainz: true };
  const disabled = (name: "swift" | "gainz") => ({ engine: name, symbol: ctx.symbol, status: "NEUTRAL" as const, direction: 0 as const, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, confidenceType: "heuristic_score_not_probability" as const, expectedHolding: "n/a", regime: "unknown", evidence: [`${name} engine is disabled by configuration`], invalidation: [], generatedAt: new Date(now).toISOString(), expiresAt: null, details: {} });
  const swift = en.swift ? swiftEngine({ ...ctx, now }) : disabled("swift"), gainz = en.gainz ? gainzEngine({ ...ctx, now }) : disabled("gainz");
  const fusion = fuseEngines(swift, gainz, { ...ctx, now }, { expectancyR: o.expectancyR, expectancySamples: o.expectancySamples });
  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const r = ctx.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const consensusFull = buildConsensus(analyses, ctx.strategy);
  const consensus = { direction: consensusFull.direction, weightedScore: consensusFull.weightedScore, confidence: consensusFull.confidence, bullish: consensusFull.bullish, bearish: consensusFull.bearish, neutral: consensusFull.neutral, unavailable: consensusFull.unavailable, conflicts: consensusFull.conflicts, degraded: consensusFull.degraded, dominantTimeframe: consensusFull.dominantTimeframe };
  const timeframes = Object.fromEntries(TIMEFRAMES.map(tf => [tf, summarize(analyses[tf])]));
  const base = { symbol: ctx.symbol, strategy: ctx.strategy, fusion, timeframes, consensus, generatedAt: new Date(now).toISOString(), confidenceType: "heuristic_score_not_probability" as const, calibration: { status: "uncalibrated" as const, note: CAL }, submitsOrder: false as const, liveExecutionAllowed: false as const, intellectualProperty: ENGINE_IP };
  const result = (decision: FinalDecision, reasons: string[], extra: Partial<OmnisignalResult> = {}): OmnisignalResult => ({ ...base, decision, validation: null, liquidity: null, entryZone: null, stopLoss: null, takeProfits: null, riskRewardToTP3: null, confidence: 0, reasons, expiresAt: null, ...extra });

  const age = rows && rows.length ? (now - rows.at(-1)![0]) / 1000 : Infinity;
  if (!rows || rows.length < 100 || age < -60 || age > TF_SECONDS[execTf] * 3) return result("DATA_UNRELIABLE", [!rows || rows.length < 100 ? `Execution timeframe ${execTf} has fewer than 100 valid candles` : `Execution candles are stale (${Math.round(age)}s old)`]);
  if (fusion.decision === "HOLD" || fusion.direction === 0) return result("HOLD", fusion.reasoning);

  // Independent validation of the fused trade: the validator re-investigates from its own evidence families and may reject it.
  const dir = fusion.direction as 1 | -1, price = rows.at(-1)![4];
  const a = atrSeries(rows).at(-1)!, regime = classifyRegime(rows);
  const liquidity = ctx.depth === undefined ? null : analyzeLiquidity(ctx.depth, price, now, { maxSpreadBps: o.maxSpreadBps ?? DEFAULT_THRESHOLDS.maxSpreadBps });
  const stop = fusion.stopLoss!, tps = fusion.takeProfits!, entry = (fusion.entryZone![0] + fusion.entryZone![1]) / 2, stopPct = Math.abs(entry - stop) / entry * 100;
  const validation = validateSignal({ direction: dir, emaFilter: emaFilter(rows, [20, 50, 200], a), bands: adaptiveBands(rows), volume: volumeMomentum(rows), structure: marketStructure(rows), consensus: consensusFull, regime, liquidity,
    costR: (o.roundTripCostBps ?? DEFAULT_ROUND_TRIP_COST_BPS) / 100 / stopPct, maxCostR: o.maxCostR, rewardRiskTP1: tps[0].rewardRisk, rewardRiskTP3: tps[2].rewardRisk, stopExceedsMax: stopPct > 5, data: { fresh: true, providersAgree: o.providersAgree ?? true, candlesComplete: rows.length >= 100, ageSec: Math.round(age), provider: "unknown" },
    risk: o.risk ?? { withinLimits: true, reasons: [] }, expectancyR: o.expectancyR ?? null, expectancySamples: o.expectancySamples, weights: o.weights });
  const ctxOut = { validation, liquidity, entryZone: fusion.entryZone, stopLoss: stop, takeProfits: tps, riskRewardToTP3: tps[2].rewardRisk };
  const reasons = [...fusion.reasoning, ...validation.reasoning, ...validation.warnings];
  if (!o.providersAgree && o.providersAgree !== undefined) return result("DATA_UNRELIABLE", ["Data providers disagree materially", ...reasons], ctxOut);
  const cls = validation.classification;
  if (cls === "REJECTED") return result("REJECTED", [...reasons, ...validation.hardFailures], ctxOut);
  if (cls === "HOLD") return result("HOLD", reasons, ctxOut);
  const expires = now + TF_SECONDS[execTf] * 6 * 1000;
  return result(dir > 0 ? "BUY" : "SELL", reasons, { ...ctxOut, confidence: Math.round(Math.min(fusion.confidence, validation.score)), expiresAt: new Date(expires).toISOString() });
}

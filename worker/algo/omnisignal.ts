// ETI Omnisignal X orchestrator (analytical, read-only): Swift engine + Gainz engine -> fusion -> independent validation.
// Produces a decision and trade plan only. It never submits an order and never grants itself permissions;
// any execution must go through the existing server-side risk gateway.
import { adaptiveBands, atrSeries, emaFilter, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { analyzeLiquidity, type LiquidityAnalysis } from "./liquidity.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Timeframe, type TimeframeAnalysis } from "./timeframes.ts";
import { DEFAULT_THRESHOLDS, validateSignal, type RiskContext, type ValidationResult, type Weights } from "./validation.ts";
import { ENGINE_IP, type FusionContext } from "./engine.ts";
import { swiftEngine } from "./swift.ts";
import { gainzEngine } from "./gainz.ts";
import { fuseEngines, type FusionResult } from "./fusion.ts";

export type FinalDecision = "BUY" | "SELL" | "HOLD" | "REJECTED" | "DATA_UNRELIABLE";
export interface OmnisignalOptions { risk?: RiskContext; expectancyR?: number | null; expectancySamples?: number; providersAgree?: boolean; weights?: Weights; maxSpreadBps?: number; enabledEngines?: { swift: boolean; gainz: boolean } }
export interface OmnisignalResult {
  symbol: string; strategy: string; decision: FinalDecision; fusion: FusionResult; validation: ValidationResult | null; liquidity: LiquidityAnalysis | null;
  entryZone: [number, number] | null; stopLoss: number | null; takeProfits: FusionResult["takeProfits"]; riskRewardToTP3: number | null; confidence: number; confidenceType: "heuristic_score_not_probability";
  calibration: { status: "uncalibrated"; note: string }; reasons: string[]; generatedAt: string; expiresAt: string | null;
  submitsOrder: false; liveExecutionAllowed: false; intellectualProperty: string;
}
const CAL = "Confidence is an analytical evidence score. It has not been calibrated against recorded outcomes and must not be read as a probability of profit.";

export function runOmnisignal(ctx: FusionContext, o: OmnisignalOptions = {}): OmnisignalResult {
  const now = ctx.now ?? Date.now(), execTf = EXECUTION_TF[ctx.strategy], rows = ctx.candles[execTf];
  const en = o.enabledEngines ?? { swift: true, gainz: true };
  const disabled = (name: "swift" | "gainz") => ({ engine: name, symbol: ctx.symbol, status: "NEUTRAL" as const, direction: 0 as const, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, confidenceType: "heuristic_score_not_probability" as const, expectedHolding: "n/a", regime: "unknown", evidence: [`${name} engine is disabled by configuration`], invalidation: [], generatedAt: new Date(now).toISOString(), expiresAt: null, details: {} });
  const swift = en.swift ? swiftEngine({ ...ctx, now }) : disabled("swift"), gainz = en.gainz ? gainzEngine({ ...ctx, now }) : disabled("gainz");
  const fusion = fuseEngines(swift, gainz, { ...ctx, now }, { expectancyR: o.expectancyR, expectancySamples: o.expectancySamples });
  const base = { symbol: ctx.symbol, strategy: ctx.strategy, fusion, generatedAt: new Date(now).toISOString(), confidenceType: "heuristic_score_not_probability" as const, calibration: { status: "uncalibrated" as const, note: CAL }, submitsOrder: false as const, liveExecutionAllowed: false as const, intellectualProperty: ENGINE_IP };
  const result = (decision: FinalDecision, reasons: string[], extra: Partial<OmnisignalResult> = {}): OmnisignalResult => ({ ...base, decision, validation: null, liquidity: null, entryZone: null, stopLoss: null, takeProfits: null, riskRewardToTP3: null, confidence: 0, reasons, expiresAt: null, ...extra });

  const age = rows && rows.length ? (now - rows.at(-1)![0]) / 1000 : Infinity;
  if (!rows || rows.length < 100 || age < -60 || age > TF_SECONDS[execTf] * 3) return result("DATA_UNRELIABLE", [!rows || rows.length < 100 ? `Execution timeframe ${execTf} has fewer than 100 valid candles` : `Execution candles are stale (${Math.round(age)}s old)`]);
  if (fusion.decision === "HOLD" || fusion.direction === 0) return result("HOLD", fusion.reasoning);

  // Independent validation of the fused trade: the validator re-investigates from its own evidence families and may reject it.
  const dir = fusion.direction as 1 | -1, price = rows.at(-1)![4];
  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const r = ctx.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const consensus = buildConsensus(analyses, ctx.strategy), a = atrSeries(rows).at(-1)!, regime = classifyRegime(rows);
  const liquidity = ctx.depth === undefined ? null : analyzeLiquidity(ctx.depth, price, now, { maxSpreadBps: o.maxSpreadBps ?? DEFAULT_THRESHOLDS.maxSpreadBps });
  const stop = fusion.stopLoss!, tps = fusion.takeProfits!, entry = (fusion.entryZone![0] + fusion.entryZone![1]) / 2, stopPct = Math.abs(entry - stop) / entry * 100;
  const validation = validateSignal({ direction: dir, emaFilter: emaFilter(rows, [20, 50, 200], a), bands: adaptiveBands(rows), volume: volumeMomentum(rows), structure: marketStructure(rows), consensus, regime, liquidity,
    rewardRiskTP1: tps[0].rewardRisk, rewardRiskTP3: tps[2].rewardRisk, stopExceedsMax: stopPct > 5, data: { fresh: true, providersAgree: o.providersAgree ?? true, candlesComplete: rows.length >= 100, ageSec: Math.round(age), provider: "unknown" },
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

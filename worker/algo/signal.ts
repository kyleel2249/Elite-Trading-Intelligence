// Orchestrates the full ETI algorithmic signal: 8-timeframe analysis -> consensus -> levels -> independent validation.
import type { Kline } from "../market.ts";
import { adaptiveBands, atrSeries, countertrendAllowed, emaFilter, positionSize, volatility, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { analyzeLiquidity, type DepthSnapshot, type LiquidityAnalysis } from "./liquidity.ts";
import { computeLevels, type TradeLevels } from "./levels.ts";
import { EXECUTION_TF, HOLDING_PERIOD, TF_SECONDS, TIMEFRAMES, analyzeTimeframe, buildConsensus, marketStructure, type Consensus, type Strategy, type Timeframe, type TimeframeAnalysis } from "./timeframes.ts";
import { DEFAULT_THRESHOLDS, validateSignal, type DataIntegrity, type RiskContext, type SignalClass, type Thresholds, type ValidationResult, type Weights } from "./validation.ts";

export interface SignalInput {
  symbol: string; strategy: Strategy; candles: Partial<Record<Timeframe, Kline[]>>; depth?: DepthSnapshot | null; prevLiquidity?: LiquidityAnalysis | null;
  now?: number; provider?: string; providersAgree?: boolean; risk?: RiskContext; expectancyR?: number | null; expectancySamples?: number; equity?: number; riskFraction?: number;
  weights?: Weights; thresholds?: Thresholds; timeframeWeights?: Record<Timeframe, number>; maxStopPct?: number; minConsensusScore?: number;
}
export interface AlgoSignal {
  symbol: string; strategy: Strategy; action: "BUY" | "SELL" | "HOLD"; classification: SignalClass; direction: 1 | -1 | 0; price: number | null;
  entry: number | null; entryZone: [number, number] | null; stopLoss: number | null; takeProfits: TradeLevels["targets"] | null; riskReward: number | null;
  confidence: number; confidenceType: "heuristic_score_not_probability"; expectedHolding: string; supportingIndicators: string[];
  consensus: Consensus; timeframes: Partial<Record<Timeframe, TimeframeAnalysis | null>>; regime: ReturnType<typeof classifyRegime> | null; liquidity: LiquidityAnalysis | null;
  validation: ValidationResult | null; levels: TradeLevels | null; positionSize: number | null; generatedAt: string; expiresAt: string | null; invalidation: string[]; notes: string[];
  tradeable: boolean; liveExecutionAllowed: boolean; ownIntellectualProperty: string;
}
const IP = "Independently engineered from publicly described technical-analysis concepts. No third-party source code or proprietary algorithm is used or reproduced.";

export function buildSignal(inp: SignalInput): AlgoSignal {
  const now = inp.now ?? Date.now(), strategy = inp.strategy, execTf = EXECUTION_TF[strategy], th = inp.thresholds ?? DEFAULT_THRESHOLDS;
  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {};
  for (const tf of TIMEFRAMES) { const rows = inp.candles[tf]; analyses[tf] = rows ? analyzeTimeframe(tf, rows) : null; }
  const consensus = buildConsensus(analyses, strategy, inp.timeframeWeights);
  const base = { symbol: inp.symbol, strategy, timeframes: analyses, consensus, generatedAt: new Date(now).toISOString(), expectedHolding: HOLDING_PERIOD[strategy], confidenceType: "heuristic_score_not_probability" as const, ownIntellectualProperty: IP };
  const hold = (notes: string[], extra: Partial<AlgoSignal> = {}): AlgoSignal => ({ ...base, action: "HOLD", classification: "HOLD", direction: 0, price: null, entry: null, entryZone: null, stopLoss: null, takeProfits: null, riskReward: null, confidence: 0,
    supportingIndicators: [], regime: null, liquidity: null, validation: null, levels: null, positionSize: null, expiresAt: null, invalidation: [], notes, tradeable: false, liveExecutionAllowed: false, ...extra });

  const rows = inp.candles[execTf];
  const execA = analyses[execTf];
  if (!rows || !execA) return hold([`Execution timeframe ${execTf} has fewer than 100 valid candles; no recommendation is forced`]);
  const price = rows.at(-1)![4];
  const lastAge = (now - rows.at(-1)![0]) / 1000;
  const fresh = lastAge >= -60 && lastAge <= TF_SECONDS[execTf] * 3;
  const regime = classifyRegime(rows);
  const liquidity = inp.depth === undefined ? null : analyzeLiquidity(inp.depth, price, now, { maxSpreadBps: th.maxSpreadBps, prev: inp.prevLiquidity });
  const minScore = inp.minConsensusScore ?? 15;
  if (consensus.direction === "neutral" || Math.abs(consensus.weightedScore) < minScore)
    return hold(["Evidence is insufficient or mixed: HOLD is a valid outcome", ...consensus.conflicts], { price, regime, liquidity });
  const dir: 1 | -1 = consensus.direction === "bull" ? 1 : -1;

  const a = atrSeries(rows).at(-1)!, vol = volatility(rows), ef = emaFilter(rows, [20, 50, 200], a), bands = adaptiveBands(rows), vm = volumeMomentum(rows), st = marketStructure(rows);
  const levels = computeLevels(price, dir, a, vol.classification, st, { stopMult: regime.profile.stopMult, maxStopPct: inp.maxStopPct ?? 5 });
  const data: DataIntegrity = { fresh, providersAgree: inp.providersAgree ?? true, candlesComplete: rows.length >= 100, ageSec: Math.round(lastAge), provider: inp.provider ?? "unknown" };
  const validation = validateSignal({ direction: dir, emaFilter: ef, bands, volume: vm, structure: st, consensus, regime, liquidity, rewardRiskTP1: levels.targets[0].rewardRisk, rewardRiskTP3: levels.riskRewardToTP3,
    stopExceedsMax: levels.exceedsMaxStop, data, risk: inp.risk ?? { withinLimits: true, reasons: [] }, expectancyR: inp.expectancyR ?? null, expectancySamples: inp.expectancySamples, weights: inp.weights, thresholds: th });
  const cls = validation.classification;
  const actionable = cls === "EARLY" || cls === "CONFIRMED" || cls === "HIGH_CONVICTION";
  const size = inp.equity && inp.riskFraction ? positionSize(inp.equity, inp.riskFraction * regime.profile.exposureScale, price, levels.stop, vol.classification) : null;
  const expires = now + TF_SECONDS[execTf] * 8 * 1000;
  const supporting = [`EMA alignment ${ef.alignment}`, `Adaptive bands ${bands.trend}`, `Volume-weighted momentum ${vm.score}`, `Consensus ${consensus.bullish}B/${consensus.bearish}S/${consensus.neutral}N`, `Regime ${regime.regime}`, ...(liquidity ? [`Liquidity ${liquidity.status}`] : [])];
  return { ...base, action: actionable ? (dir > 0 ? "BUY" : "SELL") : "HOLD", classification: cls, direction: actionable ? dir : 0, price, entry: actionable ? levels.entry : null, entryZone: actionable ? levels.entryZone : null,
    stopLoss: actionable ? levels.stop : null, takeProfits: actionable ? levels.targets : null, riskReward: actionable ? levels.riskRewardToTP3 : null, confidence: Math.round(validation.score), supportingIndicators: supporting, regime, liquidity, validation, levels: actionable ? levels : null,
    positionSize: actionable ? size : null, expiresAt: actionable ? new Date(expires).toISOString() : null,
    invalidation: actionable ? [`Close beyond stop ${levels.stop.toFixed(4)}`, "Adaptive band flips against the position with volume confirmation", "Data becomes stale or providers disagree", "Regime becomes abnormal", `Signal expires ${new Date(expires).toISOString()}`, "Stops are never widened to avoid a loss"] : [],
    notes: [...validation.warnings, ...(validation.disagreement ? [validation.disagreement.explanation] : []), ...validation.hardFailures], tradeable: actionable && validation.hardFailures.length === 0, liveExecutionAllowed: validation.liveExecutionAllowed };
}

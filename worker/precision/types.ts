// Public contract of the ETI PRECISION SIGNAL ENGINE. Every field of a signal is declared here.
import type { Strategy, Timeframe } from "../algo/timeframes.ts";
import type { VolClass } from "../algo/indicators.ts";

export type Direction = "BUY" | "SELL" | "NO TRADE";
/** Markets with a real data adapter. Anything else is rejected, never approximated. */
export type MarketId = "crypto_spot";

export const COMPONENT_IDS = [
  "trendAlignment", "marketStructure", "technicalConfirmation", "fundamentalAlignment", "liquidity",
  "volatilitySuitability", "newsRisk", "strategyExpectancy", "executionCosts", "riskReward",
] as const;
export type ComponentId = typeof COMPONENT_IDS[number];

export type ScoreBand = "exceptional" | "strong" | "potential" | "weak" | "avoid";

export interface ScoreComponent {
  id: ComponentId; label: string;
  /** Weight as configured. */
  configuredWeight: number;
  /** Weight actually applied after unavailable components are removed and the rest renormalised (0 when unavailable). */
  effectiveWeight: number;
  /** 0-100, or null when the evidence for this component is unavailable. */
  score: number | null;
  status: "ok" | "unavailable";
  detail: string;
}

export interface OpportunityScore {
  /** 0-100. Null only when nothing could be scored at all (no usable market data). */
  value: number | null;
  band: ScoreBand;
  interpretation: string;
  /** Score before the incomplete-data cap. */
  uncapped: number | null;
  capped: boolean;
  cap: number | null;
  /** Share of the configured weight that had real evidence behind it (0-1). */
  coverage: number;
  unavailableComponents: ComponentId[];
  components: ScoreComponent[];
  /** Fingerprint of the weights/bands/cap that produced this score. A calibration model is only valid for the fingerprint it was fitted on. */
  configHash: string;
  disclaimer: string;
}

export interface GateResult {
  id: string; label: string;
  status: "pass" | "fail" | "not_evaluated";
  /** A failed gate is always hard: no score can override it. */
  detail: string;
}

export interface TakeProfit {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  /** Gross reward-to-risk before costs. */
  rewardRisk: number;
  /** Reward-to-risk after round-trip costs are charged to both reward and risk. */
  netRewardRisk: number;
  /** Fraction of the position the plan closes here. */
  closeFraction: number;
  limitedByStructure: boolean;
}

export interface CostEstimate {
  feeBpsPerSide: number;
  feeSource: "configured";
  spreadBps: number | null;
  spreadSource: "order_book" | "unavailable";
  slippageBpsPerSide: { entry: number; exit: number };
  slippageSource: "order_book_walk" | "assumed";
  referenceNotionalQuote: number | null;
  roundTripBps: number;
  roundTripPrice: number;
  /** Round-trip cost expressed in units of initial risk (stop distance). */
  costInR: number;
  excludes: string[];
  note: string;
}

export interface HigherTimeframeView {
  direction: "bullish" | "bearish" | "neutral" | "unavailable";
  /** Weighted trend score, -100..100, or null when unavailable. */
  score: number | null;
  timeframes: { timeframe: Timeframe; trend: "bull" | "bear" | "neutral"; trendScore: number }[];
  /** True when the higher-timeframe direction agrees with the trade; null when neutral or unavailable. */
  alignsWithTrade: boolean | null;
}

export interface NewsEventView { title: string; time: string; impact: "low" | "medium" | "high"; sentiment: number | null; scheduled: boolean; source: string | null; url: string | null }
export type ContextStatus = "available" | "unavailable" | "stale";

export interface EvidenceItem { family: string; stance: "supporting" | "opposing" | "neutral"; detail: string }
export interface AttributionItem { method: string; family: string; stance: "supporting" | "opposing" | "neutral"; detail: string }

export type Confidence =
  | {
    type: "calibrated_probability";
    /** Estimated probability that the setup meets the model's outcome definition. Only emitted from a validated, out-of-sample-tested model. */
    probability: number;
    interval95: { low: number; high: number };
    outcomeDefinition: string;
    basis: { samplesInScoreBlock: number; modelSamples: number; testSamples: number; brierScore: number; brierSkill: number; expectedCalibrationError: number; trainedAt: string };
    note: string;
  }
  | {
    type: "qualitative";
    level: "none" | "low" | "moderate" | "high";
    calibration: { status: "no_model" | "rejected"; reasons: string[] };
    note: string;
  };

export interface PrecisionSignal {
  engine: { name: string; version: string; configHash: string; configStatus: "default" | "override_applied" | "override_rejected"; ownIntellectualProperty: string };
  signalId: string;
  asset: { symbol: string; base: string | null; quote: string | null; name: string };
  tradingPair: string;
  ticker: string;
  market: MarketId | "unsupported";
  direction: Direction;
  decision: { tradeable: boolean; reasons: string[] };
  entry: number | null;
  entryZone: [number, number] | null;
  stopLoss: number | null;
  takeProfits: TakeProfit[];
  tp3: { included: boolean; reason: string };
  riskReward: { grossToFinalTarget: number | null; netToFinalTarget: number | null; finalTarget: "TP1" | "TP2" | "TP3" | null };
  transactionCosts: CostEstimate | null;
  strategy: Strategy;
  setupTimeframe: Timeframe;
  expectedHolding: string;
  higherTimeframeDirection: HigherTimeframeView;
  technicalJustification: string[];
  fundamentalJustification: { status: ContextStatus; asOf: string | null; source: string | null; points: string[] };
  relevantNews: { status: ContextStatus; asOf: string | null; source: string | null; blackoutActive: boolean; events: NewsEventView[]; notes: string[] };
  marketLiquidity: {
    status: "ok" | "degraded" | "blocked" | "unavailable"; spreadBps: number | null; imbalance: number | null;
    bidDepthQuote: number | null; askDepthQuote: number | null; orderBookAgeMs: number | null;
    largeOrders: { side: "bid" | "ask"; price: number; notional: number; distancePct: number }[]; issues: string[]; caveat: string;
  };
  volatility: { classification: VolClass; atrPercent: number; percentile: number; expansion: boolean; contraction: boolean; regime: string; stopPercent: number | null };
  invalidation: string[];
  expiresAt: string | null;
  validForBars: number;
  dataTimestamp: string;
  dataTimestamps: { fetchedAt: string; latestCandleOpen: string | null; orderBook: string | null };
  confidence: Confidence;
  supportingEvidence: EvidenceItem[];
  strategyAttribution: AttributionItem[];
  opportunityScore: OpportunityScore;
  riskChecks: GateResult[];
  riskCheckSummary: { passed: number; failed: number; notEvaluated: number };
  /** Always false: this engine is analytical. Orders go through POST /api/orders and its in-process paper safeguards. */
  liveExecutionAllowed: false;
  execution: { note: string; requiresRiskPreflight: true };
  dataQuality: { provider: string; timeframesLoaded: Timeframe[]; candleCounts: Partial<Record<Timeframe, number>>; orderBook: "available" | "unavailable"; providerCrossCheck: "not_performed"; notes: string[] };
  disclaimers: string[];
}

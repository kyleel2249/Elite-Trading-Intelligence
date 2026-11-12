// Shared contract that every independent analytical engine publishes into the Omnisignal fusion layer.
import type { Kline } from "../market.ts";
import type { Strategy, Timeframe } from "./timeframes.ts";
import type { DepthSnapshot } from "./liquidity.ts";

export type EngineName = "swift" | "gainz";
export type EngineStatus = "SIGNAL" | "NEUTRAL" | "INVALIDATED";

export interface EngineTarget { label: "TP1" | "TP2" | "TP3"; price: number; rewardRisk: number }
export interface EngineSignal {
  engine: EngineName;
  symbol: string;
  status: EngineStatus;
  /** 1 long, -1 short, 0 none. For INVALIDATED the direction records what was invalidated. */
  direction: 1 | -1 | 0;
  entryZone: [number, number] | null;
  stopLoss: number | null;
  takeProfits: EngineTarget[] | null;
  /** Heuristic evidence score 0-100. Not a probability of profit until calibrated against recorded outcomes. */
  confidence: number;
  confidenceType: "heuristic_score_not_probability";
  expectedHolding: string;
  regime: string;
  evidence: string[];
  invalidation: string[];
  generatedAt: string;
  expiresAt: string | null;
  /** Free-form engine-specific diagnostics (kept machine readable for the dashboard and audit trail). */
  details: Record<string, unknown>;
}

export interface EngineInput {
  symbol: string;
  strategy: Strategy;
  candles: Partial<Record<Timeframe, Kline[]>>;
  now?: number;
  maxStopPct?: number;
}
export interface FusionContext extends EngineInput { depth?: DepthSnapshot | null }

export const ENGINE_IP = "Independently engineered from publicly described technical-analysis concepts. No third-party source code or proprietary algorithm is used or reproduced.";

// Configuration of the ETI PRECISION SIGNAL ENGINE: scoring weights, score bands, risk gates, cost assumptions.
// Everything an operator may tune lives here, is validated, and is fingerprinted so calibration cannot silently outlive it.
import { COMPONENT_IDS, type ComponentId, type ScoreBand } from "./types.ts";
import { hash16, isFiniteNumber, isRecord, stableStringify } from "./util.ts";

export const ENGINE_NAME = "ETI PRECISION SIGNAL ENGINE";
export const ENGINE_VERSION = "1.0.0";
export const ENGINE_IP = "Independently engineered from publicly described technical-analysis concepts. No third-party source code or proprietary algorithm is used or reproduced.";

export interface GateConfig {
  /** Lowest opportunity score that may still produce BUY/SELL. Below it the engine answers NO TRADE. */
  minScoreToSignal: number;
  /** Minimum net (after costs) reward-to-risk at TP1. */
  minNetRewardRiskTP1: number;
  /** Minimum net reward-to-risk at the final (furthest justified) target. */
  minNetRewardRisk: number;
  /** Round-trip costs may consume at most this share of the TP1 reward. */
  maxCostShareOfTP1Reward: number;
  maxSpreadBps: number;
  maxStopPct: number;
  /** When true, no order book means no trade (liquidity cannot be verified). */
  requireOrderBook: boolean;
  /** Minimum absolute multi-timeframe consensus score for a directional candidate. */
  minConsensusScore: number;
  newsBlackoutBeforeMin: number;
  newsBlackoutAfterMin: number;
}
export interface CostConfig { takerFeeBps: number; assumedSlippageBps: number; referenceNotionalQuote: number }
export interface ContextConfig { fundamentalsMaxAgeHours: number; newsMaxAgeHours: number; newsLookbackHours: number; newsLookaheadHours: number; expectancyMaxAgeDays: number }
export interface CalibrationConfig {
  /** Minimum samples in the whole model (train + out-of-sample test). */
  minSamples: number;
  minTestSamples: number;
  minBlockSamples: number;
  /** Maximum out-of-sample expected calibration error. */
  maxEce: number;
  /** Minimum Brier skill versus always predicting the base rate. Must be positive: the model must add information. */
  minSkill: number;
  maxAgeDays: number;
}

export interface PrecisionConfig {
  version: string;
  weights: Record<ComponentId, number>;
  bands: { exceptional: number; strong: number; potential: number; weak: number };
  /** While any component lacks evidence the score cannot exceed this, so missing data can never read as an "exceptional" setup. */
  incompleteDataCap: number;
  /** Bars of the setup timeframe a signal stays valid. */
  expiryBars: number;
  tp3MinRewardRisk: number;
  minExpectancySamples: number;
  gates: GateConfig;
  costs: CostConfig;
  context: ContextConfig;
  calibration: CalibrationConfig;
}

export const DEFAULT_CONFIG: PrecisionConfig = {
  version: "precision-config-1",
  weights: {
    trendAlignment: 15, marketStructure: 10, technicalConfirmation: 12, fundamentalAlignment: 8, liquidity: 12,
    volatilitySuitability: 8, newsRisk: 8, strategyExpectancy: 10, executionCosts: 7, riskReward: 10,
  },
  bands: { exceptional: 90, strong: 80, potential: 70, weak: 50 },
  incompleteDataCap: 79,
  expiryBars: 8,
  tp3MinRewardRisk: 2.5,
  minExpectancySamples: 30,
  gates: {
    minScoreToSignal: 70, minNetRewardRiskTP1: 0.8, minNetRewardRisk: 1.5, maxCostShareOfTP1Reward: 0.35,
    maxSpreadBps: 15, maxStopPct: 5, requireOrderBook: true, minConsensusScore: 15, newsBlackoutBeforeMin: 60, newsBlackoutAfterMin: 30,
  },
  costs: { takerFeeBps: 10, assumedSlippageBps: 5, referenceNotionalQuote: 10_000 },
  context: { fundamentalsMaxAgeHours: 168, newsMaxAgeHours: 12, newsLookbackHours: 24, newsLookaheadHours: 48, expectancyMaxAgeDays: 45 },
  calibration: { minSamples: 300, minTestSamples: 90, minBlockSamples: 30, maxEce: 0.08, minSkill: 0.01, maxAgeDays: 90 },
};

/** Range limits. They stop a typo or a hostile override from disabling a safety check (for example a 0 bps spread limit or 100% cost share). */
const LIMITS: Record<string, [number, number]> = {
  "gates.minScoreToSignal": [50, 100], "gates.minNetRewardRiskTP1": [0.5, 5], "gates.minNetRewardRisk": [1, 10], "gates.maxCostShareOfTP1Reward": [0.05, 0.6],
  "gates.maxSpreadBps": [1, 100], "gates.maxStopPct": [0.1, 15], "gates.minConsensusScore": [10, 60], "gates.newsBlackoutBeforeMin": [0, 720], "gates.newsBlackoutAfterMin": [0, 720],
  "costs.takerFeeBps": [0, 100], "costs.assumedSlippageBps": [0, 200], "costs.referenceNotionalQuote": [100, 100_000_000],
  "context.fundamentalsMaxAgeHours": [1, 24 * 90], "context.newsMaxAgeHours": [0.1, 24 * 7], "context.newsLookbackHours": [1, 24 * 14], "context.newsLookaheadHours": [1, 24 * 14], "context.expectancyMaxAgeDays": [1, 365],
  "calibration.minSamples": [200, 100_000], "calibration.minTestSamples": [60, 50_000], "calibration.minBlockSamples": [20, 5_000], "calibration.maxEce": [0.005, 0.1], "calibration.minSkill": [0.0001, 1], "calibration.maxAgeDays": [1, 730],
  incompleteDataCap: [0, 100], expiryBars: [1, 100], tp3MinRewardRisk: [1.5, 10], minExpectancySamples: [30, 100_000],
};

export function validateConfig(c: PrecisionConfig): string[] {
  const errors: string[] = [];
  let total = 0;
  for (const id of COMPONENT_IDS) {
    const w = c.weights[id];
    if (!isFiniteNumber(w) || w < 0) errors.push(`weights.${id} must be a finite number >= 0`);
    else total += w;
  }
  if (total <= 0) errors.push("weights must not all be zero");
  const b = c.bands;
  if (![b.exceptional, b.strong, b.potential, b.weak].every(isFiniteNumber)) errors.push("bands must be finite numbers");
  else if (!(b.exceptional <= 100 && b.exceptional > b.strong && b.strong > b.potential && b.potential > b.weak && b.weak > 0)) errors.push("bands must satisfy 100 >= exceptional > strong > potential > weak > 0");
  const flat = (o: Record<string, unknown>, prefix = ""): [string, unknown][] => Object.entries(o).flatMap(([k, v]) => isRecord(v) ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]);
  for (const [path, v] of flat(c as unknown as Record<string, unknown>)) {
    const lim = LIMITS[path];
    if (lim) { if (!isFiniteNumber(v) || v < lim[0] || v > lim[1]) errors.push(`${path} must be between ${lim[0]} and ${lim[1]}`); }
  }
  if (typeof c.gates.requireOrderBook !== "boolean") errors.push("gates.requireOrderBook must be a boolean");
  if (c.gates.minNetRewardRiskTP1 > c.gates.minNetRewardRisk) errors.push("gates.minNetRewardRiskTP1 must not exceed gates.minNetRewardRisk");
  if (c.calibration.minTestSamples >= c.calibration.minSamples) errors.push("calibration.minTestSamples must be below calibration.minSamples");
  return errors;
}

/** Merge only keys that already exist with the same type; anything else is reported, not silently accepted. */
function mergeInto(base: Record<string, any>, over: Record<string, unknown>, path: string, errors: string[]): Record<string, any> {
  const out: Record<string, any> = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) { errors.push(`unknown setting ${path}${k}`); continue; }
    const cur = base[k];
    if (isRecord(cur)) {
      if (!isRecord(v)) { errors.push(`${path}${k} must be an object`); continue; }
      out[k] = mergeInto(cur, v, `${path}${k}.`, errors);
    } else if (typeof cur === typeof v) out[k] = v;
    else errors.push(`${path}${k} must be a ${typeof cur}`);
  }
  return out;
}

export interface ResolvedConfig { config: PrecisionConfig; status: "default" | "override_applied" | "override_rejected"; errors: string[] }

/** Apply an operator override (object or JSON string). Any problem rejects the whole override and keeps the defaults. */
export function resolveConfig(override?: unknown): ResolvedConfig {
  if (override === undefined || override === null || override === "") return { config: DEFAULT_CONFIG, status: "default", errors: [] };
  let obj: unknown = override;
  if (typeof override === "string") {
    try { obj = JSON.parse(override); } catch { return { config: DEFAULT_CONFIG, status: "override_rejected", errors: ["override is not valid JSON"] }; }
  }
  if (!isRecord(obj)) return { config: DEFAULT_CONFIG, status: "override_rejected", errors: ["override must be a JSON object"] };
  const errors: string[] = [];
  const merged = mergeInto(DEFAULT_CONFIG as unknown as Record<string, any>, obj, "", errors) as unknown as PrecisionConfig;
  if (errors.length === 0) errors.push(...validateConfig(merged));
  if (errors.length) return { config: DEFAULT_CONFIG, status: "override_rejected", errors };
  return { config: merged, status: "override_applied", errors: [] };
}

/** Fingerprint of everything that changes what a score means. Calibration models are bound to it. */
export function scoreConfigHash(c: PrecisionConfig): string {
  return hash16(stableStringify({ engine: ENGINE_VERSION, weights: c.weights, bands: c.bands, cap: c.incompleteDataCap, tp3: c.tp3MinRewardRisk, minExpectancySamples: c.minExpectancySamples, costs: c.costs }));
}

export function bandFor(score: number, c: PrecisionConfig = DEFAULT_CONFIG): ScoreBand {
  const b = c.bands;
  return score >= b.exceptional ? "exceptional" : score >= b.strong ? "strong" : score >= b.potential ? "potential" : score >= b.weak ? "weak" : "avoid";
}

export const BAND_TEXT: Record<ScoreBand, string> = {
  exceptional: "Exceptional candidate, subject to all risk checks",
  strong: "Strong candidate",
  potential: "Potential opportunity",
  weak: "Weak or incomplete setup",
  avoid: "Avoid",
};

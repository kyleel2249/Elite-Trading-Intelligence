/** Deterministic position-sizing and trade-plan calculator. It never submits orders. */
export interface TradePlanTarget { label?: string; price: number; closeFraction?: number }
export interface TradePlanInput {
  direction: 1 | -1;
  entry: number;
  stopLoss: number;
  takeProfits: TradePlanTarget[];
  equity: number;
  riskFraction: number;
  maxNotionalFraction?: number;
  leverage?: number;
  feeBps?: number;
  slippageBps?: number;
}
export interface TradePlan {
  valid: boolean;
  canSubmitOrder: false;
  direction: 1 | -1;
  entry: number;
  stopLoss: number;
  quantity: number;
  notional: number;
  riskBudget: number;
  plannedStopRisk: number;
  remainingRiskBudget: number;
  riskPerUnit: number;
  stopPercent: number;
  leverage: number;
  estimatedMargin: number;
  estimatedRoundTripCosts: number | null;
  costsConfigured: boolean;
  targets: { label: string; price: number; closeFraction: number; grossProfit: number; rewardRisk: number }[];
  grossRewardRiskToFinalTarget: number | null;
  netRewardRiskToFinalTarget: number | null;
  blockers: string[];
  notes: string[];
}
const finitePositive = (v: number) => Number.isFinite(v) && v > 0;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function calculateTradePlan(input: TradePlanInput): TradePlan {
  const blockers: string[] = [], notes: string[] = [];
  const { direction, entry, stopLoss, takeProfits } = input;
  const equity = input.equity, riskFraction = input.riskFraction;
  const leverage = input.leverage ?? 1, maxNotionalFraction = input.maxNotionalFraction ?? 1;
  const costsConfigured = input.feeBps !== undefined || input.slippageBps !== undefined;
  const feeBps = input.feeBps ?? 0, slippageBps = input.slippageBps ?? 0;
  const riskBudget = finitePositive(equity) && Number.isFinite(riskFraction) && riskFraction > 0 && riskFraction <= 0.05 ? equity * riskFraction : 0;
  const riskPerUnit = Math.abs(entry - stopLoss);
  if (!finitePositive(entry)) blockers.push("Entry price must be positive");
  if (!finitePositive(stopLoss) || (direction === 1 ? stopLoss >= entry : stopLoss <= entry)) blockers.push("Stop-loss must sit beyond entry in the protective direction");
  if (!finitePositive(equity)) blockers.push("Account equity must be positive");
  if (!(Number.isFinite(riskFraction) && riskFraction > 0 && riskFraction <= 0.05)) blockers.push("Risk fraction must be greater than zero and no more than 5%");
  if (!(Number.isFinite(leverage) && leverage >= 1 && leverage <= 100)) blockers.push("Leverage must be between 1x and 100x");
  if (!(Number.isFinite(maxNotionalFraction) && maxNotionalFraction > 0 && maxNotionalFraction <= 1)) blockers.push("Maximum notional fraction must be greater than zero and no more than 100% of equity");
  if (!(Number.isFinite(feeBps) && feeBps >= 0 && feeBps <= 500 && Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps <= 500)) blockers.push("Fee and slippage inputs must be between 0 and 500 basis points");
  if (!Array.isArray(takeProfits) || !takeProfits.length) blockers.push("At least one take-profit target is required");
  const targetsValid = Array.isArray(takeProfits) && takeProfits.every((t, i) =>
    finitePositive(t.price) && (direction === 1 ? t.price > entry : t.price < entry) &&
    (i === 0 || (direction === 1 ? t.price > takeProfits[i - 1].price : t.price < takeProfits[i - 1].price)));
  if (Array.isArray(takeProfits) && takeProfits.length && !targetsValid) blockers.push("Take-profit targets must be positive and strictly ordered away from entry");
  const fractions = Array.isArray(takeProfits) ? takeProfits.map(t => t.closeFraction ?? 1 / takeProfits.length) : [];
  const fractionTotal = fractions.reduce((a, b) => a + b, 0);
  if (fractions.some(f => !Number.isFinite(f) || f <= 0 || f > 1) || fractionTotal > 1.000001) blockers.push("Take-profit close fractions must be positive and total no more than 100%");
  if (!costsConfigured) notes.push("Fees and slippage were not supplied; net reward/risk is not estimated");
  if (blockers.length) return {
    valid: false, canSubmitOrder: false, direction, entry, stopLoss, quantity: 0, notional: 0, riskBudget,
    plannedStopRisk: 0, remainingRiskBudget: riskBudget, riskPerUnit: Number.isFinite(riskPerUnit) ? riskPerUnit : 0,
    stopPercent: 0, leverage, estimatedMargin: 0, estimatedRoundTripCosts: null, costsConfigured, targets: [],
    grossRewardRiskToFinalTarget: null, netRewardRiskToFinalTarget: null, blockers, notes,
  };

  const notionalCap = equity * maxNotionalFraction * leverage;
  const rawQuantity = riskBudget / riskPerUnit;
  const quantity = Math.min(rawQuantity, notionalCap / entry);
  const notional = quantity * entry, plannedStopRisk = quantity * riskPerUnit;
  const costRate = (feeBps + slippageBps) * 2 / 10_000;
  const estimatedRoundTripCosts = costsConfigured ? notional * costRate : null;
  const targets = takeProfits.map((t, i) => {
    const closeFraction = fractions[i];
    const grossProfit = Math.abs(t.price - entry) * quantity * closeFraction;
    return { label: t.label ?? "TP" + (i + 1), price: t.price, closeFraction, grossProfit, rewardRisk: Math.abs(t.price - entry) / riskPerUnit };
  });
  const grossRewardRiskToFinalTarget = targets.length ? targets[targets.length - 1].rewardRisk : null;
  const netRewardRiskToFinalTarget = estimatedRoundTripCosts === null || grossRewardRiskToFinalTarget === null
    ? null : (targets.reduce((sum, t) => sum + t.grossProfit, 0) - estimatedRoundTripCosts) / Math.max(plannedStopRisk, 1e-12);
  if (quantity + 1e-12 < rawQuantity) notes.push("Position quantity was capped by the configured maximum notional");
  if (plannedStopRisk > riskBudget + 1e-8) blockers.push("Calculated stop risk exceeds the configured risk budget");
  return {
    valid: blockers.length === 0, canSubmitOrder: false, direction, entry, stopLoss, quantity, notional, riskBudget,
    plannedStopRisk, remainingRiskBudget: Math.max(0, riskBudget - plannedStopRisk), riskPerUnit,
    stopPercent: riskPerUnit / entry * 100, leverage, estimatedMargin: notional / leverage,
    estimatedRoundTripCosts, costsConfigured, targets, grossRewardRiskToFinalTarget,
    netRewardRiskToFinalTarget, blockers, notes,
  };
}

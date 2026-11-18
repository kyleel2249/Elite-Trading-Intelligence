/**
 * ETI autonomous trading: balanced risk policy (pure functions, no I/O).
 *
 * Step 2 of the autonomous-trading build. This module is not wired into any order path yet; it is the single place the
 * policy numbers and the sizing maths live so later steps (execution lock, pipeline, dashboard) call one implementation.
 *
 * Rules:
 *  - fail closed: any missing, non-finite or inconsistent input rejects the trade;
 *  - the 50% notional cap and 50% cash reserve are limits on top of the risk-based size, never a risk allowance;
 *  - size = (equity x risk fraction) / |entry - stop|, then only ever reduced (caps, exchange step), never raised;
 *  - policy values come from configuration set by a human; nothing here can raise its own limits. Env values more
 *    permissive than HARD_CEILINGS are clamped back to the ceiling.
 */

export interface RiskPolicy {
  /** Fraction of equity risked per trade (distance to stop). */
  riskPerTrade: number;
  /** Max single-position notional as a fraction of equity. */
  maxPositionNotional: number;
  maxConcurrentPositions: number;
  /** Stop opening trades when the day's realized + unrealized loss reaches this fraction of the day's equity baseline. */
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  minRewardToRisk: number;
  maxLeverage: number;
  /** Cash that must stay uncommitted, as a fraction of equity. */
  minCashReserve: number;
  /** Stop opening trades when equity is this far below its peak. */
  maxDrawdown: number;
}

export const DEFAULT_POLICY: RiskPolicy = Object.freeze({
  riskPerTrade: 0.005,
  maxPositionNotional: 0.5,
  maxConcurrentPositions: 3,
  maxDailyLoss: 0.02,
  maxConsecutiveLosses: 3,
  minRewardToRisk: 1.5,
  maxLeverage: 1,
  minCashReserve: 0.5,
  maxDrawdown: 0.1,
});

/** Configuration can tighten the policy freely but can never loosen it past these bounds. */
export const HARD_CEILINGS = Object.freeze({
  riskPerTrade: 0.01,
  maxPositionNotional: 0.5,
  maxConcurrentPositions: 3,
  maxDailyLoss: 0.02,
  maxConsecutiveLosses: 3,
  maxLeverage: 1,
  maxDrawdown: 0.1,
  /** floors (a bigger number is stricter) */
  minRewardToRisk: 1.5,
  minCashReserve: 0.5,
});

const num = (v: unknown): number => (typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN);

/** Build the active policy from environment variables ETI_RISK_*. Invalid values fall back to the default. */
export function parsePolicy(env: Record<string, unknown> = {}): RiskPolicy {
  const upTo = (key: string, def: number, ceiling: number, int = false): number => {
    const n = num(env[key]);
    if (!Number.isFinite(n) || n <= 0 || (int && !Number.isInteger(n))) return def;
    return Math.min(n, ceiling);
  };
  const atLeast = (key: string, def: number, floor: number): number => {
    const n = num(env[key]);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.max(n, floor);
  };
  return {
    riskPerTrade: upTo("ETI_RISK_PER_TRADE", DEFAULT_POLICY.riskPerTrade, HARD_CEILINGS.riskPerTrade),
    maxPositionNotional: upTo("ETI_RISK_MAX_NOTIONAL", DEFAULT_POLICY.maxPositionNotional, HARD_CEILINGS.maxPositionNotional),
    maxConcurrentPositions: upTo("ETI_RISK_MAX_POSITIONS", DEFAULT_POLICY.maxConcurrentPositions, HARD_CEILINGS.maxConcurrentPositions, true),
    maxDailyLoss: upTo("ETI_RISK_MAX_DAILY_LOSS", DEFAULT_POLICY.maxDailyLoss, HARD_CEILINGS.maxDailyLoss),
    maxConsecutiveLosses: upTo("ETI_RISK_MAX_CONSECUTIVE_LOSSES", DEFAULT_POLICY.maxConsecutiveLosses, HARD_CEILINGS.maxConsecutiveLosses, true),
    minRewardToRisk: atLeast("ETI_RISK_MIN_REWARD_RISK", DEFAULT_POLICY.minRewardToRisk, HARD_CEILINGS.minRewardToRisk),
    maxLeverage: upTo("ETI_RISK_MAX_LEVERAGE", DEFAULT_POLICY.maxLeverage, HARD_CEILINGS.maxLeverage),
    minCashReserve: atLeast("ETI_RISK_MIN_CASH_RESERVE", DEFAULT_POLICY.minCashReserve, HARD_CEILINGS.minCashReserve),
    maxDrawdown: upTo("ETI_RISK_MAX_DRAWDOWN", DEFAULT_POLICY.maxDrawdown, HARD_CEILINGS.maxDrawdown),
  };
}

// ------------------------------------------------------------------ account-level limits

export interface AccountState {
  /** Current total equity (cash + open positions at mark). */
  equity: number;
  /** Cash not committed to positions. */
  availableCash: number;
  /** Cash promised to pending orders, withdrawals or transfers. */
  pendingCommitments: number;
  /** Equity at the start of the current risk day (reconciled baseline). */
  dayBaselineEquity: number;
  /** Realized + unrealized P/L since the baseline (negative = loss). */
  dayPnl: number;
  /** Highest reconciled equity seen. */
  peakEquity: number;
  consecutiveLosses: number;
  openPositions: number;
  /** Wallet and positions reconciled this cycle with no unresolved discrepancy. */
  walletReconciled: boolean;
  /** Market data for the instrument passed freshness and consistency checks. */
  marketDataFresh: boolean;
  killSwitch: boolean;
  /** True while a previous limit breach has not been reviewed and cleared. */
  haltedForReview: boolean;
}

export type RejectCode =
  | "invalid_input"
  | "kill_switch"
  | "halted_for_review"
  | "wallet_not_reconciled"
  | "stale_market_data"
  | "daily_loss_limit"
  | "drawdown_limit"
  | "consecutive_losses"
  | "max_positions"
  | "leverage_not_allowed"
  | "bad_stop_side"
  | "reward_to_risk"
  | "no_trading_capital"
  | "below_min_order";

export interface Rejection { code: RejectCode; detail: string }

const fin = (...v: number[]) => v.every((x) => Number.isFinite(x));

/** Limits that stop ALL new entries regardless of the instrument. Returns every breach found (empty = clear). */
export function evaluateAccountLimits(a: AccountState, p: RiskPolicy = DEFAULT_POLICY): Rejection[] {
  const out: Rejection[] = [];
  if (!fin(a.equity, a.availableCash, a.pendingCommitments, a.dayBaselineEquity, a.dayPnl, a.peakEquity, a.consecutiveLosses, a.openPositions) || a.equity <= 0 || a.dayBaselineEquity <= 0 || a.peakEquity <= 0 || a.availableCash < 0 || a.pendingCommitments < 0) {
    return [{ code: "invalid_input", detail: "Account state is missing, non-finite or non-positive; refusing to trade." }];
  }
  if (a.killSwitch) out.push({ code: "kill_switch", detail: "Kill switch is active." });
  if (a.haltedForReview) out.push({ code: "halted_for_review", detail: "A previous risk breach has not been reviewed and cleared." });
  if (!a.walletReconciled) out.push({ code: "wallet_not_reconciled", detail: "Wallet and positions are not reconciled; no new entries." });
  if (!a.marketDataFresh) out.push({ code: "stale_market_data", detail: "Market data is stale, missing or inconsistent." });
  const dayLoss = a.dayPnl < 0 ? -a.dayPnl / a.dayBaselineEquity : 0;
  if (dayLoss >= p.maxDailyLoss) out.push({ code: "daily_loss_limit", detail: `Daily loss ${(dayLoss * 100).toFixed(2)}% reached the ${(p.maxDailyLoss * 100).toFixed(2)}% limit.` });
  const dd = a.peakEquity > a.equity ? (a.peakEquity - a.equity) / a.peakEquity : 0;
  if (dd >= p.maxDrawdown) out.push({ code: "drawdown_limit", detail: `Drawdown ${(dd * 100).toFixed(2)}% reached the ${(p.maxDrawdown * 100).toFixed(2)}% limit.` });
  if (a.consecutiveLosses >= p.maxConsecutiveLosses) out.push({ code: "consecutive_losses", detail: `${a.consecutiveLosses} consecutive losses reached the limit of ${p.maxConsecutiveLosses}.` });
  if (a.openPositions >= p.maxConcurrentPositions) out.push({ code: "max_positions", detail: `${a.openPositions} open positions reached the limit of ${p.maxConcurrentPositions}.` });
  return out;
}

/** Cash the engine may deploy: available cash minus the mandatory reserve and pending commitments. Never negative. */
export function availableTradingCapital(a: Pick<AccountState, "equity" | "availableCash" | "pendingCommitments">, p: RiskPolicy = DEFAULT_POLICY): number {
  const v = a.availableCash - p.minCashReserve * a.equity - a.pendingCommitments;
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

// ------------------------------------------------------------------ per-trade sizing

export interface TradeRequest {
  side: "long" | "short";
  entry: number;
  stop: number;
  takeProfit: number;
  /** Leverage the venue/order would use (1 = none). */
  leverage?: number;
  /** Per-side fee rate, e.g. 0.001 = 0.1%. */
  feeRate: number;
  /** Per-side slippage estimate as a rate of price. */
  slippageRate: number;
  /** Exchange quantity increment (> 0). */
  qtyStep: number;
  minQty: number;
  minNotional: number;
}

export interface SizingDecision {
  approved: boolean;
  quantity: number;
  notional: number;
  /** Loss if the stop fills at the stop price, excluding costs. */
  riskAmount: number;
  /** Same, plus modelled round-trip fees and slippage. */
  riskInclCosts: number;
  netRewardToRisk: number;
  availableCapital: number;
  /** Which limit set the final size: risk, notional, capital or step. */
  bindingConstraint: "risk" | "notional" | "capital" | "none";
  rejections: Rejection[];
}

const decimalsOf = (step: number): number => {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]) + (s.split("e-")[0].split(".")[1]?.length ?? 0);
  return s.split(".")[1]?.length ?? 0;
};

/** Round a quantity DOWN to the exchange increment. */
export function floorToStep(qty: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(qty) || qty <= 0) return 0;
  const floored = Math.floor(qty / step + 1e-9) * step;
  return Number(floored.toFixed(Math.min(12, decimalsOf(step))));
}

const reject = (rejections: Rejection[], extra: Partial<SizingDecision> = {}): SizingDecision => ({
  approved: false, quantity: 0, notional: 0, riskAmount: 0, riskInclCosts: 0, netRewardToRisk: 0, availableCapital: 0, bindingConstraint: "none", rejections, ...extra,
});

/** Full pre-trade decision: account limits, trade validity, reward-to-risk after costs, and the capped position size. */
export function sizeTrade(a: AccountState, t: TradeRequest, p: RiskPolicy = DEFAULT_POLICY): SizingDecision {
  const gate = evaluateAccountLimits(a, p);
  if (gate.length) return reject(gate);

  if (!fin(t.entry, t.stop, t.takeProfit, t.feeRate, t.slippageRate, t.qtyStep, t.minQty, t.minNotional) || t.entry <= 0 || t.stop <= 0 || t.takeProfit <= 0 || t.feeRate < 0 || t.slippageRate < 0 || t.qtyStep <= 0 || t.minQty < 0 || t.minNotional < 0) {
    return reject([{ code: "invalid_input", detail: "Trade request has missing or non-finite prices, costs or exchange limits." }]);
  }
  const leverage = t.leverage ?? 1;
  if (!(leverage >= 1) || leverage > p.maxLeverage) return reject([{ code: "leverage_not_allowed", detail: `Leverage ${leverage}x exceeds the allowed ${p.maxLeverage}x.` }]);

  const long = t.side === "long";
  const stopOk = long ? t.stop < t.entry : t.stop > t.entry;
  const tpOk = long ? t.takeProfit > t.entry : t.takeProfit < t.entry;
  if (!stopOk || !tpOk) return reject([{ code: "bad_stop_side", detail: `For a ${t.side} the stop must be on the losing side and the target on the winning side of entry.` }]);

  const riskPerUnit = Math.abs(t.entry - t.stop);
  const rewardPerUnit = Math.abs(t.takeProfit - t.entry);
  const costPerUnit = t.entry * 2 * (t.feeRate + t.slippageRate);
  const netRR = (rewardPerUnit - costPerUnit) / (riskPerUnit + costPerUnit);
  if (!(netRR >= p.minRewardToRisk)) {
    return reject([{ code: "reward_to_risk", detail: `Net reward-to-risk ${Number.isFinite(netRR) ? netRR.toFixed(2) : "n/a"} after costs is below the ${p.minRewardToRisk}:1 minimum.` }], { netRewardToRisk: Number.isFinite(netRR) ? netRR : 0 });
  }

  const capital = availableTradingCapital(a, p);
  if (!(capital > 0)) return reject([{ code: "no_trading_capital", detail: "No cash is available after the mandatory reserve and pending commitments." }], { netRewardToRisk: netRR, availableCapital: 0 });

  const riskBudget = a.equity * p.riskPerTrade;
  const byRisk = riskBudget / riskPerUnit;
  const byNotional = (a.equity * p.maxPositionNotional) / t.entry;
  const byCapital = capital / (t.entry * (1 + t.feeRate + t.slippageRate));
  const raw = Math.min(byRisk, byNotional, byCapital);
  const binding: SizingDecision["bindingConstraint"] = raw === byRisk ? "risk" : raw === byNotional ? "notional" : "capital";
  const quantity = floorToStep(raw, t.qtyStep);
  const notional = quantity * t.entry;

  if (!(quantity > 0) || quantity < t.minQty || notional < t.minNotional) {
    return reject([{ code: "below_min_order", detail: `Permitted size ${quantity} (notional ${notional.toFixed(2)}) is below the exchange minimum (qty ${t.minQty}, notional ${t.minNotional}). The minimum is never forced upward past the risk budget.` }], { netRewardToRisk: netRR, availableCapital: capital, bindingConstraint: binding });
  }

  return {
    approved: true,
    quantity,
    notional,
    riskAmount: quantity * riskPerUnit,
    riskInclCosts: quantity * (riskPerUnit + costPerUnit),
    netRewardToRisk: netRR,
    availableCapital: capital,
    bindingConstraint: binding,
    rejections: [],
  };
}

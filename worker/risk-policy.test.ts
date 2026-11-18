import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, availableTradingCapital, evaluateAccountLimits, floorToStep, parsePolicy, sizeTrade } from "./risk/policy.ts";
import type { AccountState, TradeRequest } from "./risk/policy.ts";

const account = (o: Partial<AccountState> = {}): AccountState => ({
  equity: 10000, availableCash: 10000, pendingCommitments: 0, dayBaselineEquity: 10000, dayPnl: 0, peakEquity: 10000,
  consecutiveLosses: 0, openPositions: 0, walletReconciled: true, marketDataFresh: true, killSwitch: false, haltedForReview: false, ...o,
});
const trade = (o: Partial<TradeRequest> = {}): TradeRequest => ({
  side: "long", entry: 100, stop: 98, takeProfit: 104, feeRate: 0.001, slippageRate: 0.0005, qtyStep: 0.001, minQty: 0.001, minNotional: 10, ...o,
});
const codes = (d: { rejections: { code: string }[] }) => d.rejections.map((r) => r.code);

test("sizes by risk: 0.5% of equity over the stop distance", () => {
  const d = sizeTrade(account(), trade());
  assert.equal(d.approved, true);
  assert.equal(d.quantity, 25); // 50 / 2
  assert.equal(d.riskAmount, 50);
  assert.equal(d.bindingConstraint, "risk");
  assert.ok(d.netRewardToRisk >= 1.5);
});

test("rejects when reward-to-risk after costs is below 1.5", () => {
  const d = sizeTrade(account(), trade({ takeProfit: 102 }));
  assert.equal(d.approved, false);
  assert.deepEqual(codes(d), ["reward_to_risk"]);
});

test("50% notional cap and capital cap reduce a tight-stop position", () => {
  const d = sizeTrade(account(), trade({ stop: 99.9, takeProfit: 101 }));
  assert.equal(d.approved, true);
  assert.ok(d.notional <= 5000 + 1e-6);
  assert.ok(d.quantity <= 49.93);
  assert.notEqual(d.bindingConstraint, "risk");
  assert.ok(d.riskAmount <= 50 + 1e-9, "never risks more than the budget");
});

test("mandatory cash reserve and pending commitments are never deployed", () => {
  assert.equal(availableTradingCapital(account({ availableCash: 6000 })), 1000);
  assert.equal(availableTradingCapital(account({ availableCash: 6000, pendingCommitments: 400 })), 600);
  assert.equal(availableTradingCapital(account({ availableCash: 4000 })), 0);
  const d = sizeTrade(account({ availableCash: 5000 }), trade());
  assert.deepEqual(codes(d), ["no_trading_capital"]);
  const small = sizeTrade(account({ availableCash: 6000 }), trade());
  assert.equal(small.approved, true);
  assert.ok(small.notional <= 1000);
  assert.equal(small.bindingConstraint, "capital");
});

test("minimum order size is never forced above the permitted size", () => {
  const d = sizeTrade(account(), trade({ minQty: 30 }));
  assert.equal(d.approved, false);
  assert.deepEqual(codes(d), ["below_min_order"]);
  assert.equal(sizeTrade(account(), trade({ minNotional: 5000 })).approved, false);
});

test("daily loss limit uses realized + unrealized loss against the baseline", () => {
  assert.deepEqual(evaluateAccountLimits(account({ dayPnl: -199 })), []);
  const hit = evaluateAccountLimits(account({ dayPnl: -200 }));
  assert.deepEqual(hit.map((r) => r.code), ["daily_loss_limit"]);
  assert.equal(sizeTrade(account({ dayPnl: -250 }), trade()).approved, false);
  assert.deepEqual(evaluateAccountLimits(account({ dayPnl: 500 })), [], "a profit is not a breach");
});

test("drawdown, consecutive losses and position count stop new entries", () => {
  assert.deepEqual(evaluateAccountLimits(account({ peakEquity: 11200 })).map((r) => r.code), ["drawdown_limit"]);
  assert.deepEqual(evaluateAccountLimits(account({ peakEquity: 10900 })), []);
  assert.deepEqual(evaluateAccountLimits(account({ consecutiveLosses: 3 })).map((r) => r.code), ["consecutive_losses"]);
  assert.deepEqual(evaluateAccountLimits(account({ openPositions: 3 })).map((r) => r.code), ["max_positions"]);
});

test("fails closed on kill switch, review halt, unreconciled wallet and stale data", () => {
  const d = sizeTrade(account({ killSwitch: true, haltedForReview: true, walletReconciled: false, marketDataFresh: false }), trade());
  assert.equal(d.approved, false);
  assert.deepEqual(codes(d).sort(), ["halted_for_review", "kill_switch", "stale_market_data", "wallet_not_reconciled"]);
});

test("fails closed on invalid or non-finite input", () => {
  assert.deepEqual(codes(sizeTrade(account({ equity: NaN }), trade())), ["invalid_input"]);
  assert.deepEqual(codes(sizeTrade(account({ equity: 0 }), trade())), ["invalid_input"]);
  assert.deepEqual(codes(sizeTrade(account(), trade({ entry: NaN }))), ["invalid_input"]);
  assert.deepEqual(codes(sizeTrade(account(), trade({ qtyStep: 0 }))), ["invalid_input"]);
});

test("stop and target must be on the correct side; shorts are mirrored", () => {
  assert.deepEqual(codes(sizeTrade(account(), trade({ stop: 102 }))), ["bad_stop_side"]);
  assert.deepEqual(codes(sizeTrade(account(), trade({ takeProfit: 96 }))), ["bad_stop_side"]);
  const s = sizeTrade(account(), trade({ side: "short", stop: 102, takeProfit: 96 }));
  assert.equal(s.approved, true);
  assert.equal(s.quantity, 25);
});

test("leverage above 1x is rejected", () => {
  assert.deepEqual(codes(sizeTrade(account(), trade({ leverage: 2 }))), ["leverage_not_allowed"]);
  assert.equal(sizeTrade(account(), trade({ leverage: 1 })).approved, true);
});

test("floorToStep rounds down and handles float noise", () => {
  assert.equal(floorToStep(49.92511, 0.001), 49.925);
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(floorToStep(0.0004, 0.001), 0);
  assert.equal(floorToStep(5, 1), 5);
  assert.equal(floorToStep(NaN, 1), 0);
});

test("configuration can tighten the policy but never loosen it past the ceilings", () => {
  assert.deepEqual(parsePolicy({}), DEFAULT_POLICY);
  const loose = parsePolicy({ ETI_RISK_PER_TRADE: "0.5", ETI_RISK_MAX_LEVERAGE: "10", ETI_RISK_MAX_POSITIONS: "20", ETI_RISK_MIN_CASH_RESERVE: "0.1", ETI_RISK_MIN_REWARD_RISK: "0.5", ETI_RISK_MAX_DAILY_LOSS: "0.5" });
  assert.equal(loose.riskPerTrade, 0.01);
  assert.equal(loose.maxLeverage, 1);
  assert.equal(loose.maxConcurrentPositions, 3);
  assert.equal(loose.minCashReserve, 0.5);
  assert.equal(loose.minRewardToRisk, 1.5);
  assert.equal(loose.maxDailyLoss, 0.02);
  const tight = parsePolicy({ ETI_RISK_PER_TRADE: "0.002", ETI_RISK_MIN_CASH_RESERVE: "0.7", ETI_RISK_MAX_POSITIONS: "2" });
  assert.equal(tight.riskPerTrade, 0.002);
  assert.equal(tight.minCashReserve, 0.7);
  assert.equal(tight.maxConcurrentPositions, 2);
  assert.deepEqual(parsePolicy({ ETI_RISK_PER_TRADE: "abc", ETI_RISK_MAX_POSITIONS: "1.5" }).maxConcurrentPositions, 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { assertSameScope, buildCapitalSnapshot, reconcileLedger, toAccountState } from "./risk/capital.ts";
import type { CycleContext, LedgerInput } from "./risk/capital.ts";
import { sizeTrade } from "./risk/policy.ts";

const ledger = (o: Partial<LedgerInput> = {}): LedgerInput => ({
  environment: "paper", accountId: "main", cash: 8000, reservedFunds: 500, pendingTransfers: 100,
  positions: [{ symbol: "BTCUSDT", qty: 0.1, avgPrice: 20000, markPrice: 21000 }], realizedPnl: 40, fees: 12, ...o,
});
const ctx = (o: Partial<CycleContext> = {}): CycleContext => ({
  dayBaselineEquity: 10000, dayPnl: 0, peakEquity: 10100, consecutiveLosses: 0, marketDataFresh: true, killSwitch: false, haltedForReview: false, discrepancies: [], ...o,
});

test("snapshot: equity, exposure, unrealized P/L and available trading capital", () => {
  const s = buildCapitalSnapshot(ledger());
  assert.equal(s.ok, true);
  assert.equal(s.equity, 10100); // 8000 cash + 0.1 * 21000
  assert.equal(s.openExposure, 2100);
  assert.equal(s.unrealizedPnl, 100);
  assert.equal(s.availableCash, 7500);
  assert.equal(s.minimumReserve, 5050);
  assert.equal(s.availableTradingCapital, 2350); // 7500 - 5050 - 100
  assert.equal(s.maxDeployment, 2350);
  assert.equal(s.realizedPnl, 40);
  assert.equal(s.fees, 12);
});

test("max deployment is also capped by the 50% notional limit", () => {
  const s = buildCapitalSnapshot(ledger({ cash: 100000, reservedFunds: 0, pendingTransfers: 0, positions: [] }));
  assert.equal(s.availableTradingCapital, 50000);
  assert.equal(s.maxDeployment, 50000);
  const t = buildCapitalSnapshot(ledger({ cash: 100000, reservedFunds: 0, pendingTransfers: 0, positions: [] }), { ...{ riskPerTrade: 0.005, maxPositionNotional: 0.2, maxConcurrentPositions: 3, maxDailyLoss: 0.02, maxConsecutiveLosses: 3, minRewardToRisk: 1.5, maxLeverage: 1, minCashReserve: 0.5, maxDrawdown: 0.1 } });
  assert.equal(t.maxDeployment, 20000);
});

test("short positions add negative value but positive exposure", () => {
  const s = buildCapitalSnapshot(ledger({ cash: 12000, reservedFunds: 0, pendingTransfers: 0, positions: [{ symbol: "ETHUSDT", qty: -1, avgPrice: 2000, markPrice: 1900 }] }));
  assert.equal(s.equity, 10100);
  assert.equal(s.openExposure, 1900);
  assert.equal(s.unrealizedPnl, 100);
});

test("fails closed on an unpriced position", () => {
  const s = buildCapitalSnapshot(ledger({ positions: [{ symbol: "BTCUSDT", qty: 0.1, avgPrice: 20000, markPrice: null }] }));
  assert.equal(s.ok, false);
  assert.deepEqual(s.reasons, ["unpriced_position:BTCUSDT"]);
  assert.equal(s.availableTradingCapital, 0);
  assert.equal(s.maxDeployment, 0);
});

test("fails closed on non-finite, negative, over-reserved or invalid scope input", () => {
  assert.equal(buildCapitalSnapshot(ledger({ cash: NaN })).ok, false);
  assert.equal(buildCapitalSnapshot(ledger({ cash: -1 })).ok, false);
  const over = buildCapitalSnapshot(ledger({ reservedFunds: 9000 }));
  assert.equal(over.ok, false);
  assert.ok(over.reasons.includes("reserved_exceeds_cash"));
  assert.equal(buildCapitalSnapshot(ledger({ accountId: "bad id!" })).ok, false);
  assert.equal(buildCapitalSnapshot(ledger({ environment: "prod" as any })).ok, false);
  assert.equal(buildCapitalSnapshot(ledger({ cash: 0, reservedFunds: 0, positions: [] })).ok, false, "zero equity");
});

test("reconcile: matching wallet and ledger give no discrepancies", () => {
  const l = ledger();
  assert.deepEqual(reconcileLedger(l, { cash: 8000, positions: { BTCUSDT: 0.1 } }), []);
  assert.deepEqual(reconcileLedger(l, { cash: 8000.005, positions: { BTCUSDT: 0.1, DUST: 0 } }), [], "within tolerance; zero quantities ignored");
});

test("reconcile detects cash, quantity and missing-position discrepancies", () => {
  const l = ledger();
  assert.deepEqual(reconcileLedger(l, { cash: 8005, positions: { BTCUSDT: 0.1 } }).map((d) => d.code), ["cash_mismatch"]);
  assert.deepEqual(reconcileLedger(l, { cash: 8000, positions: { BTCUSDT: 0.09 } }).map((d) => d.code), ["quantity_mismatch"]);
  assert.deepEqual(reconcileLedger(l, { cash: 8000, positions: {} }).map((d) => d.code), ["position_missing_in_wallet"]);
  const extra = reconcileLedger(l, { cash: 8000, positions: { BTCUSDT: 0.1, SOLUSDT: 3 } });
  assert.deepEqual(extra, [{ code: "position_missing_in_ledger", symbol: "SOLUSDT", ledger: 0, wallet: 3 }]);
  assert.deepEqual(reconcileLedger(l, { cash: NaN, positions: {} }), [{ code: "invalid_wallet_view" }]);
  assert.deepEqual(reconcileLedger(l, null as any), [{ code: "invalid_wallet_view" }]);
});

test("environments and accounts are never mixed", () => {
  assertSameScope([{ environment: "paper", accountId: "a" }, { environment: "paper", accountId: "a" }]);
  assert.throws(() => assertSameScope([{ environment: "paper", accountId: "a" }, { environment: "live", accountId: "a" }]), /environment mix/);
  assert.throws(() => assertSameScope([{ environment: "paper", accountId: "a" }, { environment: "paper", accountId: "b" }]), /account mix/);
});

test("unresolved discrepancies or an untrusted snapshot block new entries end to end", () => {
  const good = buildCapitalSnapshot(ledger({ cash: 20000, reservedFunds: 0, pendingTransfers: 0, positions: [] }));
  const trade = { side: "long" as const, entry: 100, stop: 98, takeProfit: 104, feeRate: 0.001, slippageRate: 0.0005, qtyStep: 0.001, minQty: 0.001, minNotional: 10 };
  const okState = toAccountState(good, ctx({ dayBaselineEquity: 20000, peakEquity: 20000 }), 0);
  assert.equal(okState.walletReconciled, true);
  assert.equal(sizeTrade(okState, trade).approved, true);

  const withDiff = toAccountState(good, ctx({ dayBaselineEquity: 20000, peakEquity: 20000, discrepancies: [{ code: "cash_mismatch", ledger: 1, wallet: 2 }] }), 0);
  assert.equal(withDiff.walletReconciled, false);
  assert.equal(sizeTrade(withDiff, trade).approved, false);

  const bad = buildCapitalSnapshot(ledger({ positions: [{ symbol: "X", qty: 1, avgPrice: 1, markPrice: null }] }));
  const untrusted = toAccountState(bad, ctx(), 1);
  assert.equal(untrusted.walletReconciled, false);
  assert.equal(sizeTrade(untrusted, trade).approved, false);
});

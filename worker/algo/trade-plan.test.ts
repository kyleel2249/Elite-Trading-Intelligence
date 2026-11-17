import test from "node:test";
import assert from "node:assert/strict";
import { calculateTradePlan } from "./trade-plan.ts";

test("long trade plan sizes quantity from equity risk and reports target ladder", () => {
  const p = calculateTradePlan({ direction: 1, entry: 100, stopLoss: 98, takeProfits: [
    { label: "TP1", price: 102, closeFraction: 0.4 }, { label: "TP2", price: 104, closeFraction: 0.3 }, { label: "TP3", price: 107, closeFraction: 0.3 },
  ], equity: 10_000, riskFraction: 0.01, feeBps: 5, slippageBps: 2 });
  assert.equal(p.valid, true);
  assert.equal(p.quantity, 50);
  assert.equal(p.riskBudget, 100);
  assert.equal(p.plannedStopRisk, 100);
  assert.equal(p.estimatedMargin, 5_000);
  assert.equal(p.canSubmitOrder, false);
  assert.ok(p.netRewardRiskToFinalTarget! > 0);
});

test("short plans mirror long plans and leverage/notional caps are applied", () => {
  const p = calculateTradePlan({ direction: -1, entry: 100, stopLoss: 102, takeProfits: [{ price: 96, closeFraction: 1 }], equity: 10_000, riskFraction: 0.01, maxNotionalFraction: 0.2, leverage: 2 });
  assert.equal(p.valid, true);
  assert.equal(p.quantity, 40);
  assert.equal(p.notional, 4_000);
  assert.equal(p.estimatedMargin, 2_000);
  assert.equal(p.targets[0].rewardRisk, 2);
});

test("invalid geometry, risk limits and target fractions fail closed", () => {
  for (const patch of [
    { stopLoss: 101 }, { riskFraction: 0.1 }, { takeProfits: [] },
    { takeProfits: [{ price: 105, closeFraction: 0.8 }, { price: 104, closeFraction: 0.4 }] },
  ]) {
    const p = calculateTradePlan({ direction: 1, entry: 100, stopLoss: 98, takeProfits: [{ price: 104, closeFraction: 1 }], equity: 10_000, riskFraction: 0.01, ...patch } as any);
    assert.equal(p.valid, false);
    assert.equal(p.quantity, 0);
    assert.equal(p.canSubmitOrder, false);
  }
});

test("fees and slippage are explicit; missing cost inputs are never presented as net estimates", () => {
  const base = { direction: 1 as const, entry: 100, stopLoss: 98, takeProfits: [{ price: 104, closeFraction: 1 }], equity: 10_000, riskFraction: 0.01 };
  const missing = calculateTradePlan(base);
  const priced = calculateTradePlan({ ...base, feeBps: 5, slippageBps: 3 });
  assert.equal(missing.netRewardRiskToFinalTarget, null);
  assert.equal(missing.estimatedRoundTripCosts, null);
  assert.ok(priced.estimatedRoundTripCosts! > 0);
  assert.equal(priced.canSubmitOrder, false);
});

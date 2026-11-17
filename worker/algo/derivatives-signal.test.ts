import test from "node:test";
import assert from "node:assert/strict";
import { series } from "./fixtures.ts";
import { TIMEFRAMES, TF_SECONDS } from "./timeframes.ts";
import { buildSignal } from "./signal.ts";
import type { DepthSnapshot } from "./liquidity.ts";

const NOW = 1_800_000_000_000;
function allTf() {
  const candles: any = {};
  for (const tf of TIMEFRAMES) candles[tf] = series(260, { drift: 0.5, noise: 0.3, start: 100, seed: 1, stepMs: TF_SECONDS[tf] * 1000, end: NOW });
  return candles;
}
function depth(price: number): DepthSnapshot {
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 20; i++) { bids.push([price - 0.01 - i * 0.05, 20]); asks.push([price + 0.01 + i * 0.05, 10]); }
  return { bids, asks, timestamp: NOW };
}
function input() {
  const candles = allTf(), price = candles["15m"].at(-1)![4];
  return { symbol: "BTCUSDT", strategy: "intraday" as const, candles, depth: depth(price), now: NOW, expectancyR: 0.3, expectancySamples: 60, equity: 10_000, riskFraction: 0.01, feeBps: 5, slippageBps: 3 };
}

test("derivatives crowding feeds the existing signal score and only downgrades confidence", () => {
  const base = buildSignal(input());
  const crowded = buildSignal({ ...input(), derivatives: { fundingRate: 0.0012, openInterest: 12_500, timestamp: NOW, source: "bitget" } });
  assert.equal(crowded.derivatives?.crowding, "longs_crowded");
  assert.equal(crowded.validation?.derivativesAdjustment, -8);
  assert.ok(crowded.confidence <= base.confidence);
  assert.equal(crowded.tradePlan?.canSubmitOrder, false);
  assert.equal(crowded.liveExecutionAllowed, base.liveExecutionAllowed, "derivatives context must not enable live execution");
});

test("trade plan is attached to actionable signals but never submits an order", () => {
  const signal = buildSignal(input());
  if (signal.action === "BUY" || signal.action === "SELL") {
    assert.ok(signal.tradePlan);
    assert.equal(signal.tradePlan?.canSubmitOrder, false);
    assert.ok(signal.tradePlan?.quantity > 0);
    assert.ok(signal.tradePlan?.plannedStopRisk <= signal.tradePlan?.riskBudget + 1e-8);
  }
});

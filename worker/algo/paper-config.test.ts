import test from "node:test";
import assert from "node:assert/strict";
import { paperConfigFrom } from "./paper-api.ts";
import { DEFAULT_PAPER_CONFIG } from "./paper.ts";

test("balanced paper policy uses bounded capital-protection defaults", () => {
  const config = paperConfigFrom({} as any);
  assert.equal(config.riskFraction, DEFAULT_PAPER_CONFIG.riskFraction);
  assert.equal(config.maxNotionalFraction, 0.5);
  assert.equal(config.maxOpenPositions, 3);
  assert.equal(config.maxDailyLossPct, 2);
  assert.equal(config.maxConsecutiveLosses, 3);
});

test("balanced paper policy accepts valid bounded overrides", () => {
  const config = paperConfigFrom({
    ETI_PAPER_RISK_FRACTION: "0.004",
    ETI_PAPER_MAX_NOTIONAL_FRACTION: "0.4",
    ETI_PAPER_MAX_OPEN_POSITIONS: "2",
    ETI_PAPER_MAX_DAILY_LOSS_PCT: "1.5",
    ETI_PAPER_MAX_CONSECUTIVE_LOSSES: "2",
    ETI_MAX_ORDER_QUANTITY: "0.25",
  } as any);
  assert.equal(config.riskFraction, 0.004);
  assert.equal(config.maxNotionalFraction, 0.4);
  assert.equal(config.maxOpenPositions, 2);
  assert.equal(config.maxDailyLossPct, 1.5);
  assert.equal(config.maxConsecutiveLosses, 2);
  assert.equal(config.maxOrderQuantity, 0.25);
});

test("invalid or out-of-range paper risk overrides are constrained by safe hard ceilings", () => {
  const config = paperConfigFrom({
    ETI_PAPER_RISK_FRACTION: "0.9",
    ETI_PAPER_MAX_NOTIONAL_FRACTION: "NaN",
    ETI_PAPER_MAX_OPEN_POSITIONS: "2.5",
    ETI_PAPER_MAX_DAILY_LOSS_PCT: "0",
    ETI_PAPER_MAX_CONSECUTIVE_LOSSES: "99",
  } as any);
  assert.equal(config.riskFraction, 0.01);
  assert.equal(config.maxNotionalFraction, 0.5);
  assert.equal(config.maxOpenPositions, 3);
  assert.equal(config.maxDailyLossPct, 2);
  assert.equal(config.maxConsecutiveLosses, 3);
});

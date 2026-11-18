import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDerivativesContext } from "./derivatives.ts";

const NOW = 1_800_000_000_000;

test("funding crowding penalises only the crowded direction and never creates a signal", () => {
  const long = analyzeDerivativesContext({ fundingRate: 0.0012, openInterest: 1200, timestamp: NOW }, 1, NOW);
  const short = analyzeDerivativesContext({ fundingRate: 0.0012, openInterest: 1200, timestamp: NOW }, -1, NOW);
  assert.equal(long.crowding, "longs_crowded");
  assert.equal(long.scoreAdjustment, -8);
  assert.equal(short.scoreAdjustment, 0);
  assert.equal(long.status, "available");
});

test("negative funding identifies crowded shorts", () => {
  const x = analyzeDerivativesContext({ fundingRate: -0.0006, openInterest: 800, timestamp: NOW }, -1, NOW);
  assert.equal(x.fundingBias, "shorts_pay");
  assert.equal(x.crowding, "shorts_crowded");
  assert.equal(x.scoreAdjustment, -5);
});

test("open-interest contraction is reported and mildly penalised", () => {
  const x = analyzeDerivativesContext({ fundingRate: 0, openInterest: 90, previousOpenInterest: 100, timestamp: NOW }, 1, NOW);
  assert.equal(x.openInterestChangePct, -10);
  assert.equal(x.scoreAdjustment, -2);
  assert.ok(x.notes.some(n => /contracting sharply/.test(n)));
});

test("stale or future snapshots are ignored, missing data remains advisory", () => {
  const stale = analyzeDerivativesContext({ fundingRate: 0.01, openInterest: 1, timestamp: NOW - 300_000 }, 1, NOW);
  assert.equal(stale.status, "stale");
  assert.equal(stale.scoreAdjustment, 0);
  const missing = analyzeDerivativesContext(null, 1, NOW);
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.scoreAdjustment, 0);
});

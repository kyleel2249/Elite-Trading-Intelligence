import test from "node:test";
import assert from "node:assert/strict";
import { BAND_TEXT, DEFAULT_CONFIG, bandFor, resolveConfig, scoreConfigHash, validateConfig } from "./config.ts";
import { COMPONENT_IDS } from "./types.ts";

test("default configuration is valid and weights cover every score component", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.weights).sort(), [...COMPONENT_IDS].sort());
  assert.equal(Object.values(DEFAULT_CONFIG.weights).reduce((a, b) => a + b, 0), 100);
});

test("score bands follow the published table exactly at every boundary", () => {
  const cases: [number, string][] = [[100, "exceptional"], [90, "exceptional"], [89.9, "strong"], [80, "strong"], [79.9, "potential"], [70, "potential"], [69.9, "weak"], [50, "weak"], [49.9, "avoid"], [0, "avoid"]];
  for (const [score, band] of cases) assert.equal(bandFor(score), band, String(score));
  assert.equal(BAND_TEXT.exceptional, "Exceptional candidate, subject to all risk checks");
  assert.equal(BAND_TEXT.avoid, "Avoid");
});

test("a valid override is applied; no override leaves the defaults", () => {
  assert.equal(resolveConfig(undefined).status, "default");
  assert.equal(resolveConfig("").status, "default");
  const r = resolveConfig({ weights: { liquidity: 20 }, gates: { maxSpreadBps: 10 } });
  assert.equal(r.status, "override_applied");
  assert.equal(r.config.weights.liquidity, 20);
  assert.equal(r.config.weights.trendAlignment, DEFAULT_CONFIG.weights.trendAlignment, "untouched keys keep defaults");
  assert.equal(r.config.gates.maxSpreadBps, 10);
  assert.equal(resolveConfig(JSON.stringify({ expiryBars: 4 })).config.expiryBars, 4, "JSON strings are accepted (Worker vars are strings)");
});

test("any invalid override is rejected whole and the defaults stay in force", () => {
  const bad: unknown[] = [
    "not json", "[1,2]", 5,
    { weights: { nonsense: 1 } },            // unknown key
    { weights: { liquidity: "20" } },        // wrong type
    { weights: { liquidity: -1 } },          // negative weight
    { gates: { maxSpreadBps: 0 } },          // would disable the spread check
    { gates: { maxCostShareOfTP1Reward: 1 } },
    { gates: { requireOrderBook: "no" } },
    { bands: { exceptional: 70, strong: 80 } },   // not descending
    { incompleteDataCap: 150 },
    { calibration: { maxEce: 0.5 } },        // would admit uncalibrated models
    { calibration: { minTestSamples: 5000 } },
    { gates: { minNetRewardRiskTP1: 3, minNetRewardRisk: 2 } },
  ];
  for (const o of bad) {
    const r = resolveConfig(o);
    assert.equal(r.status, "override_rejected", JSON.stringify(o));
    assert.ok(r.errors.length > 0);
    assert.equal(r.config, DEFAULT_CONFIG);
  }
  assert.equal(resolveConfig({ weights: Object.fromEntries(COMPONENT_IDS.map(id => [id, 0])) }).status, "override_rejected", "all-zero weights are rejected");
});

test("the score fingerprint changes with anything that changes what a score means, and with nothing else", () => {
  const base = scoreConfigHash(DEFAULT_CONFIG);
  assert.equal(base, scoreConfigHash(resolveConfig({}).config));
  assert.notEqual(base, scoreConfigHash(resolveConfig({ weights: { liquidity: 13 } }).config));
  assert.notEqual(base, scoreConfigHash(resolveConfig({ bands: { exceptional: 92 } }).config));
  assert.notEqual(base, scoreConfigHash(resolveConfig({ incompleteDataCap: 70 }).config));
  assert.notEqual(base, scoreConfigHash(resolveConfig({ costs: { takerFeeBps: 20 } }).config));
  assert.equal(base, scoreConfigHash(resolveConfig({ gates: { maxSpreadBps: 12 } }).config), "gates are pass/fail rules, not part of the score");
});

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, resolveConfig } from "./config.ts";
import { aggregate, DISCLAIMER } from "./scoring.ts";
import { COMPONENT_IDS, type ComponentId } from "./types.ts";

type Raw = Parameters<typeof aggregate>[0];
const raw = (scores: Partial<Record<ComponentId, number | null>>, def: number | null = 80, cfg = DEFAULT_CONFIG): Raw =>
  COMPONENT_IDS.map(id => { const s = id in scores ? scores[id]! : def; return { id, label: id, configuredWeight: cfg.weights[id], score: s, status: s === null ? "unavailable" as const : "ok" as const, detail: "" }; });

test("with full evidence the score is the weight-averaged component score", () => {
  const r = aggregate(raw({}, 80), DEFAULT_CONFIG);
  assert.equal(r.value, 80);
  assert.equal(r.capped, false);
  assert.equal(r.cap, null);
  assert.equal(r.coverage, 1);
  assert.deepEqual(r.unavailableComponents, []);
  const mixed = aggregate(raw({ trendAlignment: 100, liquidity: 40 }, 60), DEFAULT_CONFIG);
  const w = DEFAULT_CONFIG.weights;
  const expected = (100 * w.trendAlignment + 40 * w.liquidity + 60 * (100 - w.trendAlignment - w.liquidity)) / 100;
  assert.ok(Math.abs(mixed.value! - expected) < 0.06, `${mixed.value} vs ${expected}`);
});

test("effective weights always sum to 100 and unavailable components carry none", () => {
  for (const missing of [[], ["newsRisk"], ["newsRisk", "fundamentalAlignment", "strategyExpectancy"]] as ComponentId[][]) {
    const r = aggregate(raw(Object.fromEntries(missing.map(m => [m, null]))), DEFAULT_CONFIG);
    const sum = r.components.reduce((s, c) => s + c.effectiveWeight, 0);
    assert.ok(Math.abs(sum - 100) < 0.1, `${missing.join(",")}: ${sum}`);
    for (const c of r.components) if (c.status === "unavailable") assert.equal(c.effectiveWeight, 0);
  }
});

test("missing evidence caps the score so incomplete data can never look exceptional", () => {
  const perfect = aggregate(raw({ newsRisk: null, fundamentalAlignment: null, strategyExpectancy: null }, 100), DEFAULT_CONFIG);
  assert.equal(perfect.uncapped, 100);
  assert.equal(perfect.value, DEFAULT_CONFIG.incompleteDataCap);
  assert.equal(perfect.capped, true);
  assert.notEqual(perfect.band, "exceptional");
  assert.match(perfect.interpretation, /incomplete evidence/);
  assert.ok(perfect.coverage < 1 && perfect.coverage > 0.5);
  assert.match(perfect.disclaimer, /newsRisk/);
  // A score already under the cap is untouched.
  assert.equal(aggregate(raw({ newsRisk: null }, 60), DEFAULT_CONFIG).value, 60);
  assert.equal(aggregate(raw({ newsRisk: null }, 60), DEFAULT_CONFIG).capped, false);
});

test("an operator can raise the weight of a component and the score responds, within validation", () => {
  const scores = { liquidity: 100, trendAlignment: 40 };
  const base = aggregate(raw(scores, 70), DEFAULT_CONFIG).value!;
  const cfg = resolveConfig({ weights: { liquidity: 40 } }).config;
  const heavier = aggregate(raw(scores, 70, cfg), cfg).value!;
  assert.ok(heavier > base, `${heavier} > ${base}`);
  assert.equal(resolveConfig({ weights: { liquidity: 40 } }).status, "override_applied");
});

test("a zero-weight component is ignored even when it has a score", () => {
  const cfg = resolveConfig({ weights: { newsRisk: 0 } }).config;
  const r = aggregate(raw({ newsRisk: 0 }, 80, cfg), cfg);
  assert.equal(r.value, 80);
  assert.equal(r.components.find(c => c.id === "newsRisk")!.effectiveWeight, 0);
});

test("nothing scoreable yields a null score and the lowest band rather than a made-up number", () => {
  const r = aggregate(raw({}, null), DEFAULT_CONFIG);
  assert.equal(r.value, null);
  assert.equal(r.band, "avoid");
  assert.equal(r.coverage, 0);
  assert.equal(r.unavailableComponents.length, COMPONENT_IDS.length);
  assert.equal(aggregate([], DEFAULT_CONFIG).value, null);
});

test("the score always states that it is not a probability", () => {
  assert.match(DISCLAIMER, /not a probability/);
  assert.match(DISCLAIMER, /never overrides a failed risk check/);
  assert.equal(aggregate(raw({}, 90), DEFAULT_CONFIG).band, "exceptional");
  assert.equal(aggregate(raw({}, 55), DEFAULT_CONFIG).band, "weak");
  assert.equal(aggregate(raw({}, 20), DEFAULT_CONFIG).band, "avoid");
});

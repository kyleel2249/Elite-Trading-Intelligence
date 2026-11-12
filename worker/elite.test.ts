import test from "node:test";
import assert from "node:assert/strict";
import { assessElite, documentedBy, ELITE_LIMITATIONS } from "./algo/elite.ts";
import { runOmnisignal } from "./algo/omnisignal.ts";
import { series } from "./algo/fixtures.ts";
import { TF_SECONDS, TIMEFRAMES } from "./algo/timeframes.ts";

const NOW = 1_800_000_000_000;
const rows = (drift: number) => series(320, { drift, noise: 0.35, start: 100, seed: 7, stepMs: 3600_000, end: NOW - 1000, vol: 100 });
const plan = { entryZone: [100, 100.4] as [number, number], stopLoss: 98, takeProfits: [{ price: 103, rewardRisk: 1.5 }, { price: 105, rewardRisk: 2.5 }, { price: 108, rewardRisk: 4 }] };

test("elite: unavailable without enough candles, never fabricates", () => {
  const a = assessElite(rows(0.2).slice(0, 50), 1, plan, null);
  assert.equal(a.available, false); assert.equal(a.alignment, "unavailable"); assert.equal(a.principles.length, 0);
  assert.equal(assessElite(undefined, 1, plan, null).available, false);
});
test("elite: strong uptrend supports long and opposes short; disclosures are honestly unavailable", () => {
  const up = assessElite(rows(0.25), 1, plan, null), dn = assessElite(rows(0.25), -1, plan, null);
  assert.equal(up.available, true);
  assert.ok(up.supporting >= dn.supporting); assert.ok(dn.opposing >= up.opposing);
  assert.notEqual(up.alignment, "opposes");
  assert.equal(up.disclosures.status, "not_available");
  assert.equal(up.limitations, ELITE_LIMITATIONS);
  assert.ok(up.knowledge.profiles > 0 && up.knowledge.strategies > 0);
  assert.ok(up.principles.some(p => p.id === "trend_following"));
  assert.equal(up.influencesDecision, false);
});
test("elite: missing stop is flagged as opposing capital preservation", () => {
  const a = assessElite(rows(0.25), 1, { ...plan, stopLoss: null }, null);
  assert.equal(a.principles.find(p => p.id === "capital_preservation")!.status, "opposes");
});
test("elite: documentedBy returns only names present in the database", () => {
  const names = documentedBy(["turtle_trend", "no_such_module"]);
  assert.ok(names.length > 0);
  assert.deepEqual(documentedBy(["no_such_module"]), []);
});
test("elite: runOmnisignal exposes the block and the gate is opt-in", () => {
  const candles = Object.fromEntries(TIMEFRAMES.map(tf => [tf, series(300, { drift: 0.25, noise: 0.35, start: 100, seed: 7, stepMs: TF_SECONDS[tf] * 1000, end: NOW - 1000, vol: 100 })])) as any;
  const base = { symbol: "TESTUSDT", strategy: "intraday" as const, candles, now: NOW };
  const off = runOmnisignal(base, { roundTripCostBps: 0 }), on = runOmnisignal(base, { roundTripCostBps: 0, eliteGate: true });
  if (off.elite) { assert.equal(off.elite.influencesDecision, false); assert.equal(on.elite!.influencesDecision, true); }
  if (on.elite?.alignment !== "opposes") assert.equal(on.signal, off.signal);
  else assert.equal(on.signal, "HOLD");
});

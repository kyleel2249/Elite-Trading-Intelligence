import test from "node:test";
import assert from "node:assert/strict";
import { applyCalibration, fitCalibration, loadCalibration, pav, saveCalibration, type Outcome } from "./algo/calibration.ts";

let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const mk = (n: number, pWin: (c: number) => number): Outcome[] => Array.from({ length: n }, (_, i) => { const c = 50 + Math.floor(rnd() * 45); const win = rnd() < pWin(c); return { confidence: c, win, r: win ? 1 : -1, closedAt: i, source: "paper" }; });

test("pav gives a monotone fit", () => { const f = pav([0.6, 0.4, 0.5, 0.9], [10, 10, 10, 10]); for (let i = 1; i < f.length; i++) assert.ok(f[i] >= f[i - 1]); assert.equal(f.length, 4); });
test("too few outcomes stays uncalibrated", () => {
  const t = fitCalibration(mk(40, () => 0.5), 1); assert.equal(t.status, "insufficient_data");
  assert.equal(applyCalibration(t, 70).status, "uncalibrated"); assert.equal(applyCalibration(null, 70).status, "uncalibrated");
});
test("informative score is calibrated and reports observed frequency with interval", () => {
  const t = fitCalibration(mk(1500, c => 0.2 + (c - 50) * 0.012), 2); assert.equal(t.status, "calibrated"); assert.ok(t.brier!.model < t.brier!.baseline);
  const lo = applyCalibration(t, 55), hi = applyCalibration(t, 90); assert.equal(hi.status, "calibrated");
  assert.ok(hi.observedWinRate! > lo.observedWinRate!); assert.ok(hi.interval95!.low <= hi.observedWinRate! && hi.observedWinRate! <= hi.interval95!.high);
  assert.match(hi.note, /not a guarantee/);
});
test("uninformative score is rejected as no_skill, so it is never shown as a probability", () => {
  const t = fitCalibration(mk(1500, () => 0.45), 3); assert.equal(t.status, "no_skill");
  const a = applyCalibration(t, 80); assert.equal(a.status, "no_skill"); assert.equal(a.observedWinRate, undefined);
});
test("sparse bins are not calibrated", () => {
  const o = [...mk(300, c => 0.2 + (c - 50) * 0.012), ...Array.from({ length: 3 }, (_, i) => ({ confidence: 10, win: true, r: 1, closedAt: 1000 + i, source: "paper" }))];
  const t = fitCalibration(o, 4); if (t.status === "calibrated") assert.equal(applyCalibration(t, 10).status, "uncalibrated");
});
test("storage round trip and corrupt data fails safe", async () => {
  const m = new Map<string, string>(), kv = { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } };
  assert.equal(await loadCalibration(kv), null); const t = fitCalibration(mk(300, () => 0.5), 5); await saveCalibration(kv, t);
  assert.equal((await loadCalibration(kv))!.samples, 300); m.set("algo:calibration:v1", "{not json"); assert.equal(await loadCalibration(kv), null);
});

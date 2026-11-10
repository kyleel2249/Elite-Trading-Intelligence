import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFlow } from "./algo/flow.ts";
import type { Kline } from "./market.ts";

const calm = (n: number): Kline[] => Array.from({ length: n }, (_, i) => { const p = 100 + Math.sin(i / 3) * 0.3; return [i * 60000, p, p + 0.5, p - 0.5, p + (i % 2 ? 0.1 : -0.1), 100 + (i % 5)]; });
test("flow: too few candles is unavailable", () => { const f = analyzeFlow(calm(20), 1); assert.equal(f.available, false); assert.equal(f.supports, "unavailable"); });
test("flow: zero volume is unavailable, not divided by zero", () => assert.equal(analyzeFlow(calm(80).map(r => [r[0], r[1], r[2], r[3], r[4], 0] as Kline), 1).available, false));
test("flow: calm tape has no abnormal activity", () => { const f = analyzeFlow(calm(80), 1); assert.equal(f.available, true); assert.equal(f.abnormal, false); assert.equal(f.flags.length, 0); assert.match(f.caveat, /cannot tell who traded/); });
test("flow: volume spike is flagged abnormal", () => {
  const r = calm(80); r[79] = [79 * 60000, 100, 101.5, 98.5, 101.2, 2000]; const f = analyzeFlow(r, 1);
  assert.ok(f.flags.some(x => x.kind === "volume_spike" && x.barsAgo === 0)); assert.equal(f.abnormal, true);
});
test("flow: heavy volume in a narrow range closing high after a drop is bullish absorption", () => {
  const r = calm(80); for (let i = 60; i < 79; i++) { const p = 100 - (i - 60) * 0.1; r[i] = [i * 60000, p, p + 0.5, p - 0.5, p - 0.05, 100]; } r[79] = [79 * 60000, 98.2, 98.45, 98.2, 98.4, 1200];
  const f = analyzeFlow(r, 1); assert.ok(f.flags.some(x => x.kind === "absorption_bullish"), JSON.stringify(f.flags)); assert.equal(f.supports === "opposes", false);
});
test("flow: heavy volume in a narrow range closing low after a rise is bearish absorption and opposes a long", () => {
  const r = calm(80); for (let i = 60; i < 79; i++) { const p = 100 + (i - 60) * 0.1; r[i] = [i * 60000, p, p + 0.5, p - 0.5, p + 0.05, 100]; } r[79] = [79 * 60000, 101.9, 101.95, 101.65, 101.66, 1200];
  const f = analyzeFlow(r, 1); assert.ok(f.flags.some(x => x.kind === "absorption_bearish"), JSON.stringify(f.flags)); assert.equal(f.supports, "opposes");
});
test("flow: wide range on thin volume is flagged as weak participation", () => {
  const r = calm(80).map((b, i) => [b[0], b[1], b[2] + (i % 3) * 0.1, b[3], b[4], b[5]] as Kline); r[79] = [79 * 60000, 100, 102, 98, 101.8, 20]; assert.ok(analyzeFlow(r, 1).flags.some(x => x.kind === "thin_move"));
});
test("flow: never names an institution", () => assert.ok(!/institution(al)? (buying|selling|accumulat)/i.test(JSON.stringify(analyzeFlow(calm(80), 1)))));

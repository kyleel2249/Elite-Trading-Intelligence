import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { bollingerSeries, cciSeries, computeSuite, cvdProxy, ichimoku, macdSeries, mfiSeries, obvSeries, rsiSeries, sma, supertrend, swingFib, vwapSession } from "./indicator-suite.ts";

const T0 = Date.UTC(2026, 0, 1);
function series(n: number, f: (i: number) => number, vol = (i: number) => 100 + (i % 7), step = 3_600_000): Kline[] {
  return Array.from({ length: n }, (_, i) => { const c = f(i), o = i ? f(i - 1) : c; return [T0 + i * step, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c, vol(i), 0] as Kline; });
}
const up = series(200, (i) => 100 + i * 0.5), down = series(200, (i) => 200 - i * 0.5);
const wave = series(300, (i) => 100 + 10 * Math.sin(i / 6) + (i % 5) * 0.3);

test("sma, rsi, bollinger and cci match hand-computed values", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).slice(2), [2, 3, 4]);
  assert.equal(rsiSeries(up.map((r) => r[4])).at(-1), 100);
  assert.equal(rsiSeries(down.map((r) => r[4])).at(-1), 0);
  assert.equal(rsiSeries(new Array(40).fill(5)).at(-1), 50);
  const flat = bollingerSeries(new Array(30).fill(10));
  assert.equal(flat.upper.at(-1), 10); assert.equal(flat.pctB.at(-1), 0.5);
  assert.equal(cciSeries(series(40, () => 50)).at(-1), 0);
  // closes 1..20, period 20: mean 10.5, population sd = sqrt((20^2-1)/12) = 5.7663
  const b = bollingerSeries(Array.from({ length: 20 }, (_, i) => i + 1), 20, 2);
  assert.ok(Math.abs(b.upper[19] - (10.5 + 2 * Math.sqrt(399 / 12))) < 1e-9);
});

test("macd histogram is positive in an uptrend and negative in a downtrend; warm-up bars are NaN", () => {
  const u = macdSeries(up.map((r) => r[4])), d = macdSeries(down.map((r) => r[4]));
  assert.ok(Number.isNaN(u.macd[10])); assert.ok(Number.isNaN(u.hist[30]));
  assert.ok(u.macd.at(-1)! > 0 && d.macd.at(-1)! < 0);
});

test("ichimoku: cloud is displaced from past data only, and the projection is known now", () => {
  const ich = ichimoku(up);
  assert.ok(Number.isNaN(ich.cloudA[25]) && Number.isFinite(ich.cloudA[199]));
  const i = 150, rawA = (ich.tenkan[i - 26] + ich.kijun[i - 26]) / 2;
  assert.equal(ich.cloudA[i], rawA);
  assert.equal(ich.futureA.length, 26);
  assert.ok(ich.futureA.some((x) => Number.isFinite(x)));
  assert.ok(up.at(-1)![4] > Math.max(ich.cloudA.at(-1)!, ich.cloudB.at(-1)!), "uptrend closes above the cloud");
  assert.ok(down.at(-1)![4] < Math.min(ich.cloudA.at(-1)!, ich.cloudB.at(-1)!), "downtrend closes below the cloud");
  assert.equal(ich.chikou.at(-1), 1);
});

test("supertrend follows the trend and flips on reversal", () => {
  assert.equal(supertrend(up).dir.at(-1), 1);
  assert.equal(supertrend(down).dir.at(-1), -1);
  const rev = series(160, (i) => (i < 80 ? 100 + i : 180 - (i - 80) * 2));
  const st = supertrend(rev);
  assert.equal(st.dir[70], 1); assert.equal(st.dir.at(-1), -1);
  assert.ok(st.line.at(-1)! > rev.at(-1)![4], "bearish line sits above price");
});

test("vwap resets each UTC day; zero-volume sessions have no vwap", () => {
  const rows = series(48, (i) => 100 + i, () => 10);
  const v = vwapSession(rows);
  assert.equal(v.vwap[0], (rows[0][2] + rows[0][3] + rows[0][4]) / 3);
  const d2 = v.vwap[24]; assert.equal(d2, (rows[24][2] + rows[24][3] + rows[24][4]) / 3);
  assert.ok(Number.isNaN(vwapSession(series(5, () => 100, () => 0)).vwap[2]));
});

test("obv, mfi and cvd proxy behave on directional data", () => {
  const obv = obvSeries(up); assert.ok(obv.at(-1)! > obv[5]);
  assert.ok(obvSeries(down).at(-1)! < 0);
  const m = mfiSeries(up).filter(Number.isFinite); assert.ok(m.every((x) => x >= 0 && x <= 100)); assert.equal(m.at(-1), 100);
  const w = mfiSeries(wave).filter(Number.isFinite); assert.ok(w.every((x) => x >= 0 && x <= 100));
  const bull: Kline = [0, 1, 2, 1, 2, 10, 0], bear: Kline = [0, 2, 2, 1, 1, 10, 0], doji: Kline = [0, 1, 1, 1, 1, 10, 0];
  assert.deepEqual(cvdProxy([bull, bear, doji]).delta, [10, -10, 0]);
});

test("swing fibonacci levels sit between the swing low and high", () => {
  const f = swingFib(wave)!;
  assert.ok(f.levels.every((l) => l.price > f.low && l.price < f.high));
  assert.ok(f.extensions.every((l) => l.price > f.high || l.price < f.low));
});

test("NON-REPAINTING: truncating the data never changes any earlier indicator value", () => {
  const full = computeSuite(wave), cut = computeSuite(wave.slice(0, 220));
  const same = (a: number[], b: number[]) => { for (let i = 0; i < 220; i++) { const x = a[i], y = b[i]; assert.ok((Number.isNaN(x) && Number.isNaN(y)) || x === y || Math.abs(x - y) < 1e-9, `index ${i}: ${x} vs ${y}`); } };
  same(full.ema20, cut.ema20); same(full.ema200, cut.ema200); same(full.rsi, cut.rsi); same(full.macd.hist, cut.macd.hist); same(full.bb.upper, cut.bb.upper);
  same(full.ich.tenkan, cut.ich.tenkan); same(full.ich.cloudA, cut.ich.cloudA); same(full.ich.cloudB, cut.ich.cloudB); same(full.ich.chikou, cut.ich.chikou);
  same(full.st.line, cut.st.line); same(full.st.dir, cut.st.dir); same(full.vwap.vwap, cut.vwap.vwap); same(full.cci, cut.cci); same(full.obv, cut.obv); same(full.mfi, cut.mfi);
  same(full.atr, cut.atr); same(full.adx.adx, cut.adx.adx); same(full.cvd.cvd, cut.cvd.cvd);
});

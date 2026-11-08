import test from "node:test";
import assert from "node:assert/strict";
import { ema, atrSeries, adxSeries, volumeMomentum, dualEma, volatility, atrLevels, positionSize, adaptiveBands, emaFilter, countertrendAllowed } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { series } from "./fixtures.ts";

test("ema converges to a constant and ATR is positive and finite", () => {
  assert.ok(Math.abs(ema(Array(100).fill(5), 20).at(-1)! - 5) < 1e-9);
  const a = atrSeries(series(100)).at(-1)!;
  assert.ok(a > 0 && Number.isFinite(a));
});

test("ADX is high in a clean uptrend and low in a flat range, with +DI above -DI in the uptrend", () => {
  const up = adxSeries(series(300, { drift: 0.6, noise: 0.3 })), flat = adxSeries(series(300, { drift: 0, noise: 1, seed: 7 }));
  assert.ok(up.adx.at(-1)! > 30, "uptrend ADX " + up.adx.at(-1));
  assert.ok(flat.adx.at(-1)! < up.adx.at(-1)!);
  assert.ok(up.plusDI.at(-1)! > up.minusDI.at(-1)!);
});

test("volume momentum is positive on buying closes, negative on selling, and bounded", () => {
  const bull = volumeMomentum(series(100, { drift: 0.5, noise: 0.3 })), bear = volumeMomentum(series(100, { drift: -0.5, noise: 0.3 }));
  assert.ok(bull.score > 0 && bear.score < 0);
  assert.ok(Math.abs(bull.score) <= 100 && Math.abs(bear.score) <= 100);
  assert.ok(bull.buyingPressure > bull.sellingPressure);
});

test("thin-volume moves are damped relative to normally-participating moves", () => {
  const rows = series(100, { drift: 0.5, noise: 0.3 });
  const thin = rows.map((r, i) => (i === rows.length - 1 ? [r[0], r[1], r[2], r[3], r[4], r[5] * 0.05] : r) as typeof r);
  assert.ok(Math.abs(volumeMomentum(thin).score) < Math.abs(volumeMomentum(rows).score));
});

test("unusual volume is flagged on a spike", () => {
  const rows = series(100); rows[99][5] *= 6;
  assert.equal(volumeMomentum(rows).unusualVolume, true);
});

test("dual EMA reports bull state in an uptrend and a crossover alone is not confirmed without separation/slope", () => {
  const up = dualEma(series(200, { drift: 0.5, noise: 0.3 }), 12, 26);
  assert.equal(up.state, "bull");
  const flat = dualEma(series(200, { drift: 0, noise: 1, seed: 3 }), 12, 26);
  if (flat.crossover !== "none") assert.ok(flat.crossConfirmed === false || Math.abs(flat.separationAtr) >= 0.15);
});

test("ATR levels scale with volatility, never a fixed distance", () => {
  const a = atrLevels(1, 100, "normal"), b = atrLevels(3, 100, "normal"), c = atrLevels(1, 100, "extreme");
  assert.ok(b.stopDistance > a.stopDistance && c.stopDistance > a.stopDistance);
});

test("position size shrinks in extreme volatility and is zero for a degenerate stop", () => {
  assert.ok(positionSize(10000, 0.01, 100, 98, "extreme") < positionSize(10000, 0.01, 100, 98, "normal"));
  assert.equal(positionSize(10000, 0.01, 100, 100, "normal"), 0);
  assert.equal(positionSize(10000, 0.01, 100, 98, "normal"), 50);
});

test("volatility classification returns a valid class and percentile in [0,1]", () => {
  const v = volatility(series(300));
  assert.ok(["low", "normal", "high", "extreme"].includes(v.classification));
  assert.ok(v.percentile >= 0 && v.percentile <= 1);
});

test("adaptive bands stay bullish in an uptrend and flip less often in sideways chop than a no-hysteresis rule would", () => {
  const up = adaptiveBands(series(300, { drift: 0.5, noise: 0.3 }));
  assert.equal(up.trend, "bull"); assert.ok(up.lower < 400 && up.active === up.lower);
  const chop = adaptiveBands(series(300, { drift: 0, noise: 1.2, seed: 11 }));
  assert.ok(chop.flipsLast50 <= 6, "flips " + chop.flipsLast50);
});

test("bearish series yields bear bands with active level above price", () => {
  const rows = series(300, { drift: -0.4, noise: 0.3, start: 400 });
  const b = adaptiveBands(rows);
  assert.equal(b.trend, "bear"); assert.ok(b.active > rows.at(-1)![4]);
});

test("EMA filter aligns bullishly in an uptrend and countertrend requires strong evidence + reward/risk", () => {
  const f = emaFilter(series(300, { drift: 0.5, noise: 0.3 }));
  assert.equal(f.alignment, "bull");
  assert.equal(countertrendAllowed(f, -1, 50, 3.5), false);
  assert.equal(countertrendAllowed(f, -1, 80, 2), false);
  assert.equal(countertrendAllowed(f, -1, 80, 3.5), true);
  assert.equal(countertrendAllowed(f, 1, 0, 0), true);
});

test("regime classifier: trends, range, abnormal, and abnormal blocks new entries", () => {
  const up = classifyRegime(series(300, { drift: 0.6, noise: 0.3 }));
  assert.ok(["strong_bullish_trend", "weak_bullish_trend", "breakout", "high_volatility"].includes(up.regime), up.regime);
  const dn = classifyRegime(series(300, { drift: -0.6, noise: 0.3, start: 500 }));
  assert.ok(["strong_bearish_trend", "weak_bearish_trend", "breakout", "high_volatility"].includes(dn.regime), dn.regime);
  const rows = series(300, { noise: 0.8, seed: 5 }); const l = rows[299];
  rows[299] = [l[0], l[1], l[1] + 60, l[1] - 60, l[4], l[5]];
  const ab = classifyRegime(rows);
  assert.equal(ab.regime, "abnormal"); assert.equal(ab.profile.allowNewEntries, false); assert.equal(ab.profile.exposureScale, 0);
  assert.equal(classifyRegime(series(30)).regime, "abnormal");
});

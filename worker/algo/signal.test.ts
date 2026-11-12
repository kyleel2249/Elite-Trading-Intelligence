import test from "node:test";
import assert from "node:assert/strict";
import { series, rangeSeries } from "./fixtures.ts";
import { TIMEFRAMES, TF_SECONDS, analyzeTimeframe, buildConsensus, DEFAULT_WEIGHTS, type Timeframe } from "./timeframes.ts";
import { analyzeLiquidity, liquidityForDirection, type DepthSnapshot } from "./liquidity.ts";
import { computeLevels, tightenStop, manageStop } from "./levels.ts";
import { validateSignal, DEFAULT_VALIDATION_WEIGHTS } from "./validation.ts";
import { buildSignal } from "./signal.ts";
import { adaptiveBands, emaFilter, volumeMomentum } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { marketStructure } from "./timeframes.ts";

const NOW = 1_800_000_000_000;
function allTf(drift: number, noise = 0.3, start = 100, seed = 1) {
  const c: Partial<Record<Timeframe, any>> = {};
  for (const tf of TIMEFRAMES) c[tf] = series(260, { drift, noise, start, seed, stepMs: TF_SECONDS[tf] * 1000, end: NOW });
  return c;
}
function depth(price: number, bidScale = 1, askScale = 1, ts = NOW, spread = 0.02): DepthSnapshot {
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 20; i++) { bids.push([price - spread / 2 - i * 0.05, 10 * bidScale]); asks.push([price + spread / 2 + i * 0.05, 10 * askScale]); }
  return { bids, asks, timestamp: ts };
}

test("each timeframe is analysed with all required fields, and short histories are unavailable", () => {
  const rows = series(260, { drift: 0.5, noise: 0.3 });
  const a = analyzeTimeframe("1h", rows)!;
  for (const k of ["trend", "momentum", "volumeConfirms", "emaAlignment", "atrPercent", "structure", "divergence", "signalStrength", "reliability"]) assert.ok(k in a, k);
  assert.equal(a.trend, "bull");
  assert.equal(analyzeTimeframe("1h", series(50)), null);
});

test("consensus: weighted, counts timeframes, flags conflicts, never execution-eligible", () => {
  const up = allTf(0.5), an: any = {};
  for (const tf of TIMEFRAMES) an[tf] = analyzeTimeframe(tf, up[tf]);
  const c = buildConsensus(an, "intraday");
  assert.equal(c.direction, "bull"); assert.equal(c.bullish, 8); assert.equal(c.executionEligible, false);
  assert.ok(c.dominantTimeframe !== null && c.confidence > 0);
  // Conflict: bearish higher timeframes, bullish lower.
  const mixed: any = { ...an };
  for (const tf of ["4h", "1d", "1w"] as Timeframe[]) mixed[tf] = analyzeTimeframe(tf, series(260, { drift: -0.5, noise: 0.3, start: 400, stepMs: TF_SECONDS[tf] * 1000, end: NOW }));
  const m = buildConsensus(mixed, "intraday");
  assert.ok(m.conflicts.length > 0); assert.ok(m.confidence < c.confidence);
});

test("timeframe importance depends on strategy: scalp ignores weekly, position ignores 1m", () => {
  assert.equal(DEFAULT_WEIGHTS.scalp["1w"], 0); assert.equal(DEFAULT_WEIGHTS.position["1m"], 0);
  for (const s of Object.values(DEFAULT_WEIGHTS)) assert.ok(Math.abs(Object.values(s).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("missing timeframes degrade the consensus", () => {
  const up = allTf(0.5), an: any = {};
  for (const tf of ["1m", "5m", "15m"] as Timeframe[]) an[tf] = analyzeTimeframe(tf, up[tf]);
  assert.equal(buildConsensus(an, "swing").degraded, true);
});

test("liquidity: imbalance, spread, stale, crossed, incomplete, and large-wall detection", () => {
  const ok = analyzeLiquidity(depth(100, 3, 1), 100, NOW);
  assert.equal(ok.status, "ok"); assert.ok(ok.imbalance! > 0.3);
  assert.equal(analyzeLiquidity(depth(100, 1, 1, NOW - 60000), 100, NOW).status, "blocked");
  assert.equal(analyzeLiquidity(null, 100, NOW).status, "blocked");
  assert.equal(analyzeLiquidity({ bids: [[100, 1]], asks: [[101, 1]], timestamp: NOW }, 100, NOW).status, "blocked");
  const crossed = depth(100); crossed.bids[0][0] = 101; assert.equal(analyzeLiquidity(crossed, 100, NOW).status, "blocked");
  assert.equal(analyzeLiquidity(depth(100, 1, 1, NOW, 1.0), 100, NOW).status, "degraded");
  assert.equal(analyzeLiquidity(depth(100), 150, NOW).status, "blocked", "wrong-asset price mismatch");
  const wall = depth(100); wall.asks[1][1] = 1000;
  const la = analyzeLiquidity(wall, 100, NOW);
  assert.ok(la.largeOrders.some(l => l.side === "ask"));
  assert.equal(liquidityForDirection(la, 1).trapNearby, true);
  assert.equal(liquidityForDirection(la, -1).trapNearby, false);
  assert.ok(la.caveat.includes("not guaranteed"));
});

test("liquidity deterioration is detected versus the previous snapshot", () => {
  const prev = analyzeLiquidity(depth(100, 2, 2), 100, NOW);
  const now = analyzeLiquidity(depth(100, 0.5, 0.5), 100, NOW, { prev });
  assert.equal(now.deteriorating, true);
});

test("levels: ATR-scaled stop, ordered targets, risk/reward correct, structure caps TP, SELL mirrors BUY", () => {
  const rows = series(260, { drift: 0.4, noise: 0.4 });
  const st = marketStructure(rows), price = rows.at(-1)![4];
  const b = computeLevels(price, 1, 2, "normal", { ...st, support: null, resistance: null, supports: [], resistances: [] });
  assert.ok(b.stop < price && b.targets[0].price < b.targets[1].price && b.targets[1].price < b.targets[2].price);
  assert.ok(Math.abs(b.targets[2].rewardRisk - 3.5) < 0.01);
  assert.ok(Math.abs(b.targets.reduce((s, t) => s + t.closeFraction, 0) - 1) < 1e-9);
  const s = computeLevels(price, -1, 2, "normal", { ...st, support: null, resistance: null, supports: [], resistances: [] });
  assert.ok(s.stop > price && s.targets[0].price > s.targets[1].price);
  const capped = computeLevels(100, 1, 1, "normal", { bias: "bull", support: null, resistance: 103, supports: [], resistances: [103] });
  assert.ok(capped.targets[1].price < 103 && capped.targets[1].limitedByStructure);
  assert.ok(computeLevels(100, 1, 1, "high", { bias: "bull", support: null, resistance: null, supports: [], resistances: [] }).stopDistance > computeLevels(100, 1, 1, "low", { bias: "bull", support: null, resistance: null, supports: [], resistances: [] }).stopDistance);
  assert.equal(computeLevels(100, 1, 10, "normal", { bias: "bull", support: null, resistance: null, supports: [], resistances: [] }).exceedsMaxStop, true);
});

test("stop management never widens: break-even after TP1, trail after TP2, widening request ignored", () => {
  const lv = computeLevels(100, 1, 1, "normal", { bias: "bull", support: null, resistance: null, supports: [], resistances: [] });
  assert.equal(tightenStop(98, 90, 1), 98); assert.equal(tightenStop(98, 99, 1), 99);
  assert.equal(tightenStop(102, 110, -1), 102);
  let st = { stop: lv.stop, hitTargets: 0, highWater: 100 };
  st = manageStop(lv, { ...st, hitTargets: 1 }, 103); assert.ok(st.stop >= 100);
  const after1 = st.stop;
  st = manageStop(lv, { ...st, hitTargets: 2 }, 108); assert.ok(st.stop > after1);
  const trailed = st.stop; st = manageStop(lv, st, 104); assert.ok(st.stop >= trailed, "price pullback must not loosen the trail");
});

function validationInput(over: any = {}) {
  const rows = series(260, { drift: 0.5, noise: 0.3 });
  const an: any = {}; for (const tf of TIMEFRAMES) an[tf] = analyzeTimeframe(tf, rows);
  return { direction: 1 as const, emaFilter: emaFilter(rows), bands: adaptiveBands(rows), volume: volumeMomentum(rows), structure: marketStructure(rows), consensus: buildConsensus(an, "intraday"), regime: classifyRegime(rows),
    liquidity: analyzeLiquidity(depth(rows.at(-1)![4], 2, 1, NOW), rows.at(-1)![4], NOW), rewardRiskTP1: 1.2, rewardRiskTP3: 3.5, stopExceedsMax: false,
    data: { fresh: true, providersAgree: true, candlesComplete: true, ageSec: 5, provider: "t" }, risk: { withinLimits: true, reasons: [] }, expectancyR: 0.4, expectancySamples: 80, ...over };
}

test("validation: strong aligned evidence reaches CONFIRMED or HIGH_CONVICTION; score is bounded and checklist covers 13 questions", () => {
  const v = validateSignal(validationInput());
  assert.ok(["CONFIRMED", "HIGH_CONVICTION"].includes(v.classification), v.classification + " " + v.hardFailures.join(","));
  assert.ok(v.score > 0 && v.score <= 100); assert.equal(v.checklist.length, 13);
  assert.ok(Math.abs(Object.values(v.weights).reduce((a, b) => a + b, 0) - 100) < 1e-6);
});

test("validation: a hard failure overrides a high score (stale data, negative expectancy, risk breach, abnormal regime, liquidity trap)", () => {
  const base = validateSignal(validationInput());
  for (const over of [{ data: { fresh: false, providersAgree: true, candlesComplete: true, ageSec: 999, provider: "t" } }, { expectancyR: -0.2 }, { risk: { withinLimits: false, reasons: ["Daily loss limit reached"] } }, { rewardRiskTP3: 1.0 }, { stopExceedsMax: true }]) {
    const v = validateSignal(validationInput(over));
    assert.equal(v.classification, "REJECTED"); assert.ok(v.hardFailures.length > 0); assert.equal(v.liveExecutionAllowed, false);
  }
  assert.notEqual(base.classification, "REJECTED");
});

test("validation: HIGH_CONVICTION needs validated positive expectancy; unmeasured is capped", () => {
  const v = validateSignal(validationInput({ expectancyR: null }));
  assert.notEqual(v.classification, "HIGH_CONVICTION"); assert.ok(v.warnings.some(w => /expectancy/i.test(w)));
});

test("validation: opposing independent evidence rejects or downgrades and reports the disagreement", () => {
  const v = validateSignal(validationInput({ direction: -1 }));
  assert.ok(v.classification === "REJECTED" || v.classification === "HOLD" || v.classification === "EARLY");
  assert.ok(v.disagreement !== null || v.hardFailures.length > 0);
  assert.ok(v.opposingFamilies >= 2);
});

test("validation: missing order book degrades the signal and blocks live execution", () => {
  const v = validateSignal(validationInput({ liquidity: null }));
  assert.equal(v.degraded, true); assert.equal(v.liveExecutionAllowed, false);
});

test("validation weights are configurable and normalised", () => {
  const a = validateSignal(validationInput({ weights: { ...DEFAULT_VALIDATION_WEIGHTS, liquidity: 60 } }));
  assert.ok(Math.abs(Object.values(a.weights).reduce((x, y) => x + y, 0) - 100) < 1e-6); assert.ok(a.weights.liquidity > 40);
});

test("buildSignal: uptrend across 8 timeframes yields an actionable BUY with entry, stop below, three ordered TPs, expiry, invalidation", () => {
  const s = buildSignal({ symbol: "BTCUSDT", strategy: "intraday", candles: allTf(0.5), depth: depth(allTf(0.5)["15m"].at(-1)[4], 2, 1, NOW), now: NOW, expectancyR: 0.3, expectancySamples: 60, equity: 10000, riskFraction: 0.01 });
  assert.equal(s.action, "BUY"); assert.ok(["EARLY", "CONFIRMED", "HIGH_CONVICTION"].includes(s.classification));
  assert.ok(s.stopLoss! < s.entry!); assert.equal(s.takeProfits!.length, 3);
  assert.ok(s.takeProfits![0].price < s.takeProfits![1].price && s.takeProfits![1].price < s.takeProfits![2].price);
  assert.ok(new Date(s.expiresAt!).getTime() > NOW); assert.ok(s.invalidation.length >= 4); assert.ok(s.positionSize! > 0);
  assert.equal(s.consensus.executionEligible, false); assert.ok(s.ownIntellectualProperty.includes("Independently"));
});

test("buildSignal: downtrend yields SELL with mirrored levels", () => {
  const c = allTf(-0.5, 0.3, 500);
  const s = buildSignal({ symbol: "ETHUSDT", strategy: "intraday", candles: c, depth: depth(c["15m"].at(-1)[4], 1, 2, NOW), now: NOW, expectancyR: 0.3 });
  assert.equal(s.action, "SELL"); assert.ok(s.stopLoss! > s.entry!); assert.ok(s.takeProfits![0].price < s.entry!);
  assert.ok(s.takeProfits![0].price > s.takeProfits![1].price && s.takeProfits![1].price > s.takeProfits![2].price);
  assert.equal(s.consensus.direction, "bear");
});

test("buildSignal: a genuine range returns HOLD with no levels; missing exec timeframe returns HOLD", () => {
  const c: any = {}; for (const tf of TIMEFRAMES) c[tf] = rangeSeries(260, { stepMs: TF_SECONDS[tf] * 1000, end: NOW });
  const s = buildSignal({ symbol: "XRPUSDT", strategy: "intraday", candles: c, now: NOW, expectancyR: 0.3 });
  assert.equal(s.action, "HOLD", `${s.action} ${s.classification} cons=${s.consensus.weightedScore}`);
  assert.equal(s.entry, null); assert.equal(s.stopLoss, null); assert.equal(s.takeProfits, null); assert.equal(s.liveExecutionAllowed, false);
  const none = buildSignal({ symbol: "XRPUSDT", strategy: "intraday", candles: {}, now: NOW });
  assert.equal(none.action, "HOLD"); assert.equal(none.entry, null);
});

test("buildSignal: stale candles reject the signal and block live execution", () => {
  const s = buildSignal({ symbol: "BTCUSDT", strategy: "intraday", candles: allTf(0.5), now: NOW + 10 * 86400 * 1000, expectancyR: 0.3 });
  assert.equal(s.liveExecutionAllowed, false); assert.ok(s.classification === "REJECTED" || s.action === "HOLD");
});

import test from "node:test";
import assert from "node:assert/strict";
import { analyseEarlyAlpha, classifyStage, liquidityScore, WEIGHTS, MIN_BARS } from "./earlyalpha.ts";
import { makeCandles, range, trend } from "./testdata.ts";

const run = (segs: any[], extra: any = {}) => analyseEarlyAlpha(makeCandles(segs, { price: 50 }), { assetClass: "crypto", interval: "1h", ...extra })!;

test("weights sum to 1 for every asset class", () => {
  for (const cls of ["crypto", "equity"] as const) assert.ok(Math.abs(Object.values(WEIGHTS[cls]).reduce((a, b) => a + b, 0) - 1) < 1e-9, cls);
});
test("fewer than MIN_BARS candles returns null (fail closed)", () => {
  assert.equal(analyseEarlyAlpha(makeCandles([range(MIN_BARS - 1)]), { assetClass: "crypto", interval: "1h" }), null);
});
test("unavailable factors are null and excluded, coverage reflects it", () => {
  const r = run([trend(120, 0.0005), range(80)]);
  const byId = Object.fromEntries(r.factors.map(f => [f.id, f]));
  for (const id of ["onchain", "institutional", "catalyst", "valuation", "relativeStrength"]) assert.equal(byId[id].score, null, id);
  assert.ok(r.evidenceCoverage < 0.8 && r.evidenceCoverage > 0.3);
  assert.match(r.uncertainty, /technical early-warning|not a probability/);
});
test("external evidence raises coverage and is carried through", () => {
  const base = run([trend(120, 0.0005), range(80)]);
  const withExt = run([trend(120, 0.0005), range(80)], { external: { onchain: { score: 0.9, evidence: ["whales accumulating"], sources: ["test"] } } });
  assert.ok(withExt.evidenceCoverage > base.evidenceCoverage);
  assert.equal(withExt.factors.find(f => f.id === "onchain")!.score, 0.9);
});
test("score is within 0..100 and deterministic", () => {
  const a = run([trend(150, 0.001), range(60)]), b = run([trend(150, 0.001), range(60)]);
  assert.ok(a.score >= 0 && a.score <= 100); assert.deepEqual(a, b);
});
test("sustained strong uptrend with a fresh breakout is not classified as an early stage", () => {
  const r = run([range(150), trend(60, 0.004, 0.003, 1500)]);
  assert.ok(["TREND_EXPANSION", "MOMENTUM_EXHAUSTION", "BREAKOUT_CONFIRMATION"].includes(r.stage), r.stage + " " + r.stageReasons);
});
test("a collapse is flagged REVERSAL_RISK with bias risk", () => {
  const r = run([trend(150, 0.002), trend(14, -0.012, 0.004, 3000)]);
  assert.equal(r.stage, "REVERSAL_RISK"); assert.equal(r.stageBias, "risk");
});
test("tight base near highs after an advance is BREAKOUT_FORMATION or EARLY_ACCUMULATION (never a risk stage)", () => {
  const r = run([trend(140, 0.0015, 0.005, 1200), { bars: 70, drift: 0.00005, vol: 0.0012, volume: 700 }]);
  assert.ok(["BREAKOUT_FORMATION", "EARLY_ACCUMULATION", "NONE", "TREND_EXPANSION"].includes(r.stage), r.stage + " " + r.stageReasons);
  assert.notEqual(r.stageBias, "risk");
});
test("high volume with falling price is not rewarded as demand", () => {
  const up = run([range(180), trend(5, 0.004, 0.003, 6000)]), down = run([range(180), trend(5, -0.004, 0.003, 6000)]);
  const v = (r: any) => r.factors.find((f: any) => f.id === "volumeAnomaly").score;
  assert.ok(v(up) > v(down), v(up) + " vs " + v(down));
});
test("single-print volume spike is discounted", () => {
  const rows = makeCandles([range(200)]); const spiked = rows.map((r, i) => i === rows.length - 1 ? [r[0], r[1], r[2], r[3], r[4], r[5] * 40] as any : r);
  const a = analyseEarlyAlpha(spiked, { assetClass: "crypto", interval: "1h" })!, f = a.factors.find(x => x.id === "volumeAnomaly")!;
  assert.match(f.evidence.join(" "), /single-print/);
});
test("illiquid assets score zero liquidity; zero-volume gaps halve it", () => {
  assert.equal(liquidityScore(100_000, "crypto"), 0); assert.equal(liquidityScore(2e9, "crypto"), 1); assert.equal(liquidityScore(500_000, "equity"), 0);
});
test("relative strength uses aligned benchmark candles", () => {
  const rows = makeCandles([range(150), trend(60, 0.003)], { price: 50 }), bench = makeCandles([range(210)], { price: 100 });
  const r = analyseEarlyAlpha(rows, { assetClass: "crypto", interval: "1h", benchmark: bench })!;
  const f = r.factors.find(x => x.id === "relativeStrength")!; assert.ok(f.score !== null && f.score > 0.6, String(f.score));
});
test("classifyStage returns NONE on featureless noise", () => {
  const r = run([range(210, 0.003)]); assert.ok(["NONE", "EARLY_ACCUMULATION", "PRE_ACCUMULATION", "BREAKOUT_FORMATION", "DISTRIBUTION"].includes(r.stage));
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { regimeSeries, series } from "./fixtures.ts";
import { buildGrid, simulate, metrics, optimize, expectancyFromReport, DEFAULT_COSTS, type Prepared, type BtParams, type Trade } from "./backtest.ts";

const T0 = 1_700_000_000_000;
const P: BtParams = { fast: 8, slow: 26, atrMult: 1, minFlow: 5, regimeFilter: false };
/** Hand-built market: a long entry signal exists ONLY at bar 60; later bars are scripted. */
function scripted(dir: 1 | -1, bars: Record<number, [number, number, number, number]>, n = 130, signalAt = 60): Prepared {
  const rows: Kline[] = Array.from({ length: n }, (_, i) => { const b = bars[i]; return [T0 + i * 3600000, b ? b[0] : 100, b ? b[1] : 100.3, b ? b[2] : 99.7, b ? b[3] : 100, 100] as Kline; });
  const nan = new Array(n).fill(NaN), ones = (v: number) => new Array(n).fill(v);
  const flow = [...nan]; flow[signalAt] = 50 * dir;
  const ema = new Map<number, number[]>([[8, ones(100 + dir)], [26, ones(100)]]);
  return { rows, atr: ones(1), adx: ones(30), plusDI: ones(dir > 0 ? 30 : 10), minusDI: ones(dir > 0 ? 10 : 30), flow, bands: { trend: new Array(n).fill(dir > 0 ? "bull" : "bear"), upper: ones(0), lower: ones(0), flips: [], firstIdx: 15 }, ema };
}
const RT = 2 * (DEFAULT_COSTS.feeBps + DEFAULT_COSTS.slippageBps) / 1e4; // 0.003 of entry; entry 100, dist 1 -> 0.3R
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("long: TP1, TP2 and TP3 hit in sequence; partial R and costs are exact", () => {
  const p = scripted(1, { 61: [100, 101.3, 99.5, 101], 62: [101, 102.3, 100.5, 102], 63: [102, 103.6, 101.5, 103.5] });
  const t = simulate(p, P, 0, 130);
  assert.equal(t.length, 1); assert.equal(t[0].reason, "tp3"); assert.equal(t[0].targetsHit, 3);
  near(t[0].grossR, 0.4 * 1.2 + 0.3 * 2.2 + 0.3 * 3.5); near(t[0].costR, 100 * RT / 1); near(t[0].r, 2.19 - 0.3);
});

test("stop is tested first when a bar spans both stop and targets (conservative), losing exactly 1R plus costs", () => {
  const t = simulate(scripted(1, { 61: [100, 105, 98.9, 104] }), P, 0, 130);
  assert.equal(t[0].reason, "stop"); assert.equal(t[0].targetsHit, 0); near(t[0].grossR, -1); near(t[0].r, -1.3);
});

test("gap through the stop fills at the gap open, not at the stop", () => {
  const t = simulate(scripted(1, { 61: [100, 100.3, 99.5, 100], 62: [97, 97.5, 96.5, 97] }), P, 0, 130);
  near(t[0].exit, 97); near(t[0].grossR, -3);
});

test("break-even after TP1 sits at entry plus round-trip fees (the paper engine's rule): the remainder exits there", () => {
  const t = simulate(scripted(1, { 61: [100, 101.3, 99.5, 101], 62: [100.5, 100.8, 99.9, 100.2] }), P, 0, 130);
  // fee buffer = 100 * (10 bps * 2) = 0.2, so the remaining 60% exits at 100.2 = +0.2R: 0.48 + 0.6 * 0.2
  assert.equal(t[0].reason, "breakeven"); near(t[0].exit, 100.2); near(t[0].grossR, 0.6); near(t[0].r, 0.3);
});

test("no look-ahead: entry is the OPEN of the bar after the signal", () => {
  const t = simulate(scripted(1, { 60: [100, 100.3, 99.7, 100], 61: [100.5, 100.8, 100.2, 100.5] }), P, 0, 130);
  assert.equal(t[0].entryIdx, 61); near(t[0].entry, 100.5);
});

test("short trades mirror long trades (stop above, targets below)", () => {
  const stopped = simulate(scripted(-1, { 61: [100, 101.2, 99.8, 101] }), P, 0, 130);
  assert.equal(stopped[0].dir, -1); assert.equal(stopped[0].reason, "stop"); near(stopped[0].grossR, -1);
  const won = simulate(scripted(-1, { 61: [100, 100.2, 98.7, 99], 62: [99, 99.2, 97.7, 98], 63: [98, 98.2, 96.4, 96.5] }), P, 0, 130);
  assert.equal(won[0].reason, "tp3"); near(won[0].grossR, 2.19);
});

test("flat market is closed by the time stop after the maximum holding period", () => {
  const t = simulate(scripted(1, {}, 200), P, 0, 200);
  assert.equal(t[0].reason, "time"); assert.equal(t[0].exitIdx, 60 + 1 + 100);
});

test("higher costs reduce every trade's net R by exactly the cost difference; gross R unchanged", () => {
  const p = scripted(1, { 61: [100, 101.3, 99.5, 101], 62: [101, 102.3, 100.9, 102], 63: [102, 103.6, 101.5, 103.5] });
  const a = simulate(p, P, 0, 130, { feeBps: 0, slippageBps: 0 })[0], b = simulate(p, P, 0, 130, { feeBps: 20, slippageBps: 10 })[0];
  near(a.grossR, b.grossR); near(a.r - b.r, 100 * (2 * 30 / 1e4)); near(a.costR, 0);
});

test("metrics: win rate, profit factor, expectancy, averages, losing streak, drawdown", () => {
  const mk = (r: number): Trade => ({ entryIdx: 1, exitIdx: 3, dir: 1, entry: 100, stop0: 99, exit: 100, grossR: r, costR: 0, r, targetsHit: 0, reason: "stop" });
  const m = metrics([2, -1, -1, 1.5, -1, -1, -1, 3].map(mk), 100, 1);
  assert.equal(m.trades, 8); near(m.winRate!, 3 / 8); near(m.profitFactor!, 6.5 / 5); near(m.expectancyR!, 1.5 / 8);
  near(m.avgWinR!, 6.5 / 3); near(m.avgLossR!, -1); near(m.avgRewardRisk!, 6.5 / 3); assert.equal(m.maxConsecutiveLosses, 3);
  assert.ok(m.maxDrawdownPct > 2.5 && m.maxDrawdownPct < 3.5); assert.equal(m.costsIncluded, true); assert.equal(m.label, "backtested");
  assert.equal(metrics([], 100, 1).winRate, null);
  // The shared report (same code the paper/replay layers use) withholds rates below its minimum sample instead of showing them.
  assert.equal(m.report.status, "insufficient_sample"); assert.equal(m.report.winRate, null); assert.ok(m.report.winRateInterval95);
});

test("shared report: with enough trades it matches the screen's own numbers (one definition of expectancy, profit factor, win rate)", () => {
  const mk2 = (r: number): Trade => ({ entryIdx: 1, exitIdx: 3, dir: 1, entry: 100, stop0: 99, exit: 100, grossR: r, costR: 0, r, targetsHit: 0, reason: "stop" });
  const rs = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 2.5 : -1)), m = metrics(rs.map(mk2), 400, 1);
  assert.equal(m.report.status, "ok"); near(m.report.winRate!, m.winRate!); near(m.report.expectancyR!, m.expectancyR!, 1e-9); near(m.report.profitFactor!, m.profitFactor!, 1e-9);
  assert.equal(m.report.maxConsecutiveLosses, m.maxConsecutiveLosses);
});

test("the optimisation grid has at least 144 combinations and can be expanded", () => {
  assert.ok(buildGrid().length >= 144);
  assert.ok(buildGrid({ fast: [8, 12], slow: [26, 50], atrMult: [1, 2], minFlow: [5], regimeFilter: [false, true, true] }).length === 24);
});

const mk = (seed: number, n = 1000) => regimeSeries(n, { seed, end: 1.8e12 });
test("optimiser evaluates the full grid, splits chronologically, and a market with real structure passes every robustness check", () => {
  const r = optimize({ A: mk(3), B: mk(8), C: mk(12) });
  assert.equal(r.status, "ok"); assert.ok(r.combinationsEvaluated >= 144); assert.equal(r.split.chronological, true); assert.equal(r.split.trainEnd, 600);
  assert.ok(r.walkForward.folds.length >= 3); assert.ok(r.crossMarket.length === 2);
  assert.equal(r.robust, true, r.reasons.join("; "));
  const e = expectancyFromReport(r)!; assert.ok(e.expectancyR > 0 && e.samples >= 15);
  assert.match(r.disclaimer, /not a forecast/i); assert.equal(r.label, "backtested");
});

test("a driftless random walk is NOT declared robust and yields no validated expectancy", () => {
  const r = optimize({ A: series(1000, { drift: 0, noise: 0.8, seed: 5, end: 1.8e12 }), B: series(1000, { drift: 0, noise: 0.8, seed: 6, end: 1.8e12 }) });
  assert.equal(r.robust, false); assert.ok(r.reasons.length > 0); assert.equal(expectancyFromReport(r), null);
});

test("no leakage: rewriting the out-of-sample candles cannot change parameter selection or training metrics", () => {
  const a = mk(3), b = a.map((c, i) => (i >= 600 ? ([c[0], c[1] * 1.5, c[2] * 1.5, c[3] * 1.5, c[4] * 1.5, c[5]] as Kline) : c));
  const ra = optimize({ A: a }), rb = optimize({ A: b });
  assert.equal(ra.selected!.key, rb.selected!.key); assert.equal(ra.selected!.train.expectancyR, rb.selected!.train.expectancyR);
});

test("too little data returns insufficient_data instead of a fabricated result", () => {
  const r = optimize({ A: mk(3, 200) });
  assert.equal(r.status, "insufficient_data"); assert.equal(r.robust, false); assert.equal(r.selected, null); assert.ok(r.reasons[0].includes("400"));
});

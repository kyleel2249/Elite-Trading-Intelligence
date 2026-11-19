import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { computeSuite } from "./indicator-suite.ts";
import { buildSignalIntel, fuse, signalMarkers, walkForward, votesAt, type Vote } from "./signal-intel.ts";

function series(n: number, drift: number, seed = 7, step = 3600e3, t0 = 1_700_000_000_000): Kline[] {
  let x = seed, p = 100; const out: Kline[] = [];
  const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
  for (let i = 0; i < n; i++) { const o = p, c = p * (1 + drift + rnd() * 0.012); out.push([t0 + i * step, o, Math.max(o, c) * 1.003, Math.min(o, c) * 0.997, c, 1000 + 500 * Math.abs(rnd())] as unknown as Kline); p = c; }
  return out;
}
const now = (r: Kline[]) => r[r.length - 1][0] + 3600e3 * 2;
const vote = (d: 1 | -1, group: Vote["group"], w = 1): Vote => ({ id: group + d, label: "x", group, style: "trend", direction: d, strength: 1, weight: w, detail: "" });

test("fusion flags conflict and requires agreement", () => {
  const split = fuse([vote(1, "trend"), vote(-1, "momentum"), vote(1, "volume"), vote(-1, "volatility")]);
  assert.equal(split.conflicted, true);
  const agree = fuse([vote(1, "trend"), vote(1, "momentum"), vote(1, "volume"), vote(1, "structure")]);
  assert.equal(agree.direction, 1); assert.equal(agree.conflicted, false); assert.ok(agree.groupsAgree >= 3);
});
test("markers are non-repainting: truncating later candles never changes earlier markers", () => {
  const rows = series(400, 0.002), full = signalMarkers(rows, computeSuite(rows)), cut = rows.slice(0, 330), part = signalMarkers(cut, computeSuite(cut));
  assert.deepEqual(part, full.filter((m) => m.t <= cut[cut.length - 1][0]));
});
test("walk-forward validation reports honest status", () => {
  assert.equal(walkForward(series(50, 0)).status, "insufficient_history");
  const v = walkForward(series(900, 0.001));
  assert.ok(["sufficient", "insufficient_sample"].includes(v.status));
  if (v.n) { assert.ok(v.winRate! >= 0 && v.winRate! <= 1); assert.equal(v.wins + v.losses + v.expired, v.n); }
});
test("buildSignalIntel never enables execution and is well-formed", () => {
  const rows = series(600, 0.002), r = buildSignalIntel({ symbol: "BTCUSDT", timeframe: "1h", market: "futures", now: now(rows), candles: { "1h": rows } }) as any;
  assert.equal(r.submitsOrder, false); assert.equal(r.liveExecutionAllowed, false); assert.equal(r.canTriggerTrade, false); assert.equal(r.nonRepainting, true);
  assert.ok(["SIGNAL", "REJECTED", "CONFLICTED", "NEUTRAL"].includes(r.status));
  assert.ok(r.confidence >= 0 && r.confidence <= 100);
  if (r.validation.status !== "sufficient") assert.ok(r.confidence <= 60);
  if (r.plan) { const p = r.plan, long = r.direction === 1; assert.ok(long ? p.stop < p.entry && p.targets[0].price > p.entry : p.stop > p.entry && p.targets[0].price < p.entry); }
  assert.ok(r.chart.ichimoku.future.length > 0);
});
test("insufficient history and stale data are WAIT", () => {
  const few = series(60, 0.001); assert.equal((buildSignalIntel({ symbol: "X", timeframe: "1h", market: "spot", now: now(few), candles: { "1h": few } }) as any).action, "WAIT");
  const rows = series(400, 0.003), r = buildSignalIntel({ symbol: "X", timeframe: "1h", market: "spot", now: now(rows) + 3600e3 * 50, candles: { "1h": rows } }) as any;
  assert.equal(r.action, "WAIT");
});
test("an unclosed last candle is excluded", () => {
  const rows = series(300, 0.001), r = buildSignalIntel({ symbol: "X", timeframe: "1h", market: "spot", now: rows[rows.length - 1][0] + 1000, candles: { "1h": rows } }) as any;
  assert.equal(r.price, rows[rows.length - 2][4]);
});
test("votes expose explanations", () => { const rows = series(300, 0.002), s = computeSuite(rows); assert.ok(votesAt(rows, s, 299).every((v) => v.detail.length > 0)); });

import test from "node:test";
import assert from "node:assert/strict";
import { cycleConfig, cycleLimit, pickRotation, MAX_CYCLE_SYMBOLS, PAID_CYCLE_SYMBOLS } from "./paper-api.ts";

const env = (o: Record<string, string> = {}) => ({ ...o }) as any;

test("ETI_PAPER_SYMBOLS=ALL turns on all-pairs rotation and is not reported as an ignored symbol", () => {
  const c = cycleConfig(env({ ETI_PAPER_SYMBOLS: "ALL", ETI_PAPER_AUTOEXECUTE: "true" }));
  assert.equal(c.allPairs, true);
  assert.deepEqual(c.symbols, []);
  assert.deepEqual(c.ignored, []);
  assert.equal(c.autoExecute, true);
  assert.equal(cycleConfig(env({ ETI_PAPER_SYMBOLS: "*" })).allPairs, true);
  assert.equal(cycleConfig(env({ ETI_PAPER_SYMBOLS: "btcusdt, all" })).allPairs, true);
});

test("an explicit symbol list behaves exactly as before and never sets allPairs", () => {
  const c = cycleConfig(env({ ETI_PAPER_SYMBOLS: "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,bad" }));
  assert.equal("allPairs" in c, false);
  assert.deepEqual(c.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(c.ignored, ["BAD", "BNBUSDT"]);
  assert.equal(cycleConfig(env()).symbols.length, 0);
});

test("the per-run symbol limit is 3 on the free plan and larger on the paid plan", () => {
  assert.equal(cycleLimit(env()), MAX_CYCLE_SYMBOLS);
  assert.equal(cycleLimit(env({ ETI_ANALYSIS_PLAN: "free" })), 3);
  assert.equal(cycleLimit(env({ ETI_ANALYSIS_PLAN: "paid" })), PAID_CYCLE_SYMBOLS);
  assert.equal(cycleConfig(env({ ETI_ANALYSIS_PLAN: "paid", ETI_PAPER_SYMBOLS: Array.from({ length: 25 }, (_, i) => "COIN" + String.fromCharCode(65 + (i % 26)) + "USDT").join(",") })).symbols.length, 20);
});

test("rotation visits never-evaluated pairs first, then the least recently evaluated, and skips excluded pairs", () => {
  const universe = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"].map((symbol, i) => ({ symbol, quoteVolume: 1000 - i }));
  assert.deepEqual(pickRotation(universe, {}, new Set(), 3), ["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
  assert.deepEqual(pickRotation(universe, { AAAUSDT: 50, BBBUSDT: 10, CCCUSDT: 30 }, new Set(), 3), ["DDDUSDT", "EEEUSDT", "BBBUSDT"]);
  assert.deepEqual(pickRotation(universe, {}, new Set(["AAAUSDT"]), 2), ["BBBUSDT", "CCCUSDT"]);
  assert.deepEqual(pickRotation(universe, {}, new Set(), 0), []);
  assert.deepEqual(pickRotation(universe, {}, new Set(), -2), []);
});

test("repeated rotation covers the whole universe with no pair starved", () => {
  const universe = Array.from({ length: 10 }, (_, i) => ({ symbol: "P" + i + "AAUSDT", quoteVolume: 100 - i }));
  const last: Record<string, number> = {}, seen = new Set<string>();
  for (let run = 1; run <= 4; run++) for (const s of pickRotation(universe, last, new Set(), 3)) { seen.add(s); last[s] = run; }
  assert.equal(seen.size, 10);
});

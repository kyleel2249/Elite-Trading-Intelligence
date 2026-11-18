import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { assessFvgConfluence, FVG_MAX_CONFIDENCE_DELTA } from "./fvg-confluence.ts";
import { runOmnisignal } from "./omnisignal.ts";
import { series, regimeSeries } from "./fixtures.ts";
import { TIMEFRAMES } from "./timeframes.ts";

const H = 3600e3, T0 = 1_700_000_000_000;
const k = (i: number, o: number, h: number, l: number, c: number, v = 100): Kline => [T0 + i * H, o, h, l, c, v];
/** 40 quiet candles, then a bullish gap [100.5, 102.5], then price drifting back toward it. */
function bullishCase(): Kline[] {
  const r: Kline[] = [];
  for (let i = 0; i < 40; i++) r.push(k(i, 100, 100.5, 99.5, 100));
  r.push(k(40, 100, 103, 100, 102.8, 300), k(41, 102.8, 104, 102.5, 103.5));
  r[40][2] = 103; // displacement candle
  r.push(k(42, 103.5, 103.8, 103, 103.2), k(43, 103.2, 103.4, 102.9, 103.0));
  // make candle 39 the gap's first candle: high 100.5 < candle 41 low 102.5
  return r;
}
const plan = { entryZone: [102.8, 103.2] as [number, number], stopLoss: 100.2, takeProfits: [{ price: 106, rewardRisk: 1.1 }, { price: 108 }, { price: 110 }] };

test("a supporting bullish gap raises BUY confidence within the cap and never touches the plan", () => {
  const rows = bullishCase(), now = rows.at(-1)![0] + H;
  const buy = assessFvgConfluence({ "1h": rows }, "1h", 1, plan, now);
  assert.equal(buy.available, true);
  assert.ok(buy.confidenceDelta > 0 && buy.confidenceDelta <= FVG_MAX_CONFIDENCE_DELTA);
  assert.equal(buy.supporting[0].direction, "bullish");
  assert.equal(buy.canTriggerTrade, false); assert.equal(buy.advisoryOnly, true);
  assert.equal(plan.stopLoss, 100.2);
});

test("the same gap does not support a SELL", () => {
  const rows = bullishCase(), now = rows.at(-1)![0] + H;
  const sell = assessFvgConfluence({ "1h": rows }, "1h", -1, { entryZone: [102.8, 103.2], stopLoss: 105, takeProfits: [{ price: 100 }] }, now);
  assert.ok(sell.confidenceDelta <= 0);
  assert.equal(sell.supporting.length, 0);
});

test("entry optimisation is an advisory limit price at the gap midpoint and only when it improves the stop distance logic", () => {
  const rows = bullishCase(), now = rows.at(-1)![0] + H;
  const buy = assessFvgConfluence({ "1h": rows }, "1h", 1, plan, now);
  assert.ok(buy.entryOptimization, "a midpoint between stop and entry exists");
  assert.equal(buy.entryOptimization!.price, 101.5);
  assert.ok(buy.entryOptimization!.rewardRiskTP1! > buy.entryOptimization!.plannedRewardRiskTP1!);
  const none = assessFvgConfluence({ "1h": rows }, "1h", 1, { ...plan, stopLoss: 102 }, now);
  assert.equal(none.entryOptimization, null, "midpoint below the stop is never suggested");
});

test("too little data degrades safely to a neutral, zero-delta result", () => {
  const r = assessFvgConfluence({ "1h": bullishCase().slice(0, 10) }, "1h", 1, plan, T0);
  assert.equal(r.available, false); assert.equal(r.confidenceDelta, 0); assert.equal(r.canTriggerTrade, false);
});

function ctx(seed: number, strategy: "scalp" | "intraday" | "swing" = "intraday", drift = 0.2) {
  const end = Date.now(), candles: Record<string, Kline[]> = {};
  const steps: Record<string, number> = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3, "1w": 604800e3 };
  for (const tf of TIMEFRAMES) candles[tf] = regimeSeries(300, { seed, stepMs: steps[tf], end: end - (end % steps[tf]) - steps[tf], drift });
  return { symbol: "TESTUSDT", strategy, candles: candles as any, now: end };
}

test("FVG never creates, flips or removes a decision: with and without it the decision is identical and confidence differs by at most the cap", () => {
  let directional = 0, buys = 0, sells = 0, moved = 0;
  for (const drift of [-0.2, 0.2]) for (let seed = 1; seed <= 60; seed++) {
    const c = ctx(seed, "scalp", drift);
    const off = runOmnisignal(c), on = runOmnisignal(c, { fvg: true });
    const tag = `drift ${drift} seed ${seed}`;
    assert.equal(on.decision, off.decision, tag);
    assert.equal(off.fvg, null);
    assert.deepEqual(on.entryZone, off.entryZone, tag); assert.equal(on.stopLoss, off.stopLoss, tag); assert.deepEqual(on.takeProfits, off.takeProfits, tag);
    assert.ok(Math.abs(on.confidence - off.confidence) <= FVG_MAX_CONFIDENCE_DELTA, tag);
    if (on.decision === "BUY" || on.decision === "SELL") {
      directional++; if (on.decision === "BUY") buys++; else sells++;
      assert.ok(on.fvg && on.fvg.canTriggerTrade === false, tag);
      if (on.confidence !== off.confidence) moved++;
      assert.equal(on.confidence, Math.max(1, Math.min(100, off.confidence + on.fvg!.confidenceDelta)), tag);
    } else assert.equal(on.confidence, off.confidence, tag);
  }
  assert.ok(directional >= 10 && buys > 0 && sells > 0 && moved > 0, `exercised BUY/SELL decisions (${buys} buy, ${sells} sell, ${moved} adjusted)`);
});

test("a market with no directional proposal produces no FVG-driven trade even when gaps are everywhere", () => {
  const c = ctx(2);
  const r = runOmnisignal({ ...c, candles: { ...c.candles, "15m": series(300, { noise: 3, seed: 9, stepMs: 900e3, end: c.now - (c.now % 900e3) - 900e3 }) } }, { fvg: true });
  if (r.decision === "HOLD" || r.decision === "REJECTED" || r.decision === "DATA_UNRELIABLE") assert.equal(r.confidence, 0);
  assert.equal(r.submitsOrder, false); assert.equal(r.liveExecutionAllowed, false);
});

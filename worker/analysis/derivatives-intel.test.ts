import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { analyzeFundingHistory, analyzeOpenInterest, estimateLiquidationZones, fetchBybitDerivatives, parseBybitFunding, parseBybitOpenInterest } from "./derivatives-intel.ts";

const H = 3_600_000, T0 = Date.UTC(2026, 0, 1);
const bar = (i: number, c: number, o = c, hi = Math.max(o, c) + 1, lo = Math.min(o, c) - 1): Kline => [T0 + i * H, o, hi, lo, c, 100, 0];
const oiRes = (vals: number[]) => ({ retCode: 0, result: { list: vals.map((v, i) => ({ openInterest: String(v), timestamp: String(T0 + i * H) })).reverse() } });

test("parsers sort ascending, reject malformed payloads", () => {
  const p = parseBybitOpenInterest(oiRes([10, 11, 12]))!; assert.deepEqual(p.map((x) => x.oi), [10, 11, 12]);
  assert.equal(parseBybitOpenInterest({ retCode: 10001, result: {} }), null);
  assert.equal(parseBybitOpenInterest({ retCode: 0, result: { list: [{ openInterest: "x", timestamp: "1" }] } }), null);
  const f = parseBybitFunding({ retCode: 0, result: { list: [{ fundingRate: "0.0002", fundingRateTimestamp: "2000" }, { fundingRate: "0.0001", fundingRateTimestamp: "1000" }] } })!;
  assert.deepEqual(f.map((x) => x.rate), [0.0001, 0.0002]);
});

test("open-interest regime covers all four price/OI quadrants and refuses to guess without data", () => {
  const rising = Array.from({ length: 20 }, (_, i) => bar(i, 100 + i)), falling = Array.from({ length: 20 }, (_, i) => bar(i, 120 - i));
  const oiUp = parseBybitOpenInterest(oiRes(Array.from({ length: 20 }, (_, i) => 1000 + i * 30)))!, oiDown = parseBybitOpenInterest(oiRes(Array.from({ length: 20 }, (_, i) => 1600 - i * 30)))!;
  assert.equal(analyzeOpenInterest(oiUp, rising).regime, "long_buildup");
  assert.equal(analyzeOpenInterest(oiUp, falling).regime, "short_buildup");
  assert.equal(analyzeOpenInterest(oiDown, rising).regime, "short_covering");
  assert.equal(analyzeOpenInterest(oiDown, falling).regime, "long_liquidation");
  assert.equal(analyzeOpenInterest(oiUp, rising).supportsDirection, 1);
  assert.equal(analyzeOpenInterest(oiDown, rising).supportsDirection, 0);
  assert.equal(analyzeOpenInterest(null, rising).status, "unavailable");
});

test("funding history reports trend and extremes", () => {
  const f = (rates: number[]) => rates.map((rate, i) => ({ t: i, rate }));
  assert.equal(analyzeFundingHistory(f([0.0001, 0.0001, 0.0003, 0.0004])).trend, "rising");
  assert.equal(analyzeFundingHistory(f([0.0001, 0.0001, 0.0001, 0.0012])).extreme, true);
  assert.equal(analyzeFundingHistory(f([0.0001])).status, "unavailable");
});

test("liquidation zones are estimates: long liquidations below price, short above, consumed levels dropped", () => {
  const rows: Kline[] = Array.from({ length: 120 }, (_, i) => bar(i, 100 + 8 * Math.sin(i / 7), 100 + 8 * Math.sin((i - 1) / 7)));
  const zones = estimateLiquidationZones(rows, 1.5), price = rows.at(-1)![4];
  assert.ok(zones.length > 0 && zones.every((z) => z.estimated === true && z.strength >= 0 && z.strength <= 1));
  assert.ok(zones.filter((z) => z.side === "long_liquidations").every((z) => z.price < price));
  assert.ok(zones.filter((z) => z.side === "short_liquidations").every((z) => z.price > price));
  assert.deepEqual(estimateLiquidationZones(rows.slice(0, 10), 1.5), []);
});

test("bybit feed: futures only, falls back across hosts, and reports failures honestly", async () => {
  const calls: string[] = [];
  const ok: any = async (url: string) => { calls.push(url); return new Response(JSON.stringify(url.includes("open-interest") ? oiRes([1, 2, 3, 4]) : { retCode: 0, result: { list: [{ fundingRate: "0.0001", fundingRateTimestamp: "1" }] } })); };
  const spot = await fetchBybitDerivatives("BTCUSDT", "spot", "1h", ok);
  assert.equal(calls.length, 0); assert.equal(spot.oi, null); assert.ok(spot.failures.market);
  const fut = await fetchBybitDerivatives("BTCUSDT", "linear", "1h", ok);
  assert.equal(fut.oi!.length, 4); assert.ok(calls[0].includes("category=linear") && calls[0].includes("intervalTime=1h"));
  let n = 0; const flaky: any = async () => { n++; if (n === 1) throw new TypeError("down"); return new Response(JSON.stringify(oiRes([1, 2, 3, 4]))); };
  assert.equal((await fetchBybitDerivatives("BTCUSDT", "linear", "1h", flaky)).oi!.length, 4);
  const down: any = async () => { throw new TypeError("offline"); };
  const bad = await fetchBybitDerivatives("BTCUSDT", "linear", "1h", down);
  assert.equal(bad.oi, null); assert.equal(bad.failures.openInterest, "unreachable");
});

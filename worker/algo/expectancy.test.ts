import test from "node:test";
import assert from "node:assert/strict";
import { assess, checkRecord, expectancyFor, expectancyOptions, lookupFrom, MAX_AGE_MS, readStore, recordFromReplay, recordFromTrades, saveRecord, type ExpectancyRecord } from "./expectancy.ts";
import { MemoryKV } from "./kv.ts";
import type { ClosedTrade } from "./performance.ts";

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const good = (o: Record<string, unknown> = {}) => ({ strategy: "intraday", symbol: "BTCUSDT", source: "replay", expectancyR: 0.4, samples: 45, ciLow95: 0.1, ciHigh95: 0.7, periodStart: NOW - 60 * DAY, periodEnd: NOW - 2 * DAY, ...o });
const rec = (o: Partial<ExpectancyRecord> = {}): ExpectancyRecord => { const c = checkRecord(good(o as Record<string, unknown>), NOW); assert.ok(c.ok, JSON.stringify(c)); return (c as { record: ExpectancyRecord }).record; };

test("a well-formed replay record is accepted and measuredAt is the end of the evidence period", () => {
  const r = rec(); assert.equal(r.source, "replay"); assert.equal(r.measuredAt, NOW - 2 * DAY); assert.equal(r.symbol, "BTCUSDT");
  assert.equal(rec({ symbol: undefined }).symbol, "*");
});

test("records that could mislead the validator are rejected: wrong source, small sample, non-finite, absurd, bad interval, future or stale", () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["parametric screen as a source", { source: "screen" }, /source/], ["manual claim", { source: "manual" }, /source/], ["29 trades", { samples: 29 }, /samples/], ["fractional samples", { samples: 40.5 }, /samples/],
    ["NaN expectancy", { expectancyR: NaN }, /expectancyR/], ["string expectancy", { expectancyR: "0.5" }, /expectancyR/], ["absurd expectancy", { expectancyR: 50, ciLow95: 49, ciHigh95: 51 }, /expectancyR/],
    ["interval excludes the estimate", { ciLow95: 0.5, ciHigh95: 0.9 }, /interval/], ["unknown strategy", { strategy: "yolo" }, /strategy/], ["bad symbol", { symbol: "bad symbol" }, /symbol/],
    ["future period", { periodEnd: NOW + 10 * DAY, periodStart: NOW - DAY }, /future/], ["already stale", { periodEnd: NOW - 40 * DAY, periodStart: NOW - 90 * DAY }, /older than/], ["period reversed", { periodStart: NOW - DAY, periodEnd: NOW - 2 * DAY }, /periodStart/],
  ];
  for (const [name, over, re] of bad) { const c = checkRecord(good(over), NOW); assert.equal(c.ok, false, name); assert.match((c as { errors: string[] }).errors.join("|"), re, name); }
  assert.equal(checkRecord(null, NOW).ok, false); assert.equal(checkRecord("x", NOW).ok, false);
});

test("assessment: only a positive estimate with a 95% interval above zero is validated; the rest is unproven or negative", () => {
  assert.equal(assess(rec(), NOW).status, "validated");
  assert.equal(assess(rec({ ciLow95: undefined, ciHigh95: undefined }), NOW).status, "unproven");           // positive, no interval
  const strad = assess(rec({ ciLow95: -0.1 }), NOW); assert.equal(strad.status, "unproven"); assert.match(strad.reason, /includes zero/);
  assert.equal(assess(rec({ expectancyR: -0.2, ciLow95: -0.5, ciHigh95: 0.1 }), NOW).status, "negative");
  assert.equal(assess(rec({ expectancyR: 0, ciLow95: -0.3, ciHigh95: 0.3 }), NOW).status, "negative");
  const stale = assess(rec(), NOW + 29 * DAY); assert.equal(stale.status, "unproven"); assert.match(stale.reason, /stale/);
  assert.equal(assess(rec({ expectancyR: -0.2, ciLow95: -0.5, ciHigh95: 0.1 }), NOW + 40 * DAY).status, "unproven", "a stale NEGATIVE also expires: old evidence never persists indefinitely");
});

test("lookup: symbol-specific beats strategy-wide, the most conservative source wins, negative overrides, nothing means unproven", () => {
  const s = (rs: ExpectancyRecord[]) => ({ v: 1 as const, records: Object.fromEntries(rs.map(r => [`${r.source}:${r.symbol}`, r])) });
  assert.equal(lookupFrom(s([]), "BTCUSDT", NOW).status, "unproven");
  const wide = rec({ symbol: "*", expectancyR: 0.3, ciLow95: 0.05 }), specific = rec({ expectancyR: 0.6, ciLow95: 0.2 });
  assert.equal(lookupFrom(s([wide, specific]), "BTCUSDT", NOW).expectancyR, 0.6);
  assert.equal(lookupFrom(s([wide, specific]), "ETHUSDT", NOW).expectancyR, 0.3);
  const paper = rec({ source: "paper", expectancyR: 0.25, ciLow95: 0.02, samples: 38 });
  const both = lookupFrom(s([specific, paper]), "BTCUSDT", NOW); assert.equal(both.status, "validated"); assert.equal(both.expectancyR, 0.25); assert.equal(both.samples, 38);
  const neg = rec({ source: "paper", expectancyR: -0.1, ciLow95: -0.4, ciHigh95: 0.2 });
  const mixed = lookupFrom(s([specific, neg]), "BTCUSDT", NOW); assert.equal(mixed.status, "negative"); assert.equal(mixed.expectancyR, -0.1);
  const onlyUnproven = lookupFrom(s([rec({ ciLow95: -0.1 })]), "BTCUSDT", NOW); assert.equal(onlyUnproven.status, "unproven"); assert.equal(onlyUnproven.expectancyR, null);
  assert.deepEqual(expectancyOptions(onlyUnproven), {}); assert.deepEqual(expectancyOptions(both), { expectancyR: 0.25, expectancySamples: 38 });
});

test("recordFromReplay: out-of-sample expectancy caps the claim; no validated expectancy means no record", () => {
  const base = { symbol: "BTCUSDT", strategy: "swing" as const, periodStart: NOW - 90 * DAY, periodEnd: NOW - DAY, expectancyForValidator: { expectancyR: 0.5, samples: 60 }, bootstrapExpectancyR: { low95: 0.2, high95: 0.8 } };
  assert.equal(recordFromReplay({ ...base, expectancyForValidator: null }), null);
  const plain = checkRecord(recordFromReplay(base), NOW); assert.ok(plain.ok); assert.equal((plain as any).record.expectancyR, 0.5); assert.equal((plain as any).record.ciLow95, 0.2);
  const capped = checkRecord(recordFromReplay({ ...base, outOfSample: { expectancyR: 0.1 } }), NOW); assert.ok(capped.ok);
  assert.equal((capped as any).record.expectancyR, 0.1); assert.ok((capped as any).record.ciLow95 <= 0.1); assert.match((capped as any).record.note, /out-of-sample/);
  const oosNeg = checkRecord(recordFromReplay({ ...base, outOfSample: { expectancyR: -0.2 } }), NOW); assert.ok(oosNeg.ok); assert.equal(assess((oosNeg as any).record, NOW).status, "negative");
});

const trade = (i: number, r: number): ClosedTrade => ({ id: `t${i}`, engine: "combined", symbol: "BTCUSDT", openedAt: NOW - (60 - i) * DAY / 2, closedAt: NOW - (59 - i) * DAY / 2, pnl: r * 100, riskAmount: 100, fees: 0, slippage: 0 });
test("recordFromTrades: below the minimum sample there is no record; with enough trades a bootstrap interval decides whether it can be validated", () => {
  const o = { strategy: "intraday" as const, symbol: "BTCUSDT", source: "paper" as const };
  assert.equal(recordFromTrades(Array.from({ length: 29 }, (_, i) => trade(i, 1)), o), null);
  const strong = checkRecord(recordFromTrades(Array.from({ length: 40 }, (_, i) => trade(i, i % 4 === 0 ? -1 : 1.5)), o), NOW); assert.ok(strong.ok);
  assert.equal(assess((strong as any).record, NOW).status, "validated");
  const noisy = checkRecord(recordFromTrades(Array.from({ length: 40 }, (_, i) => trade(i, i % 2 === 0 ? 2.1 : -2)), o), NOW); assert.ok(noisy.ok);
  assert.equal(assess((noisy as any).record, NOW).status, "unproven", "a small positive mean buried in noise must not be called validated");
});

test("store: save/read round-trip through KV, corrupt data and KV failures degrade to unproven instead of throwing", async () => {
  const kv = new MemoryKV(); await saveRecord(kv, rec()); kv.gets = 0;
  const l = await expectancyFor({ ETI_EXECUTION_LOG: kv }, "intraday", "btcusdt", NOW); assert.equal(l.status, "validated"); assert.equal(l.expectancyR, 0.4);
  assert.equal((await expectancyFor({ ETI_EXECUTION_LOG: kv }, "swing", "BTCUSDT", NOW)).status, "unproven", "other strategies are unaffected");
  assert.equal(kv.gets, 2, "one KV read per lookup");
  const none = await expectancyFor({}, "intraday", "BTCUSDT", NOW); assert.equal(none.status, "unproven"); assert.match(none.reasons[0], /not configured/);
  await kv.put("algo:expectancy:v1:scalp", "{not json"); assert.equal((await expectancyFor({ ETI_EXECUTION_LOG: kv }, "scalp", "BTCUSDT", NOW)).status, "unproven");
  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => {} }; const b = await expectancyFor({ ETI_EXECUTION_LOG: broken }, "intraday", "BTCUSDT", NOW); assert.equal(b.status, "unproven"); assert.match(b.reasons[0], /unavailable/);
  assert.deepEqual((await readStore(kv, "position")).records, {});
  assert.ok(MAX_AGE_MS === 30 * DAY);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { MemoryKV } from "./kv.ts";
import { entryFromResult, evaluateOutcome, getEntry, journalFromRoute, keyFromId, keyOf, listEntries, recordEntry, statsFor, updateResolution, type JournalEntry } from "./journal.ts";

const T0 = 1_800_000_000_000, M = 60_000;
/** Minimal OmnisignalResult for entry construction. */
const result = (over: Record<string, unknown> = {}): any => ({ symbol: "BTCUSDT", strategy: "intraday", decision: "BUY", confidence: 71, generatedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 8 * M).toISOString(),
  entryZone: [99.75, 100], stopLoss: 99, takeProfits: [{ label: "TP1", price: 101.2, rewardRisk: 1.2 }, { label: "TP2", price: 102.2, rewardRisk: 2.2 }, { label: "TP3", price: 103.5, rewardRisk: 3.5 }], riskRewardToTP3: 3.5,
  validation: { classification: "CONFIRMED", score: 72.34, hardFailures: [] }, reasons: ["r1"], timeframes: { "15m": { price: 100 } }, fusion: { agreement: "BOTH_BULLISH", swift: { status: "SIGNAL", regime: "strong_bullish_trend" }, gainz: { status: "SIGNAL" } }, ...over });
const entry = (o: Partial<JournalEntry> = {}): JournalEntry => ({ ...entryFromResult(result(), "intraday", T0 + 5 * M), ...o });
const bars = (m: Record<number, [number, number, number, number]>, n = 30): Kline[] => Array.from({ length: n }, (_, i) => { const b = m[i]; return [T0 + i * M, b ? b[0] : 100.6, b ? b[1] : 100.8, b ? b[2] : 100.4, b ? b[3] : 100.6, 1] as Kline; });   // filler: above the zone, below TP1, nowhere near the stop
const NOW = T0 + 10 * 86_400_000;
const e1 = (o: Partial<JournalEntry> = {}) => entry({ ts: T0, expiresAt: new Date(T0 + 8 * M).toISOString(), ...o });

test("entries: BUY keeps the plan, HOLD/REJECTED keep reasons but no plan; one entry per symbol, strategy and execution candle", () => {
  const b = entryFromResult(result(), "intraday", T0 + 5 * M); assert.equal(b.direction, "LONG"); assert.deepEqual(b.takeProfits, [101.2, 102.2, 103.5]); assert.equal(b.classification, "CONFIRMED"); assert.equal(b.regime, "strong_bullish_trend"); assert.equal(b.resolution.status, "pending"); assert.equal(b.validationScore, 72.3);
  const h = entryFromResult(result({ decision: "REJECTED", validation: { classification: "REJECTED", score: 40, hardFailures: ["Liquidity: stale"] } }), "intraday", T0); assert.equal(h.direction, null); assert.equal(h.stopLoss, null); assert.equal(h.resolution.status, "not_applicable"); assert.deepEqual(h.hardFailures, ["Liquidity: stale"]);
  const ms = 15 * 60_000; assert.equal(entryFromResult(result(), "intraday", T0 + 1).bucket, entryFromResult(result(), "intraday", T0 + ms - 1).bucket); assert.notEqual(entryFromResult(result(), "intraday", T0).bucket, entryFromResult(result(), "intraday", T0 + ms).bucket);
});

test("storage: first look in a candle is kept, duplicates are skipped, summary rides in metadata and a TTL is set", async () => {
  const kv = new MemoryKV(), e = entry();
  assert.equal(await recordEntry(kv, e), "recorded"); assert.equal(await recordEntry(kv, { ...e, confidence: 99 }), "duplicate");
  assert.equal(kv.puts, 1); const stored = [...kv.data.values()][0]; assert.equal((stored.m as any).d, "BUY"); assert.equal(stored.ttl, 90 * 86_400);
  assert.equal((await getEntry(kv, e.id))!.confidence, 71);
  assert.equal(await getEntry(kv, "not-an-id"), null); assert.equal(keyFromId("BTCUSDT:intraday:1800000000000"), keyOf(1_800_000_000_000, "BTCUSDT", "intraday")); assert.equal(keyFromId("../../etc:intraday:1"), null); assert.equal(keyFromId("BTCUSDT:yolo:1800000000000"), null);
});

test("listing is newest-first from metadata alone (no per-entry reads), with filters, limit and cursor", async () => {
  const kv = new MemoryKV(), ms = 15 * 60_000;
  for (let i = 0; i < 6; i++) await recordEntry(kv, entryFromResult(result({ symbol: i % 2 ? "ETHUSDT" : "BTCUSDT", decision: i === 5 ? "REJECTED" : "BUY" }), "intraday", T0 + i * ms));
  kv.gets = 0; const all = (await listEntries(kv, {}))!;
  assert.equal(kv.gets, 0, "listing must not read entries one by one"); assert.deepEqual(all.entries.map(e => e.ts).sort((a, b) => b - a), all.entries.map(e => e.ts)); assert.equal(all.entries.length, 6);
  assert.equal(all.entries[0].decision, "REJECTED");
  assert.equal((await listEntries(kv, { symbol: "ETHUSDT" }))!.entries.length, 3); assert.equal((await listEntries(kv, { decision: "REJECTED" }))!.entries.length, 1); assert.equal((await listEntries(kv, { outcome: "pending" }))!.entries.length, 5);
  assert.equal((await listEntries(kv, { limit: 2 }))!.entries.length, 2); assert.equal(await listEntries({ get: async () => null, put: async () => {} }, {}), null);
});

test("route recording is opt-in, never throws, and reports why it did or did not record", async () => {
  const kv = new MemoryKV(), r = result();
  assert.equal(await journalFromRoute({ ETI_EXECUTION_LOG: kv }, r, "intraday", T0), "disabled"); assert.equal(kv.puts, 0);
  assert.equal(await journalFromRoute({ ETI_JOURNAL_ENABLED: "true" }, r, "intraday", T0), "not_configured");
  const on = { ETI_JOURNAL_ENABLED: "true", ETI_EXECUTION_LOG: kv };
  assert.equal(await journalFromRoute(on, r, "intraday", T0), "recorded"); assert.equal(await journalFromRoute(on, r, "intraday", T0 + 1000), "duplicate");
  assert.equal(await journalFromRoute({ ETI_JOURNAL_ENABLED: "true", ETI_EXECUTION_LOG: { get: async () => null, put: async () => { throw new Error("quota"); } } }, r, "intraday", T0), "error");
});

test("outcome: fill then TP1, TP2, TP3 is a win with exact R (partials 40/30/30)", () => {
  const r = evaluateOutcome(e1(), bars({ 1: [100, 101.3, 99.5, 101], 2: [101, 102.3, 100.5, 102], 3: [102, 103.6, 101.5, 103.5] }), M, NOW);
  assert.equal(r.status, "win"); assert.equal(r.filled, true); assert.equal(r.targetsHit, 3); assert.ok(Math.abs(r.r! - 2.19) < 1e-6);
});
test("outcome: TP1 then break-even stop is a small win; stop first is a loss of exactly 1R", () => {
  const be = evaluateOutcome(e1(), bars({ 1: [100, 101.3, 99.5, 101], 2: [100.5, 100.8, 99.9, 100.2] }), M, NOW); assert.equal(be.status, "win"); assert.ok(Math.abs(be.r! - 0.48) < 1e-6);
  const loss = evaluateOutcome(e1(), bars({ 1: [100, 100.4, 98.9, 99.2] }), M, NOW); assert.equal(loss.status, "loss"); assert.ok(Math.abs(loss.r! - -1) < 1e-6);
  const both = evaluateOutcome(e1(), bars({ 1: [100, 105, 98.9, 104] }), M, NOW); assert.equal(both.status, "loss", "a bar touching the stop and all targets is a stop, never a win");
});
test("outcome: short signals mirror long ones", () => {
  const s = e1({ direction: "SHORT", entryZone: [100, 100.25], stopLoss: 101, takeProfits: [98.8, 97.8, 96.5] });
  const win = evaluateOutcome(s, bars({ 1: [100, 100.2, 98.7, 99], 2: [99, 99.2, 97.7, 98], 3: [98, 98.2, 96.4, 96.5] }), M, NOW); assert.equal(win.status, "win"); assert.ok(Math.abs(win.r! - 2.19) < 1e-6);
  assert.equal(evaluateOutcome(s, bars({ 1: [100, 101.2, 99.8, 101] }), M, NOW).status, "loss");
});
test("outcome: never filled is classified by what price did instead (expired, invalidated, missed move)", () => {
  assert.equal(evaluateOutcome(e1(), bars({}), M, NOW).status, "no_fill_expired");
  assert.equal(evaluateOutcome(e1(), bars({ 0: [98.8, 98.9, 98.4, 98.6] }), M, NOW).status, "no_fill_invalidated");
  const missed = evaluateOutcome(e1(), bars({ 0: [101, 101.4, 100.6, 101.3] }), M, NOW); assert.equal(missed.status, "no_fill_missed_move"); assert.equal(missed.filled, false);
  assert.equal(evaluateOutcome(e1(), bars({}), M, T0 + 3 * M).status, "pending", "not expired yet and nothing decisive has happened");
});
test("outcome: honest about what it cannot know (history gap, bad plan, open position, bars still forming, nothing to evaluate)", () => {
  const late = bars({}).map(b => [b[0] + 10 * M, b[1], b[2], b[3], b[4], b[5]] as Kline); assert.equal(evaluateOutcome(e1(), late, M, NOW).status, "unresolvable");
  assert.equal(evaluateOutcome(e1({ stopLoss: 101 }), bars({}), M, NOW).status, "unresolvable");
  assert.equal(evaluateOutcome(e1(), bars({ 1: [100, 100.4, 99.6, 100.2] }, 12), M, T0 + 12 * M).status, "pending", "filled but the position is still open and the data ends");
  assert.equal(evaluateOutcome(e1(), bars({ 1: [100, 101.3, 99.5, 101] }, 3), M, T0 + 2 * M).status, "pending", "bars that have not closed yet are ignored");
  assert.equal(evaluateOutcome(entryFromResult(result({ decision: "HOLD" }), "intraday", T0), [], M, NOW).status, "not_applicable");
  assert.equal(evaluateOutcome(e1(), [], M, T0 + 2 * M).status, "pending");
});
test("outcome: the same bars through the shared walk give the same R as the backtest/paper rules (identical break-even and trailing)", () => {
  // TP1, TP2 then a trailing exit: 0.48 + 0.66 + 0.3 * (100.6 - 100) = 1.32
  const r = evaluateOutcome(e1(), bars({ 1: [100, 101.3, 99.5, 101], 2: [101, 102.3, 100.5, 102], 3: [101.5, 101.8, 100.5, 100.7] }), M, NOW); assert.equal(r.status, "win"); assert.ok(Math.abs(r.r! - 1.32) < 1e-6, String(r.r));
});

test("stats: counts by decision/class/outcome; rates withheld below the minimum sample, shown (with false-positive rate) above it", async () => {
  const kv = new MemoryKV(), ms = 15 * 60_000;
  for (let i = 0; i < 4; i++) { const e = entryFromResult(result({ decision: i < 3 ? "BUY" : "HOLD", validation: { classification: i < 3 ? "CONFIRMED" : "HOLD", score: 60, hardFailures: [] } }), "intraday", T0 + i * ms); await recordEntry(kv, e); if (i === 0) await updateResolution(kv, e, { status: "win", filled: true, r: 1.5 }); if (i === 1) await updateResolution(kv, e, { status: "no_fill_missed_move", filled: false }); }
  const s = (await statsFor(kv))!; assert.equal(s.byDecision.BUY, 3); assert.equal(s.byDecision.HOLD, 1); assert.equal(s.actionable.total, 3); assert.equal(s.actionable.resolved, 2); assert.equal(s.actionable.wins, 1); assert.equal(s.actionable.missedMoves, 1);
  assert.equal(s.rates.status, "insufficient_sample"); assert.equal(s.rates.winRateOfFilled, null); assert.match(s.note, /Hypothetical/);
  const big = new MemoryKV();
  for (let i = 0; i < 40; i++) { const e = entryFromResult(result(), "intraday", T0 + i * ms); await recordEntry(big, e); await updateResolution(big, e, i % 4 === 0 ? { status: "loss", filled: true, r: -1 } : i % 10 === 1 ? { status: "no_fill_expired", filled: false } : { status: "win", filled: true, r: 1 }); }
  const b = (await statsFor(big))!; assert.equal(b.rates.status, "ok"); assert.equal(b.actionable.resolved, 40); assert.equal(b.actionable.filled, 36); assert.ok(Math.abs(b.rates.winRateOfFilled! - b.actionable.wins / 36) < 1e-9); assert.ok(Math.abs(b.rates.falsePositiveRate! - 10 / 36) < 1e-9);
  assert.equal(b.byClassificationOutcome.CONFIRMED.filled, 36);
  assert.equal((await statsFor(big, T0 + 100 * ms))!.scanned, 0, "the since-window excludes older entries");
});

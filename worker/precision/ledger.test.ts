import test from "node:test";
import assert from "node:assert/strict";
import type { Kline } from "../market.ts";
import { resolveConfig } from "./config.ts";
import { runPrecisionEngine } from "./engine.ts";
import { MAX_HOLD_BARS, entryFromSignal, expectancyOf, parseEntries, parseOutcomes, resolveEntry, type LedgerEntry } from "./ledger.ts";
import { NOW, inputFor } from "./testkit.ts";

const BAR = 15 * 60_000, T = NOW; // T is aligned to 15m
const bar = (i: number, o: number, h: number, l: number, c: number): Kline => [T + i * BAR, o, h, l, c, 100];
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "e1", symbol: "BTCUSDT", strategy: "intraday", timeframe: "15m", dir: 1, entry: 100, stop: 98, targets: [102, 104, 106], costInR: 0.05, score: 80,
  configHash: "h", engineVersion: "1.0.0", createdAt: T, expiresAt: T + 8 * BAR, ...over,
});
const after = (bars: number) => T + bars * BAR; // a clock time with `bars` bars closed

test("a filled long that hits the stop is a loss of one R plus costs", () => {
  const rows = [bar(0, 100.5, 101, 99.5, 100), bar(1, 99, 99.5, 97, 98)];
  const r = resolveEntry(entry(), rows, after(2));
  assert.equal(r.state, "done");
  if (r.state !== "done") return;
  assert.equal(r.outcome.status, "resolved");
  assert.equal(r.outcome.netR, -1.05);
  assert.equal(r.outcome.win, false);
  assert.match(r.outcome.reason, /stop/);
});

test("a filled long that reaches TP3 realises 40/30/30 partials, net of costs", () => {
  const rows = [bar(0, 100.5, 101, 99.5, 100), bar(1, 101, 106.5, 100.5, 106)];
  const r = resolveEntry(entry(), rows, after(2));
  assert.equal(r.state, "done");
  if (r.state !== "done") return;
  assert.equal(r.outcome.netR, 1.85); // 0.4*1 + 0.3*2 + 0.3*3 = 1.9, minus 0.05
  assert.equal(r.outcome.win, true);
});

test("stop is tested first: a bar that spans both stop and target is a loss", () => {
  const rows = [bar(0, 100.5, 101, 99.5, 100), bar(1, 100, 107, 97, 105)];
  const r = resolveEntry(entry(), rows, after(2));
  assert.ok(r.state === "done" && r.outcome.win === false);
});

test("the fill bar itself is never processed: nothing resolves until a later closed bar exists", () => {
  const onlyFill = [bar(0, 100, 107, 96, 100)]; // would hit both stop and targets if processed
  assert.equal(resolveEntry(entry(), onlyFill, after(1)).state, "open");
});

test("a candle that has not closed yet is ignored", () => {
  const rows = [bar(0, 100.5, 101, 99.5, 100), bar(1, 99, 99.5, 97, 98)];
  assert.equal(resolveEntry(entry(), rows, T + BAR + 60_000).state, "open", "bar 1 is still forming, so the stop cannot have been hit yet");
});

test("a signal price never touched before expiry is not_filled, and stays open until expiry has been observed", () => {
  const above = (i: number) => bar(i, 105, 106, 104, 105);
  const early = resolveEntry(entry(), [above(0), above(1)], after(2));
  assert.equal(early.state, "open");
  const late = resolveEntry(entry(), Array.from({ length: 10 }, (_, i) => above(i)), after(10));
  assert.ok(late.state === "done" && late.outcome.status === "not_filled" && late.outcome.win === null && late.outcome.netR === null);
});

test("a short mirrors the long", () => {
  const e = entry({ dir: -1, entry: 100, stop: 102, targets: [98, 96, 94] });
  const win = resolveEntry(e, [bar(0, 99.5, 100.5, 99, 100), bar(1, 99, 99.5, 93.5, 94)], after(2));
  assert.ok(win.state === "done" && win.outcome.win === true && win.outcome.netR === 1.85);
  const loss = resolveEntry(e, [bar(0, 99.5, 100.5, 99, 100), bar(1, 101, 103, 100, 102)], after(2));
  assert.ok(loss.state === "done" && loss.outcome.win === false);
});

test("a position still open after the time limit is closed at the market and scored, not left open forever", () => {
  const flat = Array.from({ length: MAX_HOLD_BARS + 5 }, (_, i) => (i === 0 ? bar(0, 100.5, 101, 99.5, 100) : bar(i, 100.5, 101, 100.2, 100.5)));
  const r = resolveEntry(entry({ expiresAt: T + 80 * BAR }), flat, after(flat.length));
  assert.ok(r.state === "done" && r.outcome.status === "resolved" && /time/.test(r.outcome.reason));
  if (r.state === "done") assert.equal(r.outcome.netR, 0.2); // 0.5 above a 2.0 stop distance = 0.25R, minus 0.05
  const young = resolveEntry(entry({ expiresAt: T + 80 * BAR }), flat.slice(0, 12), after(12));
  assert.equal(young.state, "open");
});

test("history that no longer reaches the signal time is void, never guessed", () => {
  const r = resolveEntry(entry(), [bar(40, 100, 101, 99, 100), bar(41, 100, 101, 99, 100)], after(50));
  assert.ok(r.state === "done" && r.outcome.status === "void");
});

test("without a justified TP3 the last 30% is not closed at a made-up target", () => {
  const e = entry({ targets: [102, 104, null] });
  const rows = [bar(0, 100.5, 101, 99.5, 100), bar(1, 101, 110, 100.5, 109)];
  const r = resolveEntry(e, rows, after(2));
  assert.equal(r.state, "open", "TP1 and TP2 hit, but the runner is still being managed");
});

test("expectancy needs the minimum sample and gives an honest interval", () => {
  assert.equal(expectancyOf(Array(29).fill(1), 30), null);
  const all = expectancyOf(Array(60).fill(1), 30)!;
  assert.equal(all.meanR, 1); assert.equal(all.low95, 1);
  const mixed = expectancyOf(Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.1 : -1)), 30)!;
  assert.ok(mixed.low95 < mixed.meanR && mixed.meanR < mixed.high95);
  assert.deepEqual(expectancyOf(Array.from({ length: 100 }, (_, i) => (i % 3) - 1), 30, 5), expectancyOf(Array.from({ length: 100 }, (_, i) => (i % 3) - 1), 30, 5), "seeded, so reproducible");
});

test("only a complete tradeable plan becomes a ledger entry", () => {
  const buy = runPrecisionEngine(inputFor("buy"));
  const e = entryFromSignal(buy)!;
  assert.equal(e.id, buy.signalId); assert.equal(e.dir, 1); assert.equal(e.entry, buy.entry); assert.equal(e.stop, buy.stopLoss);
  assert.equal(e.score, buy.opportunityScore.value); assert.equal(e.configHash, buy.opportunityScore.configHash);
  assert.equal(e.expiresAt, Date.parse(buy.expiresAt!)); assert.equal(e.costInR, buy.transactionCosts!.costInR);
  assert.equal(entryFromSignal(runPrecisionEngine(inputFor("thinReward"))), null);
  assert.equal(entryFromSignal(runPrecisionEngine(inputFor("sell")))!.dir, -1);
  const noTp3 = runPrecisionEngine({ ...inputFor("buy"), config: resolveConfig({ tp3MinRewardRisk: 9 }).config });
  assert.equal(entryFromSignal(noTp3)!.targets[2], null);
});

test("stored ledger data is parsed strictly", () => {
  assert.deepEqual(parseEntries("x"), []);
  assert.equal(parseEntries([entry(), { id: "bad" }, { ...entry(), dir: 2 }, { ...entry(), timeframe: "2m" }]).length, 1);
  assert.equal(parseOutcomes([{ id: "o", strategy: "intraday", score: 80, configHash: "h", createdAt: 1, closedAt: 2, status: "resolved", netR: 1, win: true, symbol: "X", reason: "" }, { id: "o2" }]).length, 1);
});

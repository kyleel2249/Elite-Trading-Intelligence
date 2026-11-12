import test from "node:test";
import assert from "node:assert/strict";
import { buildUniverse, DEFAULTS, leaderboardOf, loadUniverse, nextBatch, parseTickers, runUniverseBatch, type Ticker, type UniverseState } from "./algo/universe.ts";
import type { ScanRow } from "./algo/scan.ts";

const T = (symbol: string, o: Partial<Ticker> = {}): Ticker => ({ symbol, lastPrice: 100, quoteVolume: 50e6, trades: 100000, bid: 99.99, ask: 100.01, changePct: 1, ...o });
const kvOf = () => { const m = new Map<string, string>(); return { m, kv: { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } } }; };
const row = (symbol: string, decision: any = "HOLD", extra: Partial<ScanRow> = {}): ScanRow => ({ rank: null, symbol, decision, direction: null, opportunityScore: null, validationScore: null, confidence: 0, riskRewardToTP3: null, agreement: null, liquidity: null, entryZone: null, stopLoss: null, reason: "", ...extra });

test("universe: filters by quote, stablecoins, leveraged tokens, volume, trades, spread; counts reasons", () => {
  const u = buildUniverse([T("BTCUSDT"), T("ETHUSDT", { quoteVolume: 40e6 }), T("ETHBTC"), T("USDCUSDT"), T("BTCUPUSDT"), T("LOWUSDT", { quoteVolume: 1000 }), T("FEWUSDT", { trades: 3 }), T("WIDEUSDT", { bid: 90, ask: 100 }), T("NOQUSDT", { bid: 0 })]);
  assert.deepEqual(u.symbols.map(s => s.symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(u.rejected.other_quote, 1); assert.equal(u.rejected.stable_or_leveraged, 2); assert.equal(u.rejected.low_volume, 1); assert.equal(u.rejected.few_trades, 1); assert.equal(u.rejected.wide_spread, 1); assert.equal(u.rejected.no_valid_quote, 1);
});
test("universe: cap is applied by volume and reported", () => {
  const ts = Array.from({ length: 12 }, (_, i) => T(`A${i}USDT`, { quoteVolume: 10e6 + i * 1e6 })), u = buildUniverse(ts, { ...DEFAULTS, maxSymbols: 5 });
  assert.equal(u.symbols.length, 5); assert.equal(u.symbols[0].symbol, "A11USDT"); assert.equal(u.rejected.beyond_cap, 7);
});
test("universe: malformed ticker payloads are rejected, not guessed", () => { assert.throws(() => parseTickers({ nope: 1 })); assert.throws(() => parseTickers([])); });
test("nextBatch: never-analysed first, then movers, then the stalest", () => {
  const now = 10 * 3600_000, s: any = { symbols: [{ symbol: "A", quoteVolume: 1, changePct: 0 }, { symbol: "B", quoteVolume: 1, changePct: 0 }, { symbol: "C", quoteVolume: 1, changePct: 9 }, { symbol: "D", quoteVolume: 1, changePct: 0 }], rows: { A: { analysedAt: now - 100 }, B: { analysedAt: now - 5 * 3600_000 }, C: { analysedAt: now - 2 * 3600_000 } } };
  assert.deepEqual(nextBatch(s, now, 3), ["D", "C", "B"]);
});
test("leaderboard: stale rows are excluded from the ranking and reported in coverage", () => {
  const now = 100 * 3600_000, st: UniverseState = { version: 1, strategy: "intraday", builtAt: now, config: { ...DEFAULTS }, rejected: {}, symbols: ["A", "B", "C", "D"].map(s => ({ symbol: s, quoteVolume: 1, changePct: 0 })),
    rows: { A: { ...row("A", "BUY", { opportunityScore: 80, direction: "LONG" }), analysedAt: now - 1000 }, B: { ...row("B", "BUY", { opportunityScore: 90, direction: "LONG" }), analysedAt: now - 20 * 3600_000 }, C: { ...row("C", "DATA_UNRELIABLE"), analysedAt: now - 1000 } } };
  const r = leaderboardOf(st, now); assert.deepEqual(r.leaderboard.map(x => x.symbol), ["A"]); assert.equal(r.leaderboard[0].rank, 1);
  assert.equal(r.coverage.fresh, 2); assert.equal(r.coverage.stale, 1); assert.equal(r.coverage.neverAnalysed, 1); assert.equal(r.coverage.errors, 1);
  assert.equal(leaderboardOf(null, now).coverage.universeSize, 0);
});
test("batch: builds the universe, analyses a bounded batch, isolates a failing symbol, persists, and rotates", async () => {
  const { kv } = kvOf(), tickers = Array.from({ length: 12 }, (_, i) => ({ symbol: `C${i}USDT`, lastPrice: "10", quoteVolume: String(90e6 - i * 1e6), count: 9000, bidPrice: "9.999", askPrice: "10.001", priceChangePercent: "1" }));
  const fetchImpl = (async () => new Response(JSON.stringify(tickers), { status: 200 })) as typeof fetch, calls: string[] = [];
  const analyse = (async (_e: any, syms: string[]) => { calls.push(syms[0]); if (syms[0] === "C1USDT") throw new Error("boom"); return [row(syms[0], "HOLD")]; }) as any;
  const r1 = await runUniverseBatch({ ETI_UNIVERSE_BATCH: "4" } as any, kv, 1000, "intraday", { fetchImpl, analyse });
  assert.equal(r1.refreshedUniverse, true); assert.equal(calls.length, 4); assert.deepEqual(r1.errors, ["C1USDT"]); assert.equal(r1.coverage.universeSize, 12);
  const r2 = await runUniverseBatch({ ETI_UNIVERSE_BATCH: "4" } as any, kv, 2000, "intraday", { fetchImpl, analyse });
  assert.equal(r2.refreshedUniverse, false); assert.equal(new Set(calls).size, 8, "second pass must cover different symbols");
  const s = await loadUniverse(kv); assert.equal(Object.keys(s!.rows).length, 8);
});
test("batch: ticker outage keeps the previous universe and reports the error; with none it fails safely", async () => {
  const { kv } = kvOf(), down = (async () => new Response("no", { status: 403 })) as typeof fetch;
  const none = await runUniverseBatch({} as any, kv, 1, "intraday", { fetchImpl: down }); assert.match(none.universeError!, /ticker_unavailable/); assert.equal(none.analysed.length, 0);
  const good = Array.from({ length: 12 }, (_, i) => ({ symbol: `D${i}USDT`, lastPrice: "10", quoteVolume: "90000000", count: 9000, bidPrice: "9.999", askPrice: "10.001", priceChangePercent: "1" }));
  const analyse = (async (_e: any, s: string[]) => [row(s[0])]) as any;
  await runUniverseBatch({} as any, kv, 1, "intraday", { fetchImpl: (async () => new Response(JSON.stringify(good))) as typeof fetch, analyse });
  const again = await runUniverseBatch({} as any, kv, 1 + 7 * 3600_000, "intraday", { fetchImpl: down, analyse }); assert.match(again.universeError!, /ticker_unavailable/); assert.equal(again.analysed.length, 3);
});

import { handleOmnisignal } from "./algo/omni-api.ts";
test("API: universe GET is read-only and says so when nothing has run; refresh needs the execution token", async () => {
  const { kv } = kvOf(), env: any = { ETI_EXECUTION_LOG: kv, ETI_EXECUTION_TOKEN: "t".repeat(32) };
  const g = await handleOmnisignal(new Request("https://x/api/omnisignal/universe"), env), gb: any = await g.json();
  assert.equal(g.status, 200); assert.equal(gb.coverage.universeSize, 0); assert.equal(gb.submitsOrder, false); assert.match(gb.note, /No universe scan/);
  assert.equal((await handleOmnisignal(new Request("https://x/api/omnisignal/universe/refresh", { method: "POST" }), env)).status, 401);
  assert.equal((await handleOmnisignal(new Request("https://x/api/omnisignal/universe/refresh"), env)).status, 405);
  assert.equal((await handleOmnisignal(new Request("https://x/api/omnisignal/universe", { method: "POST" }), env)).status, 405);
  assert.equal((await handleOmnisignal(new Request("https://x/api/omnisignal/universe"), { ...env, ETI_EXECUTION_LOG: undefined })).status, 503);
});

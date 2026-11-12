import test from "node:test";
import assert from "node:assert/strict";
import { AlphaStore, memoryKv } from "./store.ts";
import { monitorPosition, checkExposure, exposureOf, recordOutcome, DEFAULT_LIMITS, type PaperPosition } from "./positions.ts";
import { resolvePrediction, accuracyOf, falseNegativeRate, outcomeOfDiscovery, type Prediction } from "./ledger.ts";
import { coverage } from "./coverage.ts";
import { auditProfiles, FOUNDATIONAL_35 } from "./profiles.ts";
import { modelVersion, championChallenger } from "./monitor.ts";
import { parseAlpacaBars, parseScreener, fetchEquityBars, equityConfigured, watchlist } from "./equities.ts";
import { Budget } from "./budget.ts";
import { poolSummaries } from "./lab.ts";
import type { Kline } from "../market.ts";

const bar = (t: number, o: number, h: number, l: number, c: number): Kline => [t, o, h, l, c, 100];
const pos = (over: Partial<PaperPosition> = {}): PaperPosition => ({ id: "p1", symbol: "AAAUSDT", assetClass: "crypto", broker: "binance", mode: "testnet", qty: 1, entry: 100, stop: 95, targets: [105, 110, 120], openedAt: 1000, interval: "1h", strategyIds: ["s1"], classification: "CONFIRMED_OPPORTUNITY", clientOrderId: "c1", brokerOrderId: null, status: "open", tp1Touched: false, exitPrice: null, exitAt: null, exitReason: null, rMultiple: null, protection: "virtual_monitored", ...over });

test("store: KV round trip, namespaced prefix, memory fallback, capped push", async () => {
  const kv = memoryKv(), s = new AlphaStore({ ETI_ALPHA_KV: kv });
  await s.put("a", { x: 1 }); assert.deepEqual(await s.get("a", null), { x: 1 }); assert.ok([...kv.map.keys()].every(k => k.startsWith("alpha:")));
  for (let i = 0; i < 5; i++) await s.push("l", i, 3); assert.deepEqual(await s.get("l", []), [4, 3, 2]);
  const m = new AlphaStore({}, new Map()); assert.equal(m.mode, "memory_only"); await m.put("k", 1); assert.equal(await m.get("k", 0), 1);
  assert.match(String(new AlphaStore({ ETI_EXECUTION_LOG: kv }).binding), /^ETI_EXECUTION_LOG/);
  assert.equal(await s.get("missing", "fb"), "fb");
});

test("positions: stop-first on a same-bar conflict, TP2 exit, time exit, TP1 recorded", () => {
  const conflict = monitorPosition(pos(), [bar(2000, 100, 111, 94, 100)], 3000); assert.equal(conflict.exitReason, "stop"); assert.equal(conflict.rMultiple, -1);
  const win = monitorPosition(pos(), [bar(2000, 100, 106, 99, 105), bar(3000, 105, 111, 104, 110)], 4000); assert.equal(win.exitReason, "tp2"); assert.equal(win.tp1Touched, true); assert.equal(win.rMultiple, 2);
  const timed = monitorPosition(pos(), [bar(2000, 100, 101, 99, 100.5), bar(3000, 100, 101, 99, 100.5)], 4000, 2); assert.equal(timed.exitReason, "time");
  const still = monitorPosition(pos(), [bar(2000, 100, 101, 99, 100)], 4000); assert.equal(still.status, "open");
  assert.equal(monitorPosition(pos(), [bar(500, 1, 1000, 0.1, 5)], 4000).status, "open", "bars before open are ignored");
});

test("positions: exposure limits block over-sized, over-count and over-class additions", () => {
  const open = [pos(), pos({ id: "p2", symbol: "B" }), pos({ id: "p3", symbol: "C" })]; // 100 notional each
  assert.equal(exposureOf(open, 1000).positions, 3);
  assert.equal(checkExposure([], { symbol: "X", assetClass: "crypto", notional: 150 }, 1000).ok, true);
  assert.equal(checkExposure([], { symbol: "X", assetClass: "crypto", notional: 300 }, 1000).ok, false, "30% > 20% per position");
  assert.equal(checkExposure(open, { symbol: "X", assetClass: "crypto", notional: 150 }, 1000).ok, false, "class cap 40%");
  assert.equal(checkExposure([pos()], { symbol: "AAAUSDT", assetClass: "crypto", notional: 10 }, 1000).ok, false, "duplicate symbol");
  const many = Array.from({ length: DEFAULT_LIMITS.maxPositions }, (_, i) => pos({ id: "m" + i, symbol: "S" + i, assetClass: i % 2 ? "equity" : "crypto", qty: 0.1 }));
  assert.equal(checkExposure(many, { symbol: "Z", assetClass: "crypto", notional: 1 }, 100000).ok, false);
  assert.equal(checkExposure([], { symbol: "X", assetClass: "crypto", notional: 10 }, 0).ok, false, "unknown equity fails closed");
});

test("positions: outcomes feed strategy performance", () => {
  const closed = monitorPosition(pos(), [bar(2000, 100, 111, 99, 110)], 3000); const perf = recordOutcome({}, closed);
  assert.equal(perf.s1.n, 1); assert.equal(perf.s1.wins, 1); assert.equal(perf.s1.sumR, 2);
});

const pred = (over: Partial<Prediction> = {}): Prediction => ({ id: "x", symbol: "A", assetClass: "crypto", interval: "1h", createdAt: 1000, priceAtCall: 100, direction: "long", horizonBars: 3, horizonEndsAt: 1000 + 3 * 3600_000, targetPrice: 105, invalidationPrice: 95, classification: "CONFIRMED_OPPORTUNITY", stage: "breakout", confidence: { earlyScore: 70, overall: 70, evidenceCoverage: 0.6 }, reasons: [], status: "open", resolvedAt: null, resolvedPrice: null, returnPct: null, leadTimeBars: null, maxFavourablePct: 0, maxAdversePct: 0, ...over });

test("ledger: resolution is stop-first, uses only later candles, expires after horizon", () => {
  assert.equal(resolvePrediction(pred(), [bar(2000, 100, 106, 94, 100)], 1e9).status, "invalidated");
  assert.equal(resolvePrediction(pred(), [bar(2000, 100, 106, 99, 105)], 1e9).status, "hit");
  assert.equal(resolvePrediction(pred(), [bar(500, 100, 200, 1, 100)], 1500).status, "open", "pre-call bars ignored");
  const exp = resolvePrediction(pred(), [bar(2000, 100, 101, 99, 100), bar(3000, 100, 101, 99, 101), bar(4000, 100, 101, 99, 102)], 1e12); assert.equal(exp.status, "expired"); assert.equal(exp.returnPct, 2);
  const done = pred({ status: "hit" }); assert.equal(resolvePrediction(done, [bar(2000, 1, 1, 1, 1)], 1e9), done);
});

test("ledger: accuracy withholds rates on small samples and counts correctly", () => {
  assert.equal(accuracyOf([]).hitRate, null);
  const ps = [...Array(6)].map((_, i) => pred({ id: "h" + i, status: "hit", returnPct: 5, leadTimeBars: 2 })).concat([...Array(4)].map((_, i) => pred({ id: "i" + i, status: "invalidated", returnPct: -5 })));
  const a = accuracyOf(ps); assert.equal(a.total, 10); assert.equal(a.hits, 6); assert.equal(a.hitRate, 60); assert.equal(a.falsePositiveRate, 40);
  const small = accuracyOf([pred({ status: "hit", returnPct: 5 })]); assert.equal(small.hitRate, null);
  assert.equal(falseNegativeRate([]).rate, null);
  const o = outcomeOfDiscovery({ symbol: "A", classification: "WATCHLIST", price: 100, discoveredAt: 1000, horizonBars: 3, interval: "1h" }, [bar(2000, 100, 120, 99, 118)], 0.15, 0.08); assert.equal(o.outcome, "missed_move");
});

test("coverage: never claims global coverage and reflects configuration", () => {
  const bare = coverage({}, 1e12), full = coverage({ SEC_USER_AGENT: "ETI test@example.org", ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s", ETHERSCAN_API_KEY: "e" }, 1e12);
  assert.ok(!/global coverage achieved|full global/i.test(bare.claim)); assert.ok(bare.gaps.length > 3);
  const st = (c: typeof bare, id: string) => c.sources.find(s => s.id === id)!.status;
  assert.equal(st(bare, "alpaca_data"), "not_configured"); assert.equal(st(full, "alpaca_data"), "configured");
  assert.ok(bare.exchanges.some(e => e.status === "no_provider")); assert.ok(bare.exchanges.some(e => e.status === "covered"));
  assert.ok(bare.sources.every(s => s.id && s.name && s.notes));
});

test("profiles: honest audit of the 35 foundational traders", async () => {
  const k = (await import("../knowledge.generated.json", { with: { type: "json" } })).default as any;
  const a = auditProfiles(k.profiles); assert.equal(FOUNDATIONAL_35.length, 35); assert.equal(a.foundationalRequired, 35); assert.equal(a.foundationalPresent, 35);
  assert.equal(a.evidenced + a.partial + a.seedText, 35); assert.ok(a.note.length > 20);
  assert.ok(a.audits.filter(x => x.foundational).every(x => x.name && x.researchStatus));
});

test("monitor: model version is stable, champion needs real out-of-sample evidence and rolls back on paper losses", () => {
  assert.equal(modelVersion(), modelVersion()); assert.match(modelVersion(), /\w{6,}/);
  const none = championChallenger(poolSummaries([]), {}); assert.equal(none.champion, null); assert.ok(Array.isArray(none.rolledBack) && Array.isArray(none.challengers));
});

test("equities: parsing, fail-closed without keys, budget respected, feed header", async () => {
  assert.deepEqual(parseAlpacaBars({ bars: [{ t: "2024-01-02T05:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: "bad", o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: "2024-01-01T05:00:00Z", o: 1, h: 0.1, l: 0.5, c: 1, v: 1 }] }).length, 1);
  assert.deepEqual(parseScreener({ most_actives: [{ symbol: "aapl" }, { symbol: "BAD$" }], gainers: [{ symbol: "AAPL" }, { symbol: "NVDA" }] }), ["AAPL", "NVDA"]);
  assert.equal(equityConfigured({}), false);
  assert.deepEqual(await fetchEquityBars("AAPL", {}, new Budget(5)), { ok: false, reason: "alpaca_keys_not_configured" });
  const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" };
  assert.equal((await fetchEquityBars("not a symbol", env, new Budget(5))).ok, false);
  const empty = new Budget(1); empty.take(); assert.deepEqual(await fetchEquityBars("AAPL", env, empty), { ok: false, reason: "subrequest_budget_exhausted" });
  let seen: any = null; const r = await fetchEquityBars("AAPL", env, new Budget(5), async (u, i) => { seen = { u, i }; return new Response(JSON.stringify({ bars: Array.from({ length: 130 }, (_, i) => ({ t: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 })) })); });
  assert.equal(r.ok, true);
  const thin = await fetchEquityBars("AAPL", env, new Budget(5), async () => new Response(JSON.stringify({ bars: [{ t: "2024-01-02T05:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] })));
  assert.deepEqual(thin, { ok: false, reason: "insufficient_history_1" }); assert.match(seen.u, /feed=iex/); assert.equal((seen.i.headers as any)["APCA-API-KEY-ID"], "k");
  assert.equal((await fetchEquityBars("AAPL", env, new Budget(5), async () => new Response("no", { status: 429 }))).ok, false);
  assert.deepEqual(watchlist({ ALPHA_EQUITY_WATCHLIST: "aapl, msft ,bad!!" }), ["AAPL", "MSFT"]);
});

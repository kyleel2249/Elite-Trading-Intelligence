import test from "node:test";
import assert from "node:assert/strict";
import { handleAlgoRegistry } from "./registry-api.ts";
import { handleAlgoSignal } from "./api.ts";
import { handleOmnisignal } from "./omni-api.ts";
import { withAlgo } from "./route.ts";
import { MemoryKV } from "./kv.ts";
import { entryFromResult, recordEntry } from "./journal.ts";
import type { ClosedTrade } from "./performance.ts";

const TOKEN = "test-token-1234567890", DAY = 86_400_000, M = 60_000, realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const mkEnv = (extra: Record<string, unknown> = {}) => ({ ETI_EXECUTION_TOKEN: TOKEN, ETI_EXECUTION_LOG: new MemoryKV(), ...extra }) as any;
const call = (env: any, path: string, init: { method?: string; body?: unknown; auth?: boolean | string } = {}, now?: number) =>
  handleAlgoRegistry(new Request(`https://eti.test${path}`, { method: init.method ?? "GET", headers: { ...(init.auth === false ? {} : { authorization: `Bearer ${typeof init.auth === "string" ? init.auth : TOKEN}` }), "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env, now ? { now: () => now } : {});
const evidence = (o: Record<string, unknown> = {}) => ({ strategy: "intraday", symbol: "BTCUSDT", source: "replay", expectancyR: 0.4, samples: 45, ciLow95: 0.1, ciHigh95: 0.7, periodEnd: Date.now() - DAY, periodStart: Date.now() - 60 * DAY, ...o });

test("routing: unknown routes 404, wrong methods 405, and every write needs the bearer token", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "/api/algo/nope")).status, 404); assert.equal((await call(env, "/api/algo/expectancy", { method: "DELETE" })).status, 405); assert.equal((await call(env, "/api/algo/journal", { method: "POST" })).status, 405);
  for (const [p, body] of [["/api/algo/expectancy", evidence()], ["/api/algo/expectancy/refresh-paper", {}], ["/api/algo/journal/resolve", {}]] as const) {
    assert.equal((await call(env, p, { method: "POST", body, auth: false })).status, 401, p); assert.equal((await call(env, p, { method: "POST", body, auth: "wrong-token-123456789" })).status, 401, p);
  }
  assert.equal((await call({ ...env, ETI_EXECUTION_TOKEN: undefined }, "/api/algo/expectancy", { method: "POST", body: evidence() })).status, 401, "no token configured means no writes");
  assert.equal(env.ETI_EXECUTION_LOG.puts, 0, "an unauthorised request must never write");
});

test("without the KV binding: reads of expectancy still answer (unproven), everything stored says so with 503", async () => {
  const env = mkEnv({ ETI_EXECUTION_LOG: undefined });
  const g = await call(env, "/api/algo/expectancy?strategy=intraday&symbol=BTCUSDT"); assert.equal(g.status, 200); assert.equal(((await g.json()) as any).lookup.status, "unproven");
  for (const [p, m] of [["/api/algo/journal", "GET"], ["/api/algo/journal/stats", "GET"]] as const) assert.equal((await call(env, p, { method: m })).status, 503, p);
  assert.equal((await call(env, "/api/algo/expectancy", { method: "POST", body: evidence() })).status, 503);
});

test("expectancy: valid evidence is saved and immediately visible; evidence that could mislead is rejected with the rules", async () => {
  const env = mkEnv();
  const ok = await call(env, "/api/algo/expectancy", { method: "POST", body: evidence() }); assert.equal(ok.status, 200); const j = await ok.json() as any; assert.equal(j.lookup.status, "validated"); assert.equal(j.saved.source, "replay");
  const g = await (await call(env, "/api/algo/expectancy?strategy=intraday&symbol=btcusdt")).json() as any; assert.equal(g.lookup.expectancyR, 0.4); assert.match(g.rules, /replay of the real engine chain/);
  assert.equal(((await (await call(env, "/api/algo/expectancy?strategy=swing&symbol=BTCUSDT")).json()) as any).lookup.status, "unproven");
  for (const bad of [evidence({ source: "screen" }), evidence({ samples: 12 }), evidence({ expectancyR: "high" }), evidence({ periodEnd: Date.now() - 50 * DAY, periodStart: Date.now() - 99 * DAY })]) {
    const r = await call(env, "/api/algo/expectancy", { method: "POST", body: bad }); assert.equal(r.status, 422); assert.ok(((await r.json()) as any).errors.length);
  }
  assert.equal((await call(env, "/api/algo/expectancy", { method: "POST", body: "oops" as any })).status, 400, "a body that is not a JSON object is a malformed request");
  assert.equal((await call(env, "/api/algo/expectancy?strategy=yolo")).status, 400);
});

test("expectancy: a replay result can be submitted directly; too few trades is refused, and out-of-sample caps the claim", async () => {
  const env = mkEnv(), base = { symbol: "ETHUSDT", strategy: "swing", periodStart: Date.now() - 80 * DAY, periodEnd: Date.now() - DAY, expectancyForValidator: { expectancyR: 0.5, samples: 52 }, bootstrapExpectancyR: { low95: 0.2, high95: 0.8 } };
  assert.equal((await call(env, "/api/algo/expectancy", { method: "POST", body: { fromReplay: { ...base, expectancyForValidator: null } } })).status, 422);
  const r = await (await call(env, "/api/algo/expectancy", { method: "POST", body: { fromReplay: { ...base, outOfSample: { expectancyR: 0.15 } } } })).json() as any;
  assert.equal(r.saved.expectancyR, 0.15); assert.equal(r.saved.symbol, "ETHUSDT"); assert.equal(r.lookup.status, "validated");
});

const closed = (n: number, f: (i: number) => number): ClosedTrade[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, engine: "combined", symbol: i % 2 ? "BTCUSDT" : "ETHUSDT", openedAt: Date.now() - (n - i) * DAY / 4, closedAt: Date.now() - (n - i) * DAY / 4 + 3600_000, pnl: f(i) * 100, riskAmount: 100, fees: 0, slippage: 0 }));
test("refresh-paper: derives evidence from recorded paper trades, needs a strategy, and refuses fewer than the minimum", async () => {
  const env = mkEnv(), kv: MemoryKV = env.ETI_EXECUTION_LOG;
  assert.equal((await call(env, "/api/algo/expectancy/refresh-paper", { method: "POST", body: {} })).status, 400, "strategy must be stated");
  await kv.put("eti:paper:state", JSON.stringify({ closed: closed(20, () => 1) }));
  const few = await call(env, "/api/algo/expectancy/refresh-paper", { method: "POST", body: { strategy: "intraday" } }); assert.equal(few.status, 422); assert.equal(((await few.json()) as any).closedTrades, 20);
  await kv.put("eti:paper:state", JSON.stringify({ closed: closed(80, i => (i % 4 === 0 ? -1 : 1.5)) }));
  const ok = await (await call({ ...env, ETI_PAPER_STRATEGY: "swing" }, "/api/algo/expectancy/refresh-paper", { method: "POST", body: {} })).json() as any;
  assert.equal(ok.saved.source, "paper"); assert.equal(ok.saved.strategy, "swing"); assert.equal(ok.saved.symbol, "*"); assert.equal(ok.saved.samples, 80); assert.equal(ok.lookup.status, "validated");
  const sym = await (await call(env, "/api/algo/expectancy/refresh-paper", { method: "POST", body: { strategy: "intraday", symbol: "BTCUSDT" } })).json() as any; assert.equal(sym.saved.samples, 40);
});

test("journal routes: list with filters, fetch one entry, stats with withheld rates", async () => {
  const env = mkEnv(), kv: MemoryKV = env.ETI_EXECUTION_LOG, T0 = Math.floor(Date.now() / (15 * M)) * 15 * M;
  const res = (o: any = {}) => ({ symbol: "BTCUSDT", strategy: "intraday", decision: "BUY", confidence: 70, generatedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 8 * M).toISOString(), entryZone: [99.75, 100], stopLoss: 99, takeProfits: [{ price: 101.2 }, { price: 102.2 }, { price: 103.5 }], riskRewardToTP3: 3.5, validation: { classification: "CONFIRMED", score: 70, hardFailures: [] }, reasons: [], timeframes: {}, fusion: { agreement: "BOTH_BULLISH", swift: { status: "SIGNAL" }, gainz: { status: "SIGNAL" } }, ...o });
  const a = entryFromResult(res() as any, "intraday", T0), b = entryFromResult(res({ decision: "REJECTED", validation: { classification: "REJECTED", score: 30, hardFailures: ["x"] } }) as any, "intraday", T0 - 15 * M);
  await recordEntry(kv, a); await recordEntry(kv, b);
  const list = await (await call(env, "/api/algo/journal")).json() as any; assert.equal(list.entries.length, 2); assert.equal(list.entries[0].decision, "BUY"); assert.match(list.recording, /disabled/);
  assert.equal(((await (await call(env, "/api/algo/journal?decision=rejected")).json()) as any).entries.length, 1);
  const one = await (await call(env, `/api/algo/journal/entry?id=${encodeURIComponent(a.id)}`)).json() as any; assert.equal(one.symbol, "BTCUSDT"); assert.equal(one.takeProfits.length, 3);
  assert.equal((await call(env, "/api/algo/journal/entry?id=BTCUSDT:intraday:123")).status, 404); assert.equal((await call(env, "/api/algo/journal/entry")).status, 404);
  const st = await (await call(env, "/api/algo/journal/stats?days=7")).json() as any; assert.equal(st.byDecision.BUY, 1); assert.equal(st.rates.status, "insufficient_sample"); assert.equal(st.days, 7);
});

test("resolve: pending entries are evaluated against real closed bars, updated once, and the stats follow", async () => {
  const env = mkEnv(), kv: MemoryKV = env.ETI_EXECUTION_LOG, NOW = Math.floor(Date.now() / M) * M, ts = NOW - 30 * M;
  const res = { symbol: "BTCUSDT", strategy: "intraday", decision: "BUY", confidence: 70, generatedAt: new Date(ts).toISOString(), expiresAt: new Date(ts + 8 * M).toISOString(), entryZone: [99.75, 100], stopLoss: 99, takeProfits: [{ price: 101.2 }, { price: 102.2 }, { price: 103.5 }], riskRewardToTP3: 3.5,
    validation: { classification: "CONFIRMED", score: 70, hardFailures: [] }, reasons: [], timeframes: {}, fusion: { agreement: "BOTH_BULLISH", swift: { status: "SIGNAL" }, gainz: { status: "SIGNAL" } } };
  const e = entryFromResult(res as any, "intraday", ts); await recordEntry(kv, e);
  const script: Record<number, number[]> = { 1: [100, 101.3, 99.5, 101], 2: [101, 102.3, 100.5, 102], 3: [102, 103.6, 101.5, 103.5] };
  let seen = ""; globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input)); seen = u.searchParams.get("interval") || "";
    const rows = Array.from({ length: 40 }, (_, i) => { const b = script[i] ?? [100.6, 100.8, 100.4, 100.6]; return [ts + i * M, String(b[0]), String(b[1]), String(b[2]), String(b[3]), "1", ts + i * M + 59_999, "1", 1, "0", "0", "0"]; });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
  const r = await (await call(env, "/api/algo/journal/resolve", { method: "POST", body: {} }, NOW)).json() as any;
  assert.equal(r.processed, 1); assert.equal(r.results[0].outcome, "win"); assert.equal(r.results[0].updated, true); assert.ok(Math.abs(r.results[0].r - 2.19) < 1e-3); assert.equal(seen, "1m");
  const after = await (await call(env, `/api/algo/journal/entry?id=${encodeURIComponent(e.id)}`)).json() as any; assert.equal(after.resolution.status, "win"); assert.equal(after.resolution.granularity, "1m bars");
  assert.equal(((await (await call(env, "/api/algo/journal?outcome=win")).json()) as any).entries.length, 1);
  assert.equal(((await (await call(env, "/api/algo/journal/resolve", { method: "POST", body: {} }, NOW)).json()) as any).processed, 0, "nothing pending is left, so nothing is fetched or rewritten");
  const old = { ...e, bucket: e.bucket - 5 * 3600_000, id: `BTCUSDT:intraday:${e.bucket - 5 * 3600_000}`, ts: NOW - 6 * 3600_000 }; await recordEntry(kv, old);
  await call(env, "/api/algo/journal/resolve", { method: "POST", body: {} }, NOW); assert.equal(seen, "15m", "entries older than the 1-minute history use the execution timeframe");
});

// ---- integration: the stored evidence changes what the live routes tell the validator ----
const STEP: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
function market() {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input)), last = 50 + 299 * 0.3 + 0.1;
    if (u.pathname.includes("depth")) { const bids = Array.from({ length: 20 }, (_, i) => [String(last - 0.01 - i * 0.05), "20"]), asks = Array.from({ length: 20 }, (_, i) => [String(last + 0.01 + i * 0.05), "10"]); return new Response(JSON.stringify({ lastUpdateId: 1, bids, asks }), { status: 200 }); }
    const step = (STEP[u.searchParams.get("interval") || "1h"] || 3600) * 1000, now = Date.now();
    const rows = Array.from({ length: 300 }, (_, i) => { const c = 50 + i * 0.3 + 0.1, o = c - 0.1; return [now - (299 - i) * step, String(o), String(c + 1.5), String(o - 1.5), String(c), String(100 + (i % 5) * 10)]; });   // wide wicks: stops large enough to clear the cost gate
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}
const sig = (env: any, q = "strategy=intraday") => handleAlgoSignal(new Request(`https://eti.test/api/algo/signal?symbol=BTCUSDT&${q}`), env).then(r => r.json()) as Promise<any>;

test("integration: unproven -> validated -> negative changes the validator's view; a negative record blocks the setup", async () => {
  market(); const env = mkEnv();
  const a = await sig(env); assert.equal(a.validationStatus.expectancy.status, "unproven"); assert.ok(["BUY", "SELL"].includes(a.decision), `baseline should be actionable, got ${a.decision} ${JSON.stringify(a.validation?.hardFailures)}`);
  assert.ok(a.validation.warnings.some((w: string) => /No validated expectancy/.test(w))); assert.notEqual(a.validation.classification, "HIGH_CONVICTION");
  await call(env, "/api/algo/expectancy", { method: "POST", body: evidence({ expectancyR: 0.5, ciLow95: 0.2, ciHigh95: 0.8 }) });
  const b = await sig(env); assert.equal(b.validationStatus.expectancy.status, "validated"); assert.equal(b.validationStatus.expectancy.expectancyR, 0.5);
  assert.ok(!(b.validation?.warnings ?? []).some((w: string) => /No validated expectancy/.test(w)), "the unproven warning disappears once evidence exists");
  await call(env, "/api/algo/expectancy", { method: "POST", body: evidence({ source: "paper", expectancyR: -0.2, ciLow95: -0.5, ciHigh95: 0.1 }) });
  const c = await sig(env); assert.equal(c.validationStatus.expectancy.status, "negative"); assert.ok(!["BUY", "SELL"].includes(c.decision), `negative evidence must block, got ${c.decision}`); assert.equal(c.action, "HOLD");
  const other = await sig(env, "strategy=swing"); assert.equal(other.validationStatus.expectancy.status, "unproven", "evidence is per strategy");
});

test("integration: /api/omnisignal and /api/algo/signal still agree when evidence exists, and the journal records once per candle when enabled", async () => {
  market(); const env = mkEnv({ ETI_JOURNAL_ENABLED: "true" });
  await call(env, "/api/algo/expectancy", { method: "POST", body: evidence() });
  const a = await sig(env), b = await (await handleOmnisignal(new Request("https://eti.test/api/omnisignal?symbol=BTCUSDT&strategy=intraday"), env)).json() as any;
  assert.equal(a.decision, b.decision); assert.deepEqual(a.stopLoss, b.stopLoss); assert.equal(b.validationStatus.expectancy.status, "validated");
  assert.equal(a.journal, "recorded"); assert.equal(b.journal, "duplicate", "same symbol, strategy and candle");
  const list = await (await call(env, "/api/algo/journal")).json() as any; assert.equal(list.entries.length, 1); assert.match(list.recording, /enabled/);
  const entry = await (await call(env, `/api/algo/journal/entry?id=${encodeURIComponent(list.entries[0].id)}`)).json() as any; assert.equal(entry.expectancy.status, "validated"); assert.equal(entry.engines.swift, "SIGNAL");
  assert.equal(await (async () => (await sig(mkEnv())).journal)(), "disabled", "off by default");
});

test("integration: the router serves the registry routes through the Worker wrapper", async () => {
  const env = mkEnv(), app = withAlgo({ fetch: async () => new Response("base") });
  assert.equal((await app.fetch(new Request("https://eti.test/api/algo/expectancy?strategy=intraday"), env)).status, 200);
  assert.equal((await app.fetch(new Request("https://eti.test/api/algo/journal"), env)).status, 200);
  assert.equal(await (await app.fetch(new Request("https://eti.test/api/signals"), env)).text(), "base");
});

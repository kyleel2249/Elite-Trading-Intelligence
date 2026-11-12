import test from "node:test";
import assert from "node:assert/strict";
import { series } from "../algo/fixtures.ts";
import { handlePrecision } from "./api.ts";
import { resolveConfig, scoreConfigHash } from "./config.ts";
import { MIN_FIT_OUTCOMES, configuredPairs, ledgerKeys, ledgerSummary, runPrecisionCycle } from "./cycle.ts";
import type { LedgerEntry, LedgerOutcome } from "./ledger.ts";
import { keys, type KvLike } from "./stores.ts";
import { NOW, depthAround, informativeSamples, noiseSamples } from "./testkit.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const BAR = 15 * 60_000;
const HASH = scoreConfigHash(resolveConfig(undefined).config);
const TOKEN = "a-sufficiently-long-admin-token-123";
const STEP: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };

function memoryKv(): KvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
}
const json = (kv: { data: Map<string, string> }, k: string) => { const t = kv.data.get(k); return t ? JSON.parse(t) : null; };
let fetchCount = 0;

/** Live-shaped exchange built from the deterministic uptrend (same as the API tests): produces a BUY on 15m. */
function liveExchange() {
  const px = series(260, { drift: 1, noise: 2, seed: 1, start: 100, end: Date.now() }).at(-1)![4];
  fetchCount = 0;
  globalThis.fetch = (async (input: any) => {
    fetchCount++;
    const u = new URL(String(input));
    if (u.pathname.includes("depth")) {
      const d = depthAround(px, Date.now());
      return new Response(JSON.stringify({ lastUpdateId: 1, bids: d.bids.map(([p, q]) => [String(p), String(q)]), asks: d.asks.map(([p, q]) => [String(p), String(q)]) }), { status: 200 });
    }
    const step = (STEP[u.searchParams.get("interval") || "1h"] || 3600) * 1000;
    const rows = series(260, { drift: 1, noise: 2, seed: 1, start: 100, stepMs: step, end: Date.now() }).map(r => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5])]);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}
/** Exchange that serves exactly the given 15m bars [open,high,low,close] starting at `t0`. */
function fixedExchange(t0: number, bars: number[][]) {
  fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(JSON.stringify(bars.map((b, i) => [t0 + i * BAR, String(b[0]), String(b[1]), String(b[2]), String(b[3]), "100"])), { status: 200 });
  }) as typeof fetch;
}
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "seed1", symbol: "BTCUSDT", strategy: "intraday", timeframe: "15m", dir: 1, entry: 100, stop: 98, targets: [102, 104, 106], costInR: 0.05, score: 80,
  configHash: HASH, engineVersion: "1.0.0", createdAt: NOW, expiresAt: NOW + 8 * BAR, ...over,
});
const outcomes = (samples: { score: number; win: boolean }[], netOf: (win: boolean, i: number) => number, strategy = "intraday"): LedgerOutcome[] =>
  samples.map((s, i) => ({ id: `o${i}`, symbol: "BTCUSDT", strategy: strategy as any, score: s.score, configHash: HASH, status: "resolved" as const, netR: netOf(s.win, i), win: s.win, reason: "seed", createdAt: NOW - (samples.length + 5 - i) * 60_000, closedAt: NOW - (samples.length - i) * 60_000 }));
const FILL_THEN_STOP = [[100.5, 101, 99.5, 100], [99, 99.5, 97, 98], [98, 98.5, 97.5, 98]];

test("pairs come only from valid configured symbols and strategies", () => {
  assert.deepEqual(configuredPairs({}), []);
  assert.deepEqual(configuredPairs({ ETI_PRECISION_SYMBOLS: "btcusdt, BAD X, TSLAAAPL, ethusdt" } as any), [{ symbol: "BTCUSDT", strategy: "intraday" }, { symbol: "ETHUSDT", strategy: "intraday" }]);
  assert.equal(configuredPairs({ ETI_PRECISION_SYMBOLS: "BTCUSDT", ETI_PRECISION_STRATEGIES: "scalp,swing,swing,nope" } as any).length, 2);
  assert.equal(configuredPairs({ ETI_PRECISION_SYMBOLS: Array.from({ length: 30 }, (_, i) => `A${i}USDT`).join(",") } as any).length, 10, "capped at ten pairs");
});

test("the cycle is off without a store, and without symbols or open signals", async () => {
  const noKv = await runPrecisionCycle({ ETI_PRECISION_SYMBOLS: "BTCUSDT" } as any, NOW);
  assert.equal(noKv.status, "disabled"); assert.match(noKv.reason!, /KV/);
  const noSymbols = await runPrecisionCycle({ ETI_PRECISION_DATA: memoryKv() } as any, NOW);
  assert.equal(noSymbols.status, "disabled"); assert.match(noSymbols.reason!, /ETI_PRECISION_SYMBOLS/);
});

test("a tradeable signal is recorded once, and a pair with an open signal is not re-recorded", async () => {
  liveExchange();
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx", ETI_PRECISION_SYMBOLS: "BTCUSDT" } as any;
  const first = await runPrecisionCycle(env, Date.now());
  assert.equal(first.status, "ok");
  assert.equal(first.recorded.length, 1);
  const open = json(kv, ledgerKeys.open());
  assert.equal(open.length, 1); assert.equal(open[0].symbol, "BTCUSDT"); assert.equal(open[0].dir, 1); assert.equal(open[0].configHash, HASH);
  const second = await runPrecisionCycle(env, Date.now());
  assert.equal(second.recorded.length, 0);
  assert.match(second.evaluated[0].result, /still open/);
  assert.equal(json(kv, ledgerKeys.open()).length, 1);
});

test("one tick stays well inside the 50-subrequest limit", async () => {
  liveExchange();
  const kv = memoryKv();
  await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx", ETI_PRECISION_SYMBOLS: "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT", ETI_PRECISION_BATCH: "9" } as any, Date.now());
  assert.ok(fetchCount <= 4 * 9 + 4, `used ${fetchCount} fetches`);
  assert.ok(fetchCount <= 50);
});

test("pairs rotate across ticks", async () => {
  liveExchange();
  const env = { ETI_PRECISION_DATA: memoryKv(), ETI_PRECISION_SYMBOLS: "BTCUSDT,ETHUSDT,SOLUSDT", MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any;
  const a = await runPrecisionCycle(env, 0), b = await runPrecisionCycle(env, 300_000);
  assert.notEqual(a.evaluated[0].symbol, b.evaluated[0].symbol);
});

test("an open signal is resolved from closed candles and stored as an outcome", async () => {
  const kv = memoryKv();
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  fixedExchange(NOW, FILL_THEN_STOP);
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.resolved.map(x => [x.id, x.status, x.netR]), [["seed1", "resolved", -1.05]]);
  assert.equal(json(kv, ledgerKeys.open()).length, 0);
  const stored = json(kv, ledgerKeys.outcomes("intraday"));
  assert.equal(stored.length, 1); assert.equal(stored[0].win, false);
  const sum: any = await ledgerSummary({ ETI_PRECISION_DATA: kv }, "intraday", NOW);
  assert.equal(sum.resolved, 1); assert.equal(sum.winRate, 0); assert.equal(sum.meanNetR, -1.05); assert.equal(sum.open, 0);
});

test("a fetch failure leaves the signal open instead of guessing an outcome", async () => {
  const kv = memoryKv();
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.equal(r.resolved.length, 0);
  assert.ok(r.notes.some(n => /Could not fetch/.test(n)));
  assert.equal(json(kv, ledgerKeys.open()).length, 1);
});

test("resolution fetches are bounded", async () => {
  const kv = memoryKv();
  const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"];
  kv.data.set(ledgerKeys.open(), JSON.stringify(syms.map((s, i) => entry({ id: `s${i}`, symbol: s }))));
  fixedExchange(NOW, FILL_THEN_STOP);
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.ok(fetchCount <= 4, `used ${fetchCount}`);
  assert.equal(r.resolved.length, 4);
  assert.equal(json(kv, ledgerKeys.open()).length, 2, "the rest wait for the next tick");
});

test("enough informative outcomes produce a usable calibration model and a proven expectancy", async () => {
  const kv = memoryKv();
  const samples = informativeSamples(400);
  kv.data.set(ledgerKeys.outcomes("intraday"), JSON.stringify(outcomes(samples, w => (w ? 1.4 : -1.05))));
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  fixedExchange(NOW, FILL_THEN_STOP);
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.equal(r.refit.length, 1);
  assert.match(r.refit[0].calibration, /usable/);
  const model = json(kv, keys.calibration("intraday"));
  assert.ok(model.samples >= 300 && model.scoreConfigHash === HASH);
  const ex = json(kv, keys.expectancy("intraday"));
  assert.ok(ex.expectancyR > 0 && ex.samples > 0, JSON.stringify(ex));
  assert.deepEqual(json(kv, ledgerKeys.meta("intraday")).lastFitCount, 401);
});

test("an expectancy whose interval includes zero is stored as unproven (zero samples), never as a pass", async () => {
  const kv = memoryKv();
  kv.data.set(ledgerKeys.outcomes("intraday"), JSON.stringify(outcomes(noiseSamples(120), (_w, i) => (i % 2 ? 0.9 : -0.8))));
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  fixedExchange(NOW, FILL_THEN_STOP);
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.equal(r.refit.length, 1);
  assert.match(r.refit[0].expectancy, /unproven/);
  const ex = json(kv, keys.expectancy("intraday"));
  assert.equal(ex.samples, 0); assert.match(ex.source, /unproven/);
});

test("negative expectancy is stored with its samples so the gate can block", async () => {
  const kv = memoryKv();
  kv.data.set(ledgerKeys.outcomes("intraday"), JSON.stringify(outcomes(noiseSamples(120), () => -0.6)));
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  fixedExchange(NOW, FILL_THEN_STOP);
  await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  const ex = json(kv, keys.expectancy("intraday"));
  assert.ok(ex.expectancyR < 0 && ex.samples > 0);
});

test("outcomes scored under a different configuration never feed calibration", async () => {
  const kv = memoryKv();
  const old = outcomes(informativeSamples(400), w => (w ? 1.4 : -1.05)).map(o => ({ ...o, configHash: "other-config" }));
  kv.data.set(ledgerKeys.outcomes("intraday"), JSON.stringify(old));
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  fixedExchange(NOW, FILL_THEN_STOP);
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.match(r.refit[0].calibration, /not fitted/);
  assert.equal(kv.data.has(keys.calibration("intraday")), false);
});

test("no refit below the minimum number of resolved outcomes", async () => {
  const kv = memoryKv();
  kv.data.set(ledgerKeys.outcomes("intraday"), JSON.stringify(outcomes(informativeSamples(MIN_FIT_OUTCOMES - 10), () => 1)));
  kv.data.set(ledgerKeys.open(), JSON.stringify([entry()]));
  fixedExchange(NOW, FILL_THEN_STOP);
  const r = await runPrecisionCycle({ ETI_PRECISION_DATA: kv, MARKET_PROVIDER_ORDER: "binance,bybit,okx" } as any, NOW + 20 * BAR);
  assert.equal(r.resolved.length, 1);
  assert.equal(r.refit.length, 0);
  assert.equal(kv.data.has(keys.expectancy("intraday")), false);
});

test("ledger and admin cycle routes", async () => {
  const kv = memoryKv();
  const env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN } as any;
  const get = await handlePrecision(new Request("https://eti.test/api/precision/ledger?strategy=intraday"), env);
  assert.equal(get.status, 200);
  assert.equal(((await get.json()) as any).resolved, 0);
  assert.equal((await handlePrecision(new Request("https://eti.test/api/precision/ledger?strategy=yolo"), env)).status, 400);
  const noStore = await handlePrecision(new Request("https://eti.test/api/precision/ledger"), {});
  assert.equal(((await noStore.json()) as any).storeConfigured, false);

  const post = (q: string, token?: string, m = "POST") => handlePrecision(new Request(`https://eti.test/api/precision/admin/cycle${q}`, { method: m, headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
  assert.equal((await post("")).status, 401);
  assert.equal((await post("", "wrong-wrong-wrong-wrong")).status, 401);
  assert.equal((await post("", TOKEN, "GET")).status, 405);
  assert.equal((await post("?symbol=BAD%20X", TOKEN)).status, 400);
  assert.equal((await post("?symbol=BTCUSDT&strategy=yolo", TOKEN)).status, 400);
  liveExchange();
  const ok = await post("?symbol=BTCUSDT&strategy=intraday", TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).recorded.length, 1);
  assert.equal(((await (await handlePrecision(new Request("https://eti.test/api/precision/ledger?strategy=intraday"), env)).json()) as any).open, 1);
});

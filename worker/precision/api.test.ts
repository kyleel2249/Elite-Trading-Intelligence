import test from "node:test";
import assert from "node:assert/strict";
import { series } from "../algo/fixtures.ts";
import { handlePrecision } from "./api.ts";
import { withPrecision } from "./route.ts";
import type { KvLike, PrecisionEnv } from "./stores.ts";
import { depthAround, informativeSamples } from "./testkit.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const STEP: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
const TOKEN = "a-sufficiently-long-admin-token-123";

/**
 * Binance-shaped klines and depth built from the same deterministic series the engine tests use (a clean uptrend).
 * 260 rows per interval: an exchange may return fewer rows than the requested limit, and this matches the engine's verified BUY fixture.
 * (With 300 rows the same price path has a slightly different ATR and the engine correctly refuses it on net reward-to-risk.)
 */
function mockExchange(opts: { klines?: boolean; depth?: boolean; drift?: number; start?: number } = {}) {
  const { drift = 1, start = 100 } = opts;
  const px = series(260, { drift, noise: 2, seed: 1, start, end: Date.now() }).at(-1)![4];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.includes("depth")) {
      if (opts.depth === false) return new Response("{}", { status: 500 });
      const d = depthAround(px, Date.now());
      return new Response(JSON.stringify({ lastUpdateId: 1, bids: d.bids.map(([p, q]) => [String(p), String(q)]), asks: d.asks.map(([p, q]) => [String(p), String(q)]) }), { status: 200 });
    }
    if (opts.klines === false) return new Response("nope", { status: 500 });
    const step = (STEP[u.searchParams.get("interval") || "1h"] || 3600) * 1000;
    const rows = series(260, { drift, noise: 2, seed: 1, start, stepMs: step, end: Date.now() }).map(r => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5])]);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

function memoryKv(): KvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
}
const call = (path: string, env: PrecisionEnv = {}, init: RequestInit = {}) => handlePrecision(new Request("https://eti.test" + path, init), env);
const admin = (path: string, body: unknown, env: PrecisionEnv, method = "PUT", token = TOKEN) =>
  call(path, env, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const getSignal = async (env: PrecisionEnv = {}, q = "symbol=BTCUSDT&strategy=intraday") => { const r = await call(`/api/precision/signal?${q}`, env); return { status: r.status, body: await r.json() as any, headers: r.headers }; };

test("input is validated and only GET reaches the signal route", async () => {
  assert.equal((await call("/api/precision/signal?symbol=BAD%20X")).status, 400);
  assert.equal((await call("/api/precision/signal?strategy=yolo")).status, 400);
  const unsupported = await call("/api/precision/signal?symbol=TSLAAAPL");
  assert.equal(unsupported.status, 422);
  assert.equal(((await unsupported.json()) as any).error, "unsupported_market");
  const post = await call("/api/precision/signal", {}, { method: "POST" });
  assert.equal(post.status, 405);
  assert.match(((await post.json()) as any).note, /cannot place orders/);
  assert.equal((await call("/api/precision/nope")).status, 404);
  assert.equal((await call("/api/precision/signal", {}, { method: "OPTIONS" })).status, 204);
});

test("a live-shaped request returns a complete signal, uncached, with a read-only execution posture", async () => {
  mockExchange();
  const { status, body: s, headers } = await getSignal();
  assert.equal(status, 200);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(s.engine.name, "ETI PRECISION SIGNAL ENGINE");
  assert.ok(["BUY", "SELL", "NO TRADE"].includes(s.direction));
  assert.equal(s.direction, "BUY");
  assert.equal(s.tradingPair, "BTC/USDT");
  assert.ok(s.entry && s.stopLoss && s.takeProfits.length >= 2);
  assert.equal(s.opportunityScore.components.length, 10);
  assert.equal(s.liveExecutionAllowed, false);
  assert.equal(s.dataQuality.providerCrossCheck, "not_performed");
  assert.deepEqual(s.dataQuality.failures, {});
  assert.ok(s.dataQuality.timeframesLoaded.includes("15m") && s.dataQuality.timeframesLoaded.includes("1d"));
  assert.ok(s.dataQuality.notes.some((n: string) => /ETI_PRECISION_DATA/.test(n)), "tells the operator why context is unavailable");
  assert.equal(s.confidence.type, "qualitative");
  assert.ok(s.opportunityScore.value <= 79, "capped without context");
});

test("market data failure is an explicit 503 NO TRADE, never a fabricated signal", async () => {
  mockExchange({ klines: false });
  const r = await call("/api/precision/signal?symbol=BTCUSDT");
  assert.equal(r.status, 503);
  const b = await r.json() as any;
  assert.equal(b.direction, "NO TRADE");
  assert.equal(b.decision, "DATA_UNRELIABLE");
  assert.equal(b.liveExecutionAllowed, false);
  assert.equal(b.entry, undefined);
});

test("an unavailable order book is reported and blocks the trade", async () => {
  mockExchange({ depth: false });
  const { status, body: s } = await getSignal();
  assert.equal(status, 200);
  assert.equal(s.direction, "NO TRADE");
  assert.equal(s.dataQuality.orderBook, "unavailable");
  assert.ok(s.dataQuality.failures.depth);
  assert.equal(s.marketLiquidity.status, "unavailable");
});

test("markets and configuration endpoints describe what is supported and in force", async () => {
  const m = await (await call("/api/precision/markets")).json() as any;
  assert.deepEqual(m.markets.map((x: any) => x.id), ["crypto_spot"]);
  assert.ok(m.strategies.includes("swing"));
  assert.match(m.notUsedAsMarkets, /rejected rather than approximated/);
  const c = await (await call("/api/precision/config")).json() as any;
  assert.equal(c.status, "default");
  assert.equal(c.configHash, c.defaultsHash);
  assert.equal(c.config.bands.exceptional, 90);
});

test("an operator configuration override is applied, fingerprinted and visible on every signal; a bad one is rejected loudly", async () => {
  mockExchange();
  const env = { ETI_PRECISION_CONFIG: JSON.stringify({ weights: { liquidity: 25 }, gates: { maxSpreadBps: 12 } }) };
  const c = await (await call("/api/precision/config", env)).json() as any;
  assert.equal(c.status, "override_applied");
  assert.notEqual(c.configHash, c.defaultsHash);
  const s = (await getSignal(env)).body;
  assert.equal(s.engine.configStatus, "override_applied");
  assert.equal(s.engine.configHash, c.configHash);
  assert.equal(s.opportunityScore.configHash, c.configHash);
  assert.equal(s.opportunityScore.components.find((x: any) => x.id === "liquidity").configuredWeight, 25);

  const bad = await (await call("/api/precision/config", { ETI_PRECISION_CONFIG: '{"gates":{"maxSpreadBps":0}}' })).json() as any;
  assert.equal(bad.status, "override_rejected");
  assert.equal(bad.configHash, bad.defaultsHash, "the defaults stay in force");
  assert.match(bad.errors.join(" "), /maxSpreadBps/);
  const sBad = (await getSignal({ ETI_PRECISION_CONFIG: "{oops" })).body;
  assert.equal(sBad.engine.configStatus, "override_rejected");
  assert.ok(sBad.dataQuality.notes.some((n: string) => /ETI_PRECISION_CONFIG was rejected/.test(n)));
});

test("admin routes are closed without a configured token, and reject missing or wrong credentials", async () => {
  const kv = memoryKv();
  const body = { asOf: new Date().toISOString(), source: "feed", factors: [{ name: "A", bias: 0.5 }] };
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", body, { ETI_PRECISION_DATA: kv })).status, 403, "no token configured");
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", body, { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: "short" })).status, 401, "a token under 16 characters is never accepted");
  const env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", body, env, "PUT", "wrong-token-wrong-token-1")).status, 401);
  assert.equal((await call("/api/precision/admin/fundamentals/BTC", env, { method: "PUT", body: JSON.stringify(body) })).status, 401, "no Authorization header");
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", body, { ETI_PRECISION_ADMIN_TOKEN: TOKEN })).status, 503, "no store bound");
  assert.equal(kv.data.size, 0, "nothing is written by a rejected request");
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", body, env, "GET")).status, 405);
  assert.equal((await admin("/api/precision/admin/bogus/BTC", body, env)).status, 404);
});

test("admin input is validated before anything is stored", async () => {
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", { asOf: "x", source: "s", factors: [] }, env)).status, 400);
  assert.equal((await admin("/api/precision/admin/news/BTC", { asOf: new Date().toISOString(), source: "s" }, env)).status, 400);
  assert.equal((await admin("/api/precision/admin/expectancy/intraday", { expectancyR: 99, samples: 10, asOf: new Date().toISOString(), source: "s" }, env)).status, 400);
  assert.equal((await admin("/api/precision/admin/expectancy/notastrategy", {}, env)).status, 404);
  assert.equal((await admin("/api/precision/admin/fundamentals/BTC", "{not json", env)).status, 400);
  const big = await call("/api/precision/admin/fundamentals/BTC", env, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(10 * 1024 * 1024) }, body: "{}" });
  assert.equal(big.status, 400);
  assert.equal(((await big.json()) as any).error, "body_too_large");
  assert.equal((await admin("/api/precision/admin/calibration/intraday", { version: 1 }, env)).status, 400);
  assert.equal(kv.data.size, 0);
});

test("supplied fundamentals, news and expectancy flow through to the signal and lift the evidence cap", async () => {
  mockExchange();
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  const now = new Date().toISOString();
  assert.equal((await admin("/api/precision/admin/fundamentals/btc", { asOf: now, source: "test-feed", factors: [{ name: "Adoption", bias: 0.8, weight: 2, note: "rising" }] }, env)).status, 200);
  assert.equal((await admin("/api/precision/admin/news/BTC", { asOf: now, source: "test-feed", events: [] }, env)).status, 200);
  assert.equal((await admin("/api/precision/admin/expectancy/intraday", { expectancyR: 0.4, samples: 150, asOf: now, source: "paper ledger" }, env)).status, 200);
  const s = (await getSignal(env)).body;
  assert.equal(s.fundamentalJustification.status, "available");
  assert.equal(s.fundamentalJustification.source, "test-feed");
  assert.equal(s.relevantNews.status, "available");
  assert.deepEqual(s.opportunityScore.unavailableComponents, []);
  assert.equal(s.opportunityScore.capped, false);
  assert.ok(!s.dataQuality.notes.some((n: string) => /ETI_PRECISION_DATA/.test(n)));
});

test("a market-wide high-impact event blocks every asset until its window passes", async () => {
  mockExchange();
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  const now = Date.now();
  await admin("/api/precision/admin/news/_market", { asOf: new Date(now).toISOString(), source: "macro-calendar", events: [{ title: "FOMC decision", time: new Date(now + 15 * 60_000).toISOString(), impact: "high", scheduled: true }] }, env);
  const s = (await getSignal(env)).body;
  assert.equal(s.direction, "NO TRADE");
  assert.equal(s.relevantNews.blackoutActive, true);
  assert.match(s.decision.reasons.join(" "), /FOMC decision/);
  const eth = (await getSignal(env, "symbol=ETHUSDT&strategy=intraday")).body;
  assert.equal(eth.direction, "NO TRADE", "market-wide events apply to every asset");
});

test("stale or expired stored context is not used, and says so", async () => {
  mockExchange();
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await admin("/api/precision/admin/fundamentals/BTC", { asOf: old, source: "old-feed", factors: [{ name: "A", bias: 1 }] }, env);
  await admin("/api/precision/admin/expectancy/intraday", { expectancyR: 0.5, samples: 200, asOf: new Date(Date.now() - 90 * 86_400_000).toISOString(), source: "ledger" }, env);
  const s = (await getSignal(env)).body;
  assert.equal(s.fundamentalJustification.status, "stale");
  assert.ok(s.opportunityScore.unavailableComponents.includes("fundamentalAlignment"));
  assert.ok(s.opportunityScore.unavailableComponents.includes("strategyExpectancy"));
  assert.ok(s.dataQuality.notes.some((n: string) => /older than 45 days/.test(n)));
});

test("calibration loop: outcomes are fitted and validated, then confidence becomes a probability; weak data stays qualitative", async () => {
  mockExchange();
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  assert.equal((await admin("/api/precision/admin/calibration/fit?strategy=intraday", { samples: informativeSamples(40) }, env, "POST")).status, 422, "too few samples");
  assert.equal((await admin("/api/precision/admin/calibration/fit?strategy=intraday", { samples: "x" }, env, "POST")).status, 400);
  assert.equal((await admin("/api/precision/admin/calibration/fit?strategy=bogus", { samples: [] }, env, "POST")).status, 400);
  assert.equal((await admin("/api/precision/admin/calibration/fit?strategy=intraday", {}, env, "PUT")).status, 405);
  assert.equal(kv.data.size, 0);

  const before = await (await call("/api/precision/calibration?strategy=intraday", env)).json() as any;
  assert.equal(before.usable, false);
  assert.equal(before.confidenceReported, "qualitative");

  const fit = await (await admin("/api/precision/admin/calibration/fit?strategy=intraday", { samples: informativeSamples(3000), outcomeDefinition: "Closed positive after fees" }, env, "POST")).json() as any;
  assert.equal(fit.stored, true);
  assert.equal(fit.usable, true, fit.reasons.join("; "));
  assert.ok(fit.metrics.skill > 0 && fit.samples.test >= 800);

  const status = await (await call("/api/precision/calibration?strategy=intraday", env)).json() as any;
  assert.equal(status.usable, true);
  assert.equal(status.confidenceReported, "calibrated_probability");
  const s = (await getSignal(env)).body;
  assert.equal(s.confidence.type, "calibrated_probability");
  assert.ok(s.confidence.probability > 0 && s.confidence.probability < 1);
  assert.equal(s.confidence.outcomeDefinition, "Closed positive after fees");

  // The model is for intraday only; another strategy does not borrow it.
  assert.equal((await getSignal(env, "symbol=BTCUSDT&strategy=swing")).body.confidence.type, "qualitative");

  // Changing the scoring configuration invalidates the stored model automatically.
  const changed = { ...env, ETI_PRECISION_CONFIG: JSON.stringify({ weights: { liquidity: 14 } }) };
  const cs = await (await call("/api/precision/calibration?strategy=intraday", changed)).json() as any;
  assert.equal(cs.usable, false);
  assert.match(cs.reasons.join(" "), /configuration changed/);
  assert.equal((await getSignal(changed)).body.confidence.type, "qualitative");
});

test("a model fitted on score-blind outcomes is stored for inspection but never used", async () => {
  mockExchange();
  const kv = memoryKv(), env = { ETI_PRECISION_DATA: kv, ETI_PRECISION_ADMIN_TOKEN: TOKEN };
  const samples = Array.from({ length: 3000 }, (_, i) => ({ score: 40 + (i * 37) % 60, win: (i * 7919) % 2 === 0, time: i }));
  const fit = await (await admin("/api/precision/admin/calibration/fit?strategy=intraday", { samples }, env, "POST")).json() as any;
  assert.equal(fit.stored, true);
  assert.equal(fit.usable, false);
  assert.match(fit.reasons.join(" "), /Brier skill|calibration error/);
  assert.equal((await getSignal(env)).body.confidence.type, "qualitative");
});

test("corrupt stored data fails soft to 'unavailable' rather than breaking the signal", async () => {
  mockExchange();
  const kv = memoryKv();
  for (const k of ["precision:fundamentals:BTC", "precision:news:BTC", "precision:news:_market", "precision:expectancy:intraday", "precision:calibration:intraday"]) kv.data.set(k, "{broken");
  const { status, body: s } = await getSignal({ ETI_PRECISION_DATA: kv });
  assert.equal(status, 200);
  assert.equal(s.fundamentalJustification.status, "unavailable");
  assert.equal(s.confidence.type, "qualitative");
  const throwing: KvLike = { async get() { throw new Error("kv down"); }, async put() { throw new Error("kv down"); } };
  assert.equal((await getSignal({ ETI_PRECISION_DATA: throwing })).status, 200);
});

test("the route wrapper serves /api/precision/* and leaves every other route to the wrapped app", async () => {
  const seen: string[] = [];
  const app = withPrecision({ async fetch(req: Request) { seen.push(new URL(req.url).pathname); return new Response("base", { status: 200 }); } });
  assert.equal(await (await app.fetch(new Request("https://eti.test/api/market/klines"), {})).text(), "base");
  assert.equal(await (await app.fetch(new Request("https://eti.test/"), {})).text(), "base");
  assert.equal(((await (await app.fetch(new Request("https://eti.test/api/precision/markets"), {})).json()) as any).markets[0].id, "crypto_spot");
  assert.deepEqual(seen, ["/api/market/klines", "/"]);
});

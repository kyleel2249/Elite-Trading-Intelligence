// Run: node --test worker/   (Node >= 22.18, or add --experimental-strip-types)
// These tests mock upstream HTTP. They prove the proxy logic (failover,
// validation, error handling) - NOT that the real exchanges are reachable.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMarket, validateKlines, validateDepth, providerOrder } from "./market.ts";

type Route = (url: URL) => { status: number; body: unknown } | "throw";
const realFetch = globalThis.fetch;
function mock(route: Route) {
  globalThis.fetch = (async (input: any) => {
    const r = route(new URL(String(input)));
    if (r === "throw") throw new TypeError("network down");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const now = Date.now();
const binanceK = (n: number) => Array.from({ length: n }, (_, i) => [now - (n - i) * 60000, "100", "101", "99", "100.5", "12.5", 0, "0", 1, "0", "0", "0"]);
const bybitK = (n: number) => ({ retCode: 0, result: { list: Array.from({ length: n }, (_, i) => [String(now - i * 60000), "100", "101", "99", "100.5", "12.5", "1"]) } });
const okxK = (n: number) => ({ code: "0", data: Array.from({ length: n }, (_, i) => [String(now - i * 60000), "100", "101", "99", "100.5", "12.5", "1", "1", "1"]) });
const req = (path: string) => new Request("https://eti.test" + path);

test("binance healthy -> serves binance, no failover", async () => {
  mock((u) => u.host === "data-api.binance.vision" ? { status: 200, body: binanceK(5) } : { status: 500, body: "x" });
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5"), { MARKET_PROVIDER_ORDER: "binance,bybit,okx" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-eti-provider"), "binance");
  assert.equal(res.headers.get("x-eti-failover"), "false");
  const rows = await res.json() as number[][];
  assert.equal(rows.length, 5);
  assert.equal(rows[0].length, 6);
  assert.ok(rows[0][0] < rows[4][0], "ascending by time");
});

test("binance 403 on every host -> fails over to bybit with correct mapping", async () => {
  mock((u) => u.host.includes("binance") ? { status: 403, body: "Forbidden" } : u.host === "api.bybit.com" ? { status: 200, body: bybitK(4) } : { status: 500, body: "" });
  const res = await handleMarket(req("/api/market/klines?symbol=ETHUSDT&interval=1h&limit=4"), { MARKET_PROVIDER_ORDER: "binance,bybit,okx" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-eti-provider"), "bybit");
  assert.equal(res.headers.get("x-eti-failover"), "true");
  assert.match(res.headers.get("x-eti-attempts")!, /binance:http_403_blocked/);
  const rows = await res.json() as number[][];
  assert.ok(rows[0][0] < rows[3][0], "bybit newest-first normalized to ascending");
});

test("bybit+binance down -> okx; interval mapped (4h->4H)", async () => {
  let okxUrl = "";
  mock((u) => { if (u.host === "www.okx.com") { okxUrl = u.toString(); return { status: 200, body: okxK(3) }; } return { status: 403, body: "no" }; });
  const res = await handleMarket(req("/api/market/klines?symbol=SOLUSDT&interval=4h&limit=3"), {});
  assert.equal(res.headers.get("x-eti-provider"), "okx");
  assert.match(okxUrl, /instId=SOL-USDT/);
  assert.match(okxUrl, /bar=4H/);
});

test("8h is unsupported on bybit/okx: skipped, never substituted", async () => {
  mock(() => ({ status: 403, body: "Forbidden" }));
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=8h"), {});
  assert.equal(res.status, 502);
  const body = await res.json() as any;
  assert.ok(body.attempts.some((a: any) => a.errorClass === "unsupported_by_provider"));
});

test("all providers 403 -> 502 with real classification, never a fake 200", async () => {
  mock(() => ({ status: 403, body: "Forbidden" }));
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=1m"), {});
  assert.equal(res.status, 502);
  const body = await res.json() as any;
  assert.equal(body.error, "market_data_unavailable");
  assert.equal(body.detail, "upstream_http_403");
  assert.equal(body.classification, "http_403_blocked");
  assert.ok(body.attempts.length >= 7);
});

test("network failure and malformed/empty payloads trigger failover", async () => {
  mock((u) => u.host.includes("binance") ? "throw" : u.host === "api.bybit.com" ? { status: 200, body: { retCode: 0, result: { list: [] } } } : { status: 200, body: okxK(2) });
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=2"), {});
  assert.equal(res.headers.get("x-eti-provider"), "okx");
  assert.match(res.headers.get("x-eti-attempts")!, /bybit:invalid_payload/);
});

test("recovery: primary healthy again after failure", async () => {
  mock(() => ({ status: 403, body: "x" }));
  assert.equal((await handleMarket(req("/api/market/klines?symbol=BTCUSDT"), {})).status, 502);
  mock((u) => u.host === "data-api.binance.vision" ? { status: 200, body: binanceK(3) } : { status: 500, body: "" });
  const ok = await handleMarket(req("/api/market/klines?symbol=BTCUSDT"), {});
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-eti-provider"), "binance");
});

test("depth: crossed book rejected, valid book sorted; trades normalized", async () => {
  assert.throws(() => validateDepth({ bids: [[101, 1]], asks: [[100, 1]] }), /crossed/);
  const d = validateDepth({ bids: [[99, 1], [100, 2]], asks: [[102, 1], [101, 1]] });
  assert.deepEqual(d.bids[0], [100, 2]);
  assert.deepEqual(d.asks[0], [101, 1]);
  mock((u) => u.pathname === "/v5/market/recent-trade"
    ? { status: 200, body: { retCode: 0, result: { list: [{ price: "100", size: "0.5", side: "Sell", time: String(now) }] } } }
    : { status: 403, body: "" });
  const res = await handleMarket(req("/api/market/trades?symbol=BTCUSDT&provider=bybit&limit=1"), {});
  assert.equal(res.headers.get("x-eti-provider"), "bybit");
  const t = await res.json() as any[];
  assert.equal(t[0].isBuyerMaker, true, "taker sell => buyer is maker");
});

test("kline validation rejects bad OHLC", () => {
  assert.throws(() => validateKlines([[1, 100, 99, 101, 100, 1]], 10), /low_above_high/);
  assert.throws(() => validateKlines([[1, 200, 101, 99, 100, 1]], 10), /outside_range/);
  assert.throws(() => validateKlines([[1, 100, 101, 99, NaN, 1]], 10), /non_finite/);
  assert.throws(() => validateKlines([], 10), /empty/);
});

test("parameter validation and provider order", async () => {
  assert.equal((await handleMarket(req("/api/market/klines?symbol=btc%20usdt"), {})).status, 400);
  assert.equal((await handleMarket(req("/api/market/klines?interval=7m"), {})).status, 400);
  assert.equal((await handleMarket(req("/api/market/klines?limit=5000"), {})).status, 400);
  assert.equal((await handleMarket(new Request("https://eti.test/api/market/klines", { method: "POST" }), {})).status, 405);
  assert.deepEqual(providerOrder({ MARKET_PROVIDER_ORDER: "okx,binance" }), ["okx", "binance"]);
  assert.deepEqual(providerOrder({}, "okx"), ["okx", "bybit", "binance"]);
  assert.deepEqual(providerOrder({}), ["bybit", "binance", "okx"]);
});

test("diagnostics report per-host status/latency without secrets", async () => {
  mock((u) => u.host.includes("binance") ? { status: 403, body: "Forbidden" } : u.host === "api.bybit.com" ? { status: 200, body: bybitK(2) } : { status: 500, body: "" });
  const res = await handleMarket(req("/api/market/diag?symbol=BTCUSDT&interval=1m"), { MARKET_PROVIDER_ORDER: "binance,bybit,okx" }); // binance first so the failover path under test is exercised
  assert.equal(res.status, 200);
  const d = await res.json() as any;
  const binance = d.providers.find((p: any) => p.provider === "binance");
  assert.equal(binance.connectionStatus, "blocked");
  assert.equal(binance.hosts[0].upstreamStatus, 403);
  assert.ok(typeof binance.hosts[0].latencyMs === "number");
  assert.equal(d.failover.selected, "bybit");
  assert.equal(d.failover.active, true);
  assert.doesNotMatch(JSON.stringify(d), /api[_-]?key|secret|authorization|bearer/i);
});

import { getMarketData } from "./market.ts";
test("binance klines keep a plausible taker-buy volume internally; the public API stays 6 columns", async () => {
  const rows = binanceK(5).map((r, i) => { const x = [...r]; x[9] = i === 3 ? "999" : "5.0"; return x; }); // row 3: taker volume above total volume = implausible
  mock((u) => u.host === "data-api.binance.vision" ? { status: 200, body: rows } : { status: 500, body: "x" });
  const r = await getMarketData("klines", { symbol: "BTCUSDT", interval: "1m", limit: 5 }, ["binance"]) as any;
  assert.equal(r.data[0].length, 7); assert.equal(r.data[0][6], 5); assert.equal(r.data[3].length, 6, "implausible taker volume is dropped, not trusted");
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5"), {}); const pub = await res.json() as number[][];
  assert.ok(pub.every(x => x.length === 6));
});

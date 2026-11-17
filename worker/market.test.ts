import test from "node:test";
import assert from "node:assert/strict";
import { handleMarket, providerOrder } from "./market.ts";

const now = Date.now();
const req = (path: string) => new Request("https://eti.test" + path);
const kline = { retCode: 0, result: { list: [[String(now), "100", "103", "99", "102", "12"]] } };
const ticker = { retCode: 0, result: { list: [{ lastPrice: "102", price24hPcnt: "0.02", highPrice24h: "103", lowPrice24h: "99", volume24h: "1000", turnover24h: "102000" }] } };
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("Bybit spot kline is the only market-data source and returns normalized ascending OHLCV", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => { urls.push(String(input)); return new Response(JSON.stringify(kline)); }) as any;
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5"), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-eti-provider"), "bybit");
  assert.ok(urls.every(u => ["api.bytick.com", "api.bybit.com"].includes(new URL(u).hostname)));
  assert.equal(new URL(urls[0]).hostname, "api.bytick.com");
  assert.match(urls[0], /category=spot/);
  const rows = await res.json() as number[][];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 6);
  assert.equal(rows[0][4], 102);
});

test("Bybit derivatives select linear and inverse categories explicitly", async () => {
  const categories: string[] = [];
  globalThis.fetch = (async (input: any) => { categories.push(new URL(String(input)).searchParams.get("category") || ""); return new Response(JSON.stringify(kline)); }) as any;
  const linear = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&market=futures"), {});
  const inverse = await handleMarket(req("/api/market/klines?symbol=BTCUSD&market=futures&category=inverse"), {});
  assert.equal(linear.status, 200);
  assert.equal(inverse.status, 200);
  assert.deepEqual(categories, ["linear", "inverse"]);
});

test("Bybit ticker parser and response metadata", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(ticker))) as any;
  const res = await handleMarket(req("/api/market/ticker?symbol=BTCUSDT"), {});
  assert.equal(res.status, 200);
  const value = await res.json() as any;
  assert.equal(value.lastPrice, 102);
  assert.equal(value.priceChangePercent, 2);
});

test("Binance and Bitget are not accepted as alternate crypto venues", async () => {
  assert.equal((await handleMarket(req("/api/market/klines?venue=binance"), {})).status, 400);
  assert.equal((await handleMarket(req("/api/market/klines?venue=bitget"), {})).status, 400);
  assert.deepEqual(providerOrder({ MARKET_PROVIDER_ORDER: "binance,bitget,okx" }), ["bybit"]);
});

test("invalid category and malformed upstream data fail closed", async () => {
  assert.equal((await handleMarket(req("/api/market/klines?market=spot&category=inverse"), {})).status, 400);
  globalThis.fetch = (async () => new Response(JSON.stringify({ retCode: 0, result: { list: [] } }))) as any;
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT"), {});
  assert.equal(res.status, 502);
  assert.equal((await res.json() as any).error, "market_data_unavailable");
});

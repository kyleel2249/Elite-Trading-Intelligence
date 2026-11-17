import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMarket, listBybitSymbols, _resetSymbolCache } from "./market.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; _resetSymbolCache(); });
const payload = (category: string) => new Response(JSON.stringify({ retCode: 0, result: {
  list: category === "spot"
    ? [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "Trading", marginTrading: "both" }]
    : [{ symbol: category === "inverse" ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC",
         quoteCoin: category === "inverse" ? "USD" : "USDT", status: "Trading",
         contractType: category === "inverse" ? "InversePerpetual" : "LinearPerpetual" }]
}}));

test("Bybit replaces the legacy Bitget venue in the market route", async () => {
  const res = await handleMarket(new Request("https://eti.test/api/market/klines?venue=bitget"), {});
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json() as any).allowed, ["bybit"]);
});

test("Bybit spot, linear and inverse instrument discovery is category-aware", async () => {
  const cats: string[] = [];
  const fetcher: any = async (url: string) => {
    const category = new URL(url).searchParams.get("category") || "spot";
    cats.push(category);
    return payload(category);
  };
  const spot = await listBybitSymbols("spot", fetcher, Date.now, "spot");
  const linear = await listBybitSymbols("futures", fetcher, Date.now, "linear");
  const inverse = await listBybitSymbols("futures", fetcher, Date.now, "inverse");
  assert.equal(spot.rows[0].s, "BTCUSDT");
  assert.equal(linear.rows[0].s, "BTCUSDT");
  assert.equal(inverse.rows[0].s, "BTCUSD");
  assert.deepEqual(cats, ["spot", "linear", "inverse"]);
});

test("Bybit is the only enabled crypto provider in diagnostics and symbols", async () => {
  globalThis.fetch = (async (url: string) => payload(new URL(url).searchParams.get("category") || "spot")) as any;
  const res = await handleMarket(new Request("https://eti.test/api/market/symbols?market=all"), {});
  const body = await res.json() as any;
  assert.equal(body.provider, "bybit");
  assert.deepEqual(body.categories, ["spot", "linear", "inverse"]);
  assert.ok(body.symbols.every((row: any[]) => row[5] === "bybit"));
});

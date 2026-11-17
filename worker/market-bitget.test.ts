import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMarket, listBybitSymbols, listBitgetSymbols, _resetSymbolCache } from "./market.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; _resetSymbolCache(); });
const bybitPayload = (category: string) => new Response(JSON.stringify({ retCode: 0, result: {
  list: category === "spot"
    ? [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "Trading", marginTrading: "both" }]
    : [{ symbol: category === "inverse" ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC",
         quoteCoin: category === "inverse" ? "USD" : "USDT", status: "Trading", contractType: category === "inverse" ? "InversePerpetual" : "LinearPerpetual" }]
}}));

test("Bybit spot, linear and inverse symbol discovery remains category-aware", async () => {
  const cats: string[] = [];
  const fetcher: any = async (url: string) => {
    const category = new URL(url).searchParams.get("category") || "spot";
    cats.push(category); return bybitPayload(category);
  };
  const spot = await listBybitSymbols("spot", fetcher, Date.now, "spot");
  const linear = await listBybitSymbols("futures", fetcher, Date.now, "linear");
  const inverse = await listBybitSymbols("futures", fetcher, Date.now, "inverse");
  assert.equal(spot.rows[0].s, "BTCUSDT");
  assert.equal(linear.rows[0].s, "BTCUSDT");
  assert.equal(inverse.rows[0].s, "BTCUSD");
  assert.deepEqual(cats, ["spot", "linear", "inverse"]);
});

test("Bitget spot and three futures product catalogues are separately discovered", async () => {
  const cats: string[] = [];
  const fetcher: any = async (url: string) => {
    const category = new URL(url).searchParams.get("category") || "";
    cats.push(category);
    return new Response(JSON.stringify({ code: "00000", data: [{
      symbol: category === "COIN-FUTURES" ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC",
      quoteCoin: category === "COIN-FUTURES" ? "USD" : "USDT", status: "online", type: "perpetual"
    }] }));
  };
  const spot = await listBitgetSymbols("spot", fetcher);
  const futures = await listBitgetSymbols("futures", fetcher);
  assert.equal(spot.rows[0].v, "bitget");
  assert.equal(futures.rows.length, 3);
  assert.deepEqual(cats, ["SPOT", "USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]);
});

test("Bitget Coin-M delivery contracts are included in the instrument catalogue", async () => {
  const fetcher: any = async (url: string) => {
    const category = new URL(url).searchParams.get("category") || "";
    const isCoin = category === "COIN-FUTURES";
    return new Response(JSON.stringify({ code: "00000", data: [{
      symbol: isCoin ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC", quoteCoin: isCoin ? "USD" : "USDT",
      status: "online", type: isCoin ? "delivery" : "perpetual"
    }] }));
  };
  const futures = await listBitgetSymbols("futures", fetcher);
  assert.ok(futures.rows.some(row => row.pt === "COIN-FUTURES" && row.contractType === "delivery"));
});

test("Bitget chart route accepts only supported category names and does not route to Bybit", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ code: "00000", data: [["1700000000000", "100", "103", "99", "102", "5"]] }));
  }) as any;
  const res = await handleMarket(new Request("https://eti.test/api/market/klines?venue=bitget&market=futures&category=USDC-FUTURES&symbol=BTCUSDC&interval=1m"), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-eti-provider"), "bitget_mix");
  assert.ok(urls.every(u => new URL(u).hostname === "api.bitget.com"));
  assert.match(urls[0], /category=USDC-FUTURES/);
  const invalid = await handleMarket(new Request("https://eti.test/api/market/klines?venue=bitget&market=futures&category=inverse&symbol=BTCUSD"), {});
  assert.equal(invalid.status, 400);
});

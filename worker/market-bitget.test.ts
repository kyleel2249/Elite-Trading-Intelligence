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

test("Bybit instrument discovery retries the alternate host after a geo or IP block", async () => {
  const hosts: string[] = [];
  const fetcher: any = async (url: string) => {
    const host = new URL(url).hostname; hosts.push(host);
    if (host === "api.bytick.com") return new Response("blocked", { status: 403 });
    return payload("spot");
  };
  const result = await listBybitSymbols("spot", fetcher, Date.now, "spot");
  assert.equal(result.rows[0].s, "BTCUSDT");
  assert.equal(result.host, "https://api.bybit.com");
  assert.deepEqual(hosts, ["api.bytick.com", "api.bybit.com"]);
  assert.equal(result.attempts[0].status, 403);
});

test("Bybit market ticker falls through to its alternate API host after a 403", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const host = new URL(url).hostname; hosts.push(host);
    if (host === "api.bytick.com") return new Response("blocked", { status: 403 });
    return new Response(JSON.stringify({ retCode: 0, result: { list: [{
      symbol: "BTCUSDT", lastPrice: "100", highPrice24h: "105", lowPrice24h: "95",
      price24hPcnt: "0.01", volume24h: "10", turnover24h: "1000",
    }] } }));
  }) as any;
  const res = await handleMarket(new Request("https://eti.test/api/market/ticker?symbol=BTCUSDT"), {});
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.lastPrice, 100);
  assert.deepEqual(hosts, ["api.bytick.com", "api.bybit.com"]);
});

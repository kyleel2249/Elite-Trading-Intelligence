import test from "node:test";
import assert from "node:assert/strict";
import { listBybitSymbols, _resetSymbolCache, handleMarket } from "./market.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; _resetSymbolCache(); });
const page = (list: any[], cursor = "") => new Response(JSON.stringify({ retCode: 0, result: { list, nextPageCursor: cursor } }));
const spot = [
  { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "Trading", marginTrading: "both" },
  { symbol: "ETHUSDT", baseCoin: "ETH", quoteCoin: "USDT", status: "Trading", marginTrading: "none" },
  { symbol: "OLDUSDT", baseCoin: "OLD", quoteCoin: "USDT", status: "Settling" },
];
const linear = [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" }];
const inverse = [{ symbol: "BTCUSD", baseCoin: "BTC", quoteCoin: "USD", status: "Trading", contractType: "InversePerpetual" }];

test("Bybit spot discovery filters non-trading instruments and caches", async () => {
  let calls = 0;
  const fetcher: any = async (url: string) => { calls++; assert.match(url, /category=spot/); return page(spot); };
  const a = await listBybitSymbols("spot", fetcher);
  const b = await listBybitSymbols("spot", fetcher);
  assert.deepEqual(a.rows.map(x => x.s), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(calls, 1);
});

test("Bybit linear and inverse instrument lists use separate categories and cursor pagination", async () => {
  const seen: string[] = [];
  const fetcher: any = async (url: string) => {
    const u = new URL(url); seen.push(u.searchParams.get("category") || "");
    if (u.searchParams.get("category") === "linear") return page(linear, u.searchParams.has("cursor") ? "" : "next");
    return page(inverse);
  };
  const a = await listBybitSymbols("futures", fetcher, Date.now, "linear");
  const b = await listBybitSymbols("futures", fetcher, Date.now, "inverse");
  assert.equal(a.rows[0].s, "BTCUSDT");
  assert.equal(b.rows[0].s, "BTCUSD");
  assert.deepEqual(seen, ["linear", "linear", "inverse"]);
});

test("market symbols endpoint returns Bybit spot, linear and inverse catalogs", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const cat = new URL(url).searchParams.get("category");
    return page(cat === "spot" ? spot : cat === "inverse" ? inverse : linear);
  }) as any;
  const res = await handleMarket(new Request("https://eti.test/api/market/symbols?market=all"), {});
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(body.provider, "bybit");
  assert.deepEqual(body.categories, ["spot", "linear", "inverse"]);
  assert.equal(body.symbols.length, 4);
  globalThis.fetch = real;
});

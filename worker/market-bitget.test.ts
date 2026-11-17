import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMarket, listBybitSymbols, listBitgetSymbols, _resetSymbolCache } from "./market.ts";

const realFetch = globalThis.fetch;
const req = (path: string) => new Request("https://eti.test" + path);
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

test("Bitget retries the V3 public endpoint on the legacy host before downgrading to V2", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    calls.push(u.hostname + u.pathname);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/tickers")
      return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
    if (u.hostname === "capi.bitget.com" && u.pathname === "/api/v3/market/tickers")
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: "BTCUSDT", lastPr: "60000", high24h: "61000", low24h: "58000",
        baseVolume: "10", quoteVolume: "590000", bidPr: "59999", askPr: "60001", ts: "1794940561000"
      }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const response = await handleMarket(req("/api/market/ticker?venue=bitget&symbol=BTCUSDT"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-eti-upstream-host"), "capi.bitget.com");
  assert.ok(calls.includes("capi.bitget.com/api/v3/market/tickers"));
  const ticker = await response.json() as any;
  assert.equal(ticker.lastPrice, 60000);
});

test("Bitget V2 fallback serves spot ticker when the UTA V3 endpoint is Cloudflare-blocked", async () => {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/tickers")
      return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
    if (u.hostname === "capi.bitget.com" && u.pathname === "/api/v2/spot/market/tickers")
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: "BTCUSDT", lastPr: "60000", open: "59000", high24h: "61000", low24h: "58000",
        baseVolume: "10", quoteVolume: "590000", bidPr: "59999", askPr: "60001", change24h: "0.0169", ts: "1794940561000"
      }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const response = await handleMarket(req("/api/market/ticker?venue=bitget&symbol=BTCUSDT"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-eti-upstream-host"), "capi.bitget.com");
  const ticker = await response.json() as any;
  assert.equal(ticker.lastPrice, 60000);
  assert.equal(ticker.priceChangePercent, 1.69);
});

test("Bitget futures ticker maps funding rate and holdingAmount into derivatives context", async () => {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/tickers")
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: "BTCUSDT", lastPr: "60000", open: "59000", high24h: "61000", low24h: "58000",
        baseVolume: "10", quoteVolume: "590000", fundingRate: "0.0008", holdingAmount: "12500",
        markPrice: "60010", indexPrice: "59990", bidPr: "59999", askPr: "60001", ts: "1794940561000"
      }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const response = await handleMarket(req("/api/market/ticker?venue=bitget&market=futures&category=USDT-FUTURES&symbol=BTCUSDT"), {});
  assert.equal(response.status, 200);
  const ticker = await response.json() as any;
  assert.equal(ticker.fundingRate, 0.0008);
  assert.equal(ticker.openInterest, 12500);
  assert.equal(ticker.markPrice, 60010);
  assert.equal(ticker.indexPrice, 59990);
});

test("Bitget V2 candles use the documented spot and futures endpoints and granularities", async () => {
  const fallbackUrls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/candles")
      return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
    if (u.hostname === "capi.bitget.com" && u.pathname.startsWith("/api/v3/")) return new Response("not found", { status: 404 });
    if (u.hostname === "capi.bitget.com") {
      fallbackUrls.push(u.pathname + u.search);
      return new Response(JSON.stringify({ code: "00000", data: [["1794940561000", "100", "103", "99", "102", "5", "500"]] }));
    }
    return new Response("not found", { status: 404 });
  }) as any;
  const fut1m = await handleMarket(req("/api/market/klines?venue=bitget&market=futures&category=USDT-FUTURES&symbol=BTCUSDT&interval=1m&limit=5"), {});
  assert.equal(fut1m.status, 200);
  const fut1h = await handleMarket(req("/api/market/klines?venue=bitget&market=futures&category=USDT-FUTURES&symbol=BTCUSDT&interval=1h&limit=5"), {});
  assert.equal(fut1h.status, 200);
  const spot1m = await handleMarket(req("/api/market/klines?venue=bitget&market=spot&symbol=BTCUSDT&interval=1m&limit=5"), {});
  assert.equal(spot1m.status, 200);
  assert.match(fallbackUrls[0], /\/api\/v2\/mix\/market\/candles\?/);
  assert.match(fallbackUrls[0], /granularity=1m/);
  assert.match(fallbackUrls[1], /\/api\/v2\/mix\/market\/history-candles\?/);
  assert.match(fallbackUrls[1], /granularity=1H/);
  assert.match(fallbackUrls[2], /\/api\/v2\/spot\/market\/candles\?/);
  assert.match(fallbackUrls[2], /granularity=1min/);
});

test("Bitget V2 fallback tries the main domain if the legacy host is unavailable", async () => {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/tickers")
      return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
    if (u.hostname === "capi.bitget.com") return new Response("not found", { status: 404 });
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v2/spot/market/tickers")
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: "BTCUSDT", lastPr: "60000", open: "59000", high24h: "61000", low24h: "58000",
        baseVolume: "10", quoteVolume: "590000", bidPr: "59999", askPr: "60001", change24h: "0.0169", ts: "1794940561000"
      }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const response = await handleMarket(req("/api/market/ticker?venue=bitget&symbol=BTCUSDT"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-eti-upstream-host"), "api.bitget.com");
});

test("Bitget spot and futures instrument catalogues fall back to documented V2 endpoints", async () => {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/instruments")
      return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
    if (u.hostname === "capi.bitget.com" && u.pathname === "/api/v2/spot/public/symbols")
      return new Response(JSON.stringify({ code: "00000", data: [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" }] }));
    if (u.hostname === "capi.bitget.com" && u.pathname === "/api/v2/mix/market/contracts")
      return new Response(JSON.stringify({ code: "00000", data: [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", symbolStatus: "normal", symbolType: "perpetual" }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const spot = await handleMarket(req("/api/market/symbols?venue=bitget&market=spot"), {});
  assert.equal(spot.status, 200);
  assert.equal((await spot.json() as any).symbols[0][0], "BTCUSDT");
  const futures = await handleMarket(req("/api/market/symbols?venue=bitget&market=futures&category=USDT-FUTURES"), {});
  assert.equal(futures.status, 200);
  assert.equal((await futures.json() as any).symbols[0][6], "USDT-FUTURES");
});

test("Bitget margin catalogue falls back to V2 and preserves borrowing eligibility", async () => {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/instruments")
      return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
    if (u.hostname === "capi.bitget.com" && u.pathname === "/api/v2/margin/currencies")
      return new Response(JSON.stringify({ code: "00000", data: [{
        symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "1", maxCrossedLeverage: "3",
        maxIsolatedLeverage: "10", isCrossBorrowable: true, isIsolatedBaseBorrowable: true, isIsolatedQuoteBorrowable: false
      }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const response = await handleMarket(req("/api/market/symbols?venue=bitget&market=margin"), {});
  assert.equal(response.status, 200);
  const row = (await response.json() as any).symbols[0];
  assert.equal(row[0], "BTCUSDT");
  assert.equal(row[6], true);
  assert.equal(row[7], true);
  assert.equal(row[8], 3);
  assert.equal(row[9], 10);
  assert.equal(row[10], true);
  assert.equal(row[11], false);
  assert.equal(row[12], true);
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

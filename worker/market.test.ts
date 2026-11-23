import test from "node:test";
import assert from "node:assert/strict";
import { handleMarket, providerOrder, listBitgetSymbols, listBitgetMarginSymbols, bitgetAwareFetch, _resetSymbolCache } from "./market.ts";

const now = Date.now();
const req = (path: string) => new Request("https://eti.test" + path);
const bybitKline = { retCode: 0, result: { list: [[String(now), "100", "103", "99", "102", "12"]] } };
const bybitTicker = { retCode: 0, result: { list: [{ lastPrice: "102", price24hPcnt: "0.02", highPrice24h: "103", lowPrice24h: "99", volume24h: "1000", turnover24h: "102000" }] } };
const bitgetKline = { code: "00000", data: [[String(now), "100", "103", "99", "102", "12"]] };
const bitgetTicker = { code: "00000", data: [{ symbol: "BTCUSDT", lastPr: "102", open24h: "100", high24h: "103", low24h: "99", baseVolume: "1000", quoteVolume: "102000", markPrice: "101.9", indexPrice: "102.1", fundingRate: "0.0001", openInterest: "12345", bid1Price: "101.99", ask1Price: "102.01", ts: String(now) }] };
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; _resetSymbolCache(); });

test("Bybit remains the default venue and returns validated ascending OHLCV", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => { urls.push(String(input)); return new Response(JSON.stringify(bybitKline)); }) as any;
  const res = await handleMarket(req("/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5"), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-eti-provider"), "bybit");
  assert.equal(new URL(urls[0]).hostname, "api.bybit.com");
  assert.match(urls[0], /category=spot/);
  const rows = await res.json() as number[][];
  assert.equal(rows[0][4], 102);
  assert.equal(rows[0].length, 6);
});

test("Bybit derivatives keep linear and inverse categories separate", async () => {
  const categories: string[] = [];
  globalThis.fetch = (async (input: any) => { categories.push(new URL(String(input)).searchParams.get("category") || ""); return new Response(JSON.stringify(bybitKline)); }) as any;
  assert.equal((await handleMarket(req("/api/market/klines?symbol=BTCUSDT&market=futures"), {})).status, 200);
  assert.equal((await handleMarket(req("/api/market/klines?symbol=BTCUSD&market=futures&category=inverse"), {})).status, 200);
  assert.deepEqual(categories, ["linear", "inverse"]);
});

test("Bybit margin pairs are filtered from spot instruments and charted through the spot category", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input); urls.push(url);
    if (url.includes("/instruments-info")) return new Response(JSON.stringify({ retCode: 0, result: { list: [
      { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "Trading", marginTrading: "both" },
      { symbol: "ETHUSDT", baseCoin: "ETH", quoteCoin: "USDT", status: "Trading", marginTrading: "none" }
    ] } }));
    return new Response(JSON.stringify(bybitKline));
  }) as any;
  const symbols = await handleMarket(req("/api/market/symbols?venue=bybit&market=margin"), {});
  assert.equal(symbols.status, 200);
  const body = await symbols.json() as any;
  assert.equal(body.symbols.length, 1);
  assert.equal(body.symbols[0][0], "BTCUSDT");
  assert.equal(body.symbols[0][3], "margin");
  assert.equal(body.categories[0], "spot-margin");
  const candles = await handleMarket(req("/api/market/klines?venue=bybit&market=margin&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(candles.status, 200);
  assert.match(urls[1], /category=spot/);
});

test("Bitget spot candles, ticker and margin market data use the global public API", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/candles")) return new Response(JSON.stringify(bitgetKline));
    if (path.endsWith("/fills")) return new Response(JSON.stringify({ code: "00000", data: [{ ts: String(now), price: "100", size: "1", side: "buy" }] }));
    return new Response(JSON.stringify(bitgetTicker));
  }) as any;
  const candles = await handleMarket(req("/api/market/klines?venue=bitget&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(candles.status, 200);
  assert.equal(candles.headers.get("x-eti-provider"), "bitget");
  assert.equal(new URL(urls[0]).hostname, "api.bitget.com");
  assert.match(urls[0], /category=SPOT/);
  assert.match(urls[0], /interval=1m/);
  const margin = await handleMarket(req("/api/market/klines?venue=bitget&market=margin&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(margin.status, 200);
  assert.match(urls[1], /category=SPOT/);
  const marginTrades = await handleMarket(req("/api/market/trades?venue=bitget&market=margin&symbol=BTCUSDT"), {});
  assert.equal(marginTrades.status, 200);
  assert.match(urls[2], /category=MARGIN/);
  const ticker = await handleMarket(req("/api/market/ticker?venue=bitget&symbol=BTCUSDT"), {});
  assert.equal(ticker.status, 200);
  assert.match(urls[3], /category=SPOT/);
  const tickerData = await ticker.json() as any;
  assert.equal(tickerData.lastPrice, 102);
  assert.equal(tickerData.markPrice, 101.9);
  assert.equal(tickerData.indexPrice, 102.1);
  assert.equal(tickerData.fundingRate, 0.0001);
  assert.equal(tickerData.openInterest, 12345);
  assert.equal(tickerData.bidPrice, 101.99);
  assert.equal(tickerData.askPrice, 102.01);
});

test("Bitget weekly candles are built from documented daily V3 candles", async () => {
  const urls: string[] = [];
  const monday = Date.UTC(2026, 0, 5);
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ code: "00000", data: [
      [String(monday), "100", "105", "98", "102", "10", "1000"],
      [String(monday + 86400000), "102", "110", "101", "108", "5", "500"]
    ] }));
  }) as any;
  const response = await handleMarket(req("/api/market/klines?venue=bitget&symbol=BTCUSDT&interval=1w&limit=10"), {});
  assert.equal(response.status, 200);
  assert.match(urls[0], /interval=1D/);
  assert.match(urls[0], /limit=70/);
  const rows = await response.json() as number[][];
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [monday, 100, 110, 98, 108, 15]);
});

test("Bitget USDT, USDC and Coin-M futures remain explicit and never cross-substitute", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => { urls.push(String(input)); return new Response(JSON.stringify(bitgetKline)); }) as any;
  for (const category of ["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]) {
    const res = await handleMarket(req("/api/market/klines?venue=bitget&market=futures&category=" + category + "&symbol=BTCUSDT&interval=1m"), {});
    assert.equal(res.status, 200);
  }
  assert.deepEqual(urls.map(u => new URL(u).searchParams.get("category")), ["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]);
  assert.deepEqual(providerOrder({}, "bitget_mix"), ["bitget_mix"]);
  assert.deepEqual(providerOrder({}, "bybit"), ["bybit"]);
});

test("Bitget symbol discovery covers spot, all three futures products and margin-eligible pairs", async () => {
  const categories: string[] = [];
  const fetcher: any = async (input: string) => {
    const u = new URL(input), category = u.searchParams.get("category") || "";
    categories.push(category);
    const data = [{ symbol: category === "COIN-FUTURES" ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC", quoteCoin: category === "COIN-FUTURES" ? "USD" : "USDT", status: "online", type: "perpetual", maxCrossedLeverage: "3", maxIsolatedLeverage: "10" }];
    return new Response(JSON.stringify({ code: "00000", data }));
  };
  const spot = await listBitgetSymbols("spot", fetcher);
  assert.equal(spot.rows[0].s, "BTCUSDT");
  const futures = await listBitgetSymbols("futures", fetcher);
  assert.equal(futures.rows.length, 3);
  assert.deepEqual(futures.rows.map(x => x.pt).sort(), ["COIN-FUTURES", "USDC-FUTURES", "USDT-FUTURES"]);
  const margin = await listBitgetMarginSymbols(fetcher);
  assert.equal(margin.rows[0].s, "BTCUSDT");
  assert.deepEqual(categories, ["SPOT", "USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES", "MARGIN"]);
});

test("Bitget symbol API returns venue and product metadata for chart pair selectors", async () => {
  globalThis.fetch = (async (input: any) => {
    const category = new URL(String(input)).searchParams.get("category");
    return new Response(JSON.stringify({ code: "00000", data: [{ symbol: category === "COIN-FUTURES" ? "BTCUSD" : "BTCUSDT", baseCoin: "BTC", quoteCoin: category === "COIN-FUTURES" ? "USD" : "USDT", status: "online", type: "perpetual" }] }));
  }) as any;
  const response = await handleMarket(req("/api/market/symbols?venue=bitget&market=all"), {});
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.provider, "bitget");
  assert.ok(body.categories.includes("SPOT"));
  assert.ok(body.categories.includes("COIN-FUTURES"));
  assert.ok(body.symbols.some((x: any[]) => x[5] === "bitget" && x[6] === "COIN-FUTURES"));
});

test("Bybit and Bitget are isolated venues; malformed upstream responses fail closed", async () => {
  assert.equal((await handleMarket(req("/api/market/klines?venue=unknown"), {})).status, 400);
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "00000", data: [] }))) as any;
  const res = await handleMarket(req("/api/market/klines?venue=bitget&symbol=BTCUSDT"), {});
  assert.equal(res.status, 502);
  assert.equal((await res.json() as any).error, "market_data_unavailable");
});

test("free Cloudflare-only market routing does not require Fly.io or a fixed egress IP", async () => {
  const response = await handleMarket(req("/api/market/region"), {});
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.transport, "bybit-worker-rest+bitget-worker-proxy-with-browser-websocket");
  assert.equal(body.fixedEgressIp, false);
  assert.equal(body.accountResidencyIsNotChanged, true);
  assert.equal(body.placementHint, "cloudflare:global");
});


test("Bitget Worker proxy retries CAPI V3 after a primary-host network failure", async () => {
  const urls: string[] = [];
  const fetcher: any = async (input: any) => {
    const url = new URL(String(input)); urls.push(url.toString());
    if (url.hostname === "api.bitget.com") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(bitgetKline), { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await bitgetAwareFetch(
    "https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=1m&limit=10",
    { method: "GET" }, fetcher
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-eti-upstream-host"), "capi.bitget.com");
  assert.ok(urls.length >= 2);
  assert.equal((await response.json() as any).code, "00000");
});

test("Bitget Worker proxy reports a classified 502 when all hosts fail at the network layer", async () => {
  const response = await bitgetAwareFetch(
    "https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=BTCUSDT&interval=1m&limit=10",
    { method: "GET" },
    (async () => { throw new TypeError("fetch failed"); }) as any
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json() as any).code, "eti_upstream_unavailable");
});


test("Bitget category-scoped catalogue freshness is independent of failures in other futures products", async () => {
  const fetcher: any = async (input: string) => {
    const u = new URL(input), category = u.searchParams.get("category") || u.searchParams.get("productType") || "";
    if (category === "COIN-FUTURES") return new Response("temporarily unavailable", { status: 503 });
    const symbol = category === "USDC-FUTURES" ? "BTCUSDC" : "BTCUSDT";
    return new Response(JSON.stringify({ code: "00000", data: [{
      symbol, baseCoin: "BTC", quoteCoin: category === "USDC-FUTURES" ? "USDC" : "USDT",
      status: "normal", type: "perpetual"
    }] }));
  };
  globalThis.fetch = fetcher;
  const response = await handleMarket(req("/api/market/symbols?venue=bitget&market=futures&category=USDT-FUTURES"), {});
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.sources.futures.stale, false, "fresh USDT contracts must not inherit the COIN-M outage");
  assert.deepEqual(body.sources.futures.partial, []);
  assert.ok(body.symbols.some((r: any[]) => r[6] === "USDT-FUTURES"));
});


test("market diagnostics probe Bybit and Bitget spot and futures independently", async () => {
  globalThis.fetch = (async (input: any) => {
    const host = new URL(String(input)).hostname;
    return new Response(JSON.stringify(host.includes("bitget.com") ? bitgetKline : bybitKline));
  }) as any;
  const response = await handleMarket(req("/api/market/diag?symbol=BTCUSDT&interval=1m"), {});
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  const ids = body.providers.map((p: any) => p.provider);
  assert.deepEqual(ids, ["bybit", "bitget", "bitget_mix"]);
  assert.ok(body.providers.every((p: any) => p.connectionStatus === "connected"));
});

test("Binance spot and USD-M futures route through native Worker providers", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input)); urls.push(u.toString());
    if (u.pathname.endsWith("/klines")) return new Response(JSON.stringify([[String(now), "100", "103", "99", "102", "12"]]));
    if (u.pathname.endsWith("/depth")) return new Response(JSON.stringify({ bids: [["101", "2"]], asks: [["103", "3"]] }));
    if (u.pathname.endsWith("/trades")) return new Response(JSON.stringify([{ time: now, price: "102", qty: "1", isBuyerMaker: false }]));
    return new Response(JSON.stringify({ lastPrice: "102", priceChangePercent: "2", highPrice: "103", lowPrice: "99", volume: "100", quoteVolume: "10200" }));
  }) as any;
  const spot = await handleMarket(req("/api/market/klines?venue=binance&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(spot.status, 200); assert.equal(spot.headers.get("x-eti-provider"), "binance");
  const futures = await handleMarket(req("/api/market/klines?venue=binance&market=futures&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(futures.status, 200); assert.equal(futures.headers.get("x-eti-provider"), "binance_usdm");
  assert.ok(urls.some(x => new URL(x).hostname === "fapi.binance.com"));
  assert.deepEqual(providerOrder({}, "binance"), ["binance"]);
  assert.deepEqual(providerOrder({}, "binance_usdm"), ["binance_usdm"]);
});

test("OKX spot and perpetual futures use their own instrument IDs", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input)); urls.push(u.toString());
    const data = u.pathname.endsWith("/candles")
      ? [[String(now), "100", "103", "99", "102", "12"]]
      : u.pathname.endsWith("/books") ? [{ bids: [["101", "2"]], asks: [["103", "3"]] }]
      : u.pathname.endsWith("/trades") ? [{ ts: String(now), px: "102", sz: "1", side: "buy" }]
      : [{ last: "102", open24h: "100", high24h: "103", low24h: "99", vol24h: "100", volCcy24h: "10200" }];
    return new Response(JSON.stringify({ code: "0", data }));
  }) as any;
  const spot = await handleMarket(req("/api/market/klines?venue=okx&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(spot.status, 200); assert.equal(spot.headers.get("x-eti-provider"), "okx");
  const swap = await handleMarket(req("/api/market/klines?venue=okx&market=futures&symbol=BTCUSDT&interval=1m"), {});
  assert.equal(swap.status, 200); assert.ok(urls.some(x => new URL(x).searchParams.get("instId") === "BTC-USDT-SWAP"));
  assert.ok(urls.some(x => new URL(x).searchParams.get("instId") === "BTC-USDT"));
});


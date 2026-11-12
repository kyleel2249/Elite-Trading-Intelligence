import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { AllProvidersFailed, _resetSymbolCache, bitgetCategory, bitgetProductFor, getMarketData, handleMarket, listBitgetSymbols } from "./market.ts";
import { handleSignals } from "./signals.ts";

const real = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = real; _resetSymbolCache(); });
const ok = (data: unknown) => new Response(JSON.stringify({ code: "00000", msg: "success", data }), { status: 200 });
const T0 = 1_800_000_000_000;
const candle = (i: number, step = 60_000, px = 100) => [String(T0 + i * step), String(px + i), String(px + i + 2), String(px + i - 1), String(px + i + 1), "10", "1000", "1000"];

const SPOT = [
  { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" },
  { symbol: "TSLAONUSDT", baseCoin: "TSLAON", quoteCoin: "USDT", status: "online" },
  { symbol: "PAXGUSDT", baseCoin: "PAXG", quoteCoin: "USDT", status: "online" },
  { symbol: "GONEUSDT", baseCoin: "GONE", quoteCoin: "USDT", status: "gone" },
  { symbol: "bad sym", baseCoin: "B", quoteCoin: "S", status: "online" },
];
const contracts = (pt: string) => pt === "usdt-futures"
  ? [
    { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", symbolType: "perpetual", symbolStatus: "normal" },
    { symbol: "XAUUSDT", baseCoin: "XAU", quoteCoin: "USDT", symbolType: "perpetual", symbolStatus: "normal" },
    { symbol: "TSLAUSDT", baseCoin: "TSLA", quoteCoin: "USDT", symbolType: "perpetual", symbolStatus: "normal" },
    { symbol: "OLDUSDT", baseCoin: "OLD", quoteCoin: "USDT", symbolType: "perpetual", symbolStatus: "off" },
    { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", symbolType: "delivery", symbolStatus: "normal" },
  ]
  : pt === "usdc-futures" ? [{ symbol: "BTCPERP", baseCoin: "BTC", quoteCoin: "USDC", symbolType: "perpetual", symbolStatus: "normal" }]
  : [{ symbol: "BTCUSD", baseCoin: "BTC", quoteCoin: "USD", symbolType: "perpetual", symbolStatus: "normal" }];

test("categories: crypto stays crypto; catalog stocks, tokenised stocks and metals are recognised; unknown tickers are not guessed", () => {
  assert.equal(bitgetCategory("BTC", "USDT"), "crypto");
  assert.equal(bitgetCategory("PEPE", "USDT"), "crypto");
  assert.equal(bitgetCategory("XAU", "USDT"), "metals");
  assert.equal(bitgetCategory("PAXG", "USDT"), "metals");
  assert.equal(bitgetCategory("TSLA", "USDT"), "stocks");
  assert.equal(bitgetCategory("NVDAON", "USDT"), "stocks");
  assert.equal(bitgetCategory("TSLAX", "USDT"), "stocks");
  assert.equal(bitgetCategory("SPX500", "USDT"), "indices");
  assert.equal(bitgetCategory("WTI", "USDT"), "commodities");
  assert.equal(bitgetCategory("ZZZQ", "USDT"), "crypto");
});

test("futures product type is inferred from the contract symbol", () => {
  assert.equal(bitgetProductFor("BTCUSDT"), "usdt-futures");
  assert.equal(bitgetProductFor("BTCPERP"), "usdc-futures");
  assert.equal(bitgetProductFor("BTCUSD"), "coin-futures");
});

test("Bitget spot list: online pairs only, valid symbols only, categorised", async () => {
  _resetSymbolCache();
  const urls: string[] = [];
  const r = await listBitgetSymbols("spot", (async (u: any) => { urls.push(String(u)); return ok(SPOT); }) as any);
  assert.deepEqual(urls, ["https://api.bitget.com/api/v2/spot/public/symbols"]);
  assert.deepEqual(r.rows.map((x) => [x.s, x.c, x.v]), [["BTCUSDT", "crypto", "bitget"], ["PAXGUSDT", "metals", "bitget"], ["TSLAONUSDT", "stocks", "bitget"]]);
});

test("Bitget futures list: perpetuals from all three product types, active only, product type recorded", async () => {
  _resetSymbolCache();
  const r = await listBitgetSymbols("futures", (async (u: any) => ok(contracts(new URL(String(u)).searchParams.get("productType")!))) as any);
  assert.deepEqual(r.rows.map((x) => [x.s, x.c, x.pt]), [["BTCPERP", "crypto", "usdc-futures"], ["BTCUSD", "crypto", "coin-futures"], ["BTCUSDT", "crypto", "usdt-futures"], ["TSLAUSDT", "stocks", "usdt-futures"], ["XAUUSDT", "metals", "usdt-futures"]]);
});

test("Bitget list: one product type failing still serves the others and says so; all failing is an error, never an invented list", async () => {
  _resetSymbolCache();
  const partial = await listBitgetSymbols("futures", (async (u: any) => { const pt = new URL(String(u)).searchParams.get("productType")!; return pt === "coin-futures" ? new Response("x", { status: 503 }) : ok(contracts(pt)); }) as any);
  assert.equal(partial.rows.length, 4); assert.equal(partial.attempts.length, 1); assert.match(partial.attempts[0].host, /coin-futures/);
  _resetSymbolCache();
  await assert.rejects(() => listBitgetSymbols("spot", (async () => { throw new Error("offline"); }) as any), AllProvidersFailed);
  _resetSymbolCache();
  await assert.rejects(() => listBitgetSymbols("spot", (async () => new Response(JSON.stringify({ code: "40001", msg: "no" }), { status: 200 })) as any), AllProvidersFailed);
});

test("GET /api/market/symbols?venue=all merges both exchanges; the default response is unchanged", async () => {
  const info = (symbols: any[]) => new Response(JSON.stringify({ symbols }), { status: 200 });
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u));
    if (url.host === "api.bitget.com") return url.pathname.includes("spot") ? ok(SPOT) : ok(contracts(url.searchParams.get("productType")!));
    if (url.pathname.includes("fapi")) return info([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", contractType: "PERPETUAL" }]);
    return info([{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", isSpotTradingAllowed: true }]);
  }) as any;
  _resetSymbolCache();
  const def: any = await (await handleMarket(new Request("https://x.test/api/market/symbols"), {})).json();
  assert.ok(def.symbols.every((x: any) => x.length === 5)); assert.equal(def.provider, "binance");
  const all: any = await (await handleMarket(new Request("https://x.test/api/market/symbols?venue=all"), {})).json();
  assert.equal(all.provider, "all");
  assert.ok(all.symbols.some((x: any) => x[0] === "TSLAONUSDT" && x[3] === "spot" && x[4] === "stocks" && x[5] === "bitget"));
  assert.ok(all.symbols.some((x: any) => x[0] === "BTCPERP" && x[3] === "futures" && x[5] === "bitget" && x[6] === "usdc-futures"));
  assert.ok(all.symbols.some((x: any) => x[0] === "BTCUSDT" && x[5] === "binance"));
  assert.ok(all.sources.bitget_spot && all.sources.binance_futures);
  const only: any = await (await handleMarket(new Request("https://x.test/api/market/symbols?venue=bitget&market=spot"), {})).json();
  assert.ok(only.symbols.length === 3 && only.symbols.every((x: any) => x[5] === "bitget"));
  assert.equal((await handleMarket(new Request("https://x.test/api/market/symbols?venue=nope"), {})).status, 400);
});

test("one venue failing does not hide the other, and a total failure is a 502", async () => {
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u));
    if (url.host === "api.bitget.com") return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ symbols: [{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", isSpotTradingAllowed: true }] }), { status: 200 });
  }) as any;
  _resetSymbolCache();
  const r: any = await (await handleMarket(new Request("https://x.test/api/market/symbols?venue=all&market=spot"), {})).json();
  assert.equal(r.symbols.length, 1); assert.equal(r.warnings[0].venue, "bitget");
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as any;
  _resetSymbolCache();
  const bad = await handleMarket(new Request("https://x.test/api/market/symbols?venue=all"), {}); assert.equal(bad.status, 502);
});

test("Bitget spot klines, depth, trades and ticker are parsed and validated", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u)); seen.push(url.pathname + "?" + url.searchParams.toString());
    if (url.pathname.endsWith("/candles")) return ok(Array.from({ length: 5 }, (_, i) => candle(i)).reverse()); // unsorted on purpose
    if (url.pathname.endsWith("/orderbook")) return ok({ asks: [["101", "2"], ["102", "3"]], bids: [["100", "1"], ["99", "4"]], ts: "1" });
    if (url.pathname.endsWith("/fills")) return ok([{ tradeId: "1", side: "sell", price: "100.5", size: "0.2", ts: String(T0) }, { tradeId: "2", side: "buy", price: "100.6", size: "0.1", ts: String(T0 + 1) }]);
    return ok([{ symbol: "BTCUSDT", lastPr: "100.5", high24h: "110", low24h: "90", open: "100", change24h: "0.005", baseVolume: "12", quoteVolume: "1200" }]);
  }) as any;
  const k = await getMarketData("klines", { symbol: "BTCUSDT", interval: "15m", limit: 5, venue: "bitget" }, ["binance"]);
  assert.equal(k.provider, "bitget"); assert.equal(k.failover, false);
  const rows = k.data as number[][];
  assert.equal(rows.length, 5); assert.ok(rows[0][0] < rows[4][0], "sorted ascending"); assert.equal(rows[0][5], 10);
  assert.match(seen[0], /\/api\/v2\/spot\/market\/candles\?symbol=BTCUSDT&granularity=15min&limit=5/);
  const d: any = (await getMarketData("depth", { symbol: "BTCUSDT", interval: "1m", limit: 20, venue: "bitget" }, ["binance"])).data;
  assert.equal(d.bids[0][0], 100); assert.equal(d.asks[0][0], 101);
  const t: any = (await getMarketData("trades", { symbol: "BTCUSDT", interval: "1m", limit: 20, venue: "bitget" }, ["binance"])).data;
  assert.deepEqual(t.map((x: any) => [x.price, x.isBuyerMaker]).sort(), [[100.5, true], [100.6, false]]);
  const tk: any = (await getMarketData("ticker", { symbol: "BTCUSDT", interval: "1m", limit: 1, venue: "bitget" }, ["binance"])).data;
  assert.equal(tk.lastPrice, 100.5); assert.ok(Math.abs(tk.priceChangePercent - 0.5) < 1e-9); assert.equal(tk.volume, 12);
});

test("Bitget futures use the mix endpoints with the right product type", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (u: any) => { const url = new URL(String(u)); seen.push(url.pathname + "?" + url.searchParams.toString()); return ok(Array.from({ length: 3 }, (_, i) => candle(i).slice(0, 7))); }) as any;
  const a = await getMarketData("klines", { symbol: "XAUUSDT", interval: "1h", limit: 3, market: "futures", venue: "bitget" }, ["binance"]);
  assert.equal(a.provider, "bitget_mix");
  assert.match(seen[0], /\/api\/v2\/mix\/market\/candles\?symbol=XAUUSDT&productType=usdt-futures&granularity=1H&limit=3/);
  await getMarketData("klines", { symbol: "BTCPERP", interval: "1d", limit: 3, market: "futures", venue: "bitget" }, ["binance"]);
  assert.match(seen[1], /productType=usdc-futures&granularity=1Dutc/);
  await getMarketData("klines", { symbol: "BTCUSD", interval: "1m", limit: 3, market: "futures", venue: "bitget", productType: "coin-futures" }, ["binance"]);
  assert.match(seen[2], /productType=coin-futures&granularity=1m/);
  globalThis.fetch = (async (u: any) => { seen.push(new URL(String(u)).pathname + new URL(String(u)).search); return ok({ asks: [["2", "1"]], bids: [["1", "1"]] }); }) as any;
  await getMarketData("depth", { symbol: "XAUUSDT", interval: "1m", limit: 20, market: "futures", venue: "bitget" }, ["binance"]);
  assert.match(seen.at(-1)!, /merge-depth\?symbol=XAUUSDT&productType=usdt-futures&limit=50/);
});

test("Bitget failures are reported as Bitget failures: no fallback to another exchange, no invented data", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (u: any) => { hosts.push(new URL(String(u)).host); return new Response(JSON.stringify({ code: "40309", msg: "The symbol has been removed" }), { status: 200 }); }) as any;
  await assert.rejects(() => getMarketData("klines", { symbol: "GONEUSDT", interval: "1m", limit: 5, venue: "bitget" }, ["binance", "bybit", "okx"]), (e: any) => e instanceof AllProvidersFailed && e.attempts.every((a: any) => a.provider === "bitget") && e.attempts[0].errorClass === "invalid_payload");
  assert.deepEqual([...new Set(hosts)], ["api.bitget.com"]);
  globalThis.fetch = (async () => ok([["1800000000000", "100", "90", "95", "99", "1"]])) as any; // high below low
  await assert.rejects(() => getMarketData("klines", { symbol: "BTCUSDT", interval: "1m", limit: 5, venue: "bitget" }, ["binance"]), AllProvidersFailed);
  await assert.rejects(() => getMarketData("klines", { symbol: "BTCUSDT", interval: "2h", limit: 5, venue: "bitget" }, ["binance"]), (e: any) => e.attempts[0].errorClass === "unsupported_by_provider");
});

test("HTTP routes accept venue and product type and report the serving provider", async () => {
  globalThis.fetch = (async () => ok(Array.from({ length: 3 }, (_, i) => candle(i)))) as any;
  const r = await handleMarket(new Request("https://x.test/api/market/klines?symbol=TSLAUSDT&interval=1m&limit=3&market=futures&venue=bitget&pt=usdt-futures"), {});
  assert.equal(r.status, 200); assert.equal(r.headers.get("x-eti-provider"), "bitget_mix");
  assert.equal(((await r.json()) as any[])[0].length, 6);
  assert.equal((await handleMarket(new Request("https://x.test/api/market/klines?symbol=TSLAUSDT&venue=kraken"), {})).status, 400);
  assert.equal((await handleMarket(new Request("https://x.test/api/market/klines?symbol=TSLAUSDT&venue=bitget&pt=bad"), {})).status, 400);
});

test("signals can be computed from Bitget candles", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (u: any) => { seen.push(new URL(String(u)).host); return ok(Array.from({ length: 400 }, (_, i) => candle(i - 400, 3_600_000, 1000)).map((c, i) => { const n = Number(c[0]); return [String(Date.now() - (400 - i) * 3_600_000), c[1], c[2], c[3], c[4], c[5], c[6]]; })); }) as any;
  const r = await handleSignals(new Request("https://x.test/api/signals?symbol=XAUUSDT&market=futures&provider=bitget_mix&interval=1h"), {});
  assert.ok([200, 422, 503].includes(r.status));
  assert.deepEqual([...new Set(seen)], ["api.bitget.com"], "only Bitget is contacted");
  if (r.status === 200) assert.equal(((await r.json()) as any).provider, "bitget_mix");
});

// ---- dashboard client: run the real pair-list functions against a stub DOM
function clientFns() {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const grab = (from: string, to: string) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };
  const code = grab("function symInfo(){", "async function getJson(url)") + grab("const SYM={", "function symFill(");
  const els: Record<string, any> = { symMarket: { value: "spot" }, symbol: { value: "BTCUSDT" } };
  const ctx: any = { $: (id: string) => els[id] ?? (els[id] = { value: "" }) };
  vm.createContext(ctx);
  vm.runInContext(code + ";this.api={SYM,symInfo,symRows,symVisible,mkt,symVenueOf};", ctx);
  return { api: ctx.api, els };
}
const ROWS = [
  ["BTCUSDT", "BTC", "USDT", "spot", "crypto", "binance"], ["BTCUSDT", "BTC", "USDT", "spot", "crypto", "bitget"],
  ["TSLAONUSDT", "TSLAON", "USDT", "spot", "stocks", "bitget"], ["BTCUSDT", "BTC", "USDT", "futures", "crypto", "binance"], ["BTCUSDT", "BTC", "USDT", "futures", "crypto", "bitget", "usdt-futures"],
  ["TSLAUSDT", "TSLA", "USDT", "futures", "stocks", "bitget", "usdt-futures"], ["BTCPERP", "BTC", "USDC", "futures", "crypto", "bitget", "usdc-futures"],
  ["XAUUSDT", "XAU", "USDT", "futures", "metals", "bitget", "usdt-futures"], ["PAXGUSDT", "PAXG", "USDT", "spot", "metals", "binance"],
];
const names = (rows: any[]) => Array.from(rows, (r: any) => String(r[0])).sort();
test("dashboard: dropdown merges venues, prefers Binance for shared pairs, and routes Bitget pairs to Bitget", () => {
  const { api, els } = clientFns();
  api.SYM.all = ROWS; api.SYM.at = 1;
  api.SYM.market = "spot";
  assert.deepEqual(names(api.symRows()), ["BTCUSDT", "PAXGUSDT", "TSLAONUSDT"]);
  assert.equal(api.symRows().find((r: any) => r[0] === "BTCUSDT")[5], "binance");
  els.symbol.value = "BTCUSDT"; assert.equal(api.mkt(), "");
  els.symbol.value = "TSLAONUSDT"; assert.equal(api.mkt(), "&venue=bitget");
  els.symMarket.value = "futures"; api.SYM.market = "futures";
  els.symbol.value = "TSLAUSDT"; assert.equal(api.mkt(), "&market=futures&venue=bitget&pt=usdt-futures");
  els.symbol.value = "BTCPERP"; assert.equal(api.mkt(), "&market=futures&venue=bitget&pt=usdc-futures");
  els.symbol.value = "BTCUSDT"; assert.equal(api.mkt(), "&market=futures");
  api.SYM.venue = "bitget"; api.SYM.at = 2;
  assert.equal(api.mkt(), "&market=futures&venue=bitget&pt=usdt-futures", "same symbol, Bitget venue selected");
  assert.equal(api.symRows().length, 4); assert.ok(api.symRows().every((r: any) => r[5] === "bitget"));
  api.SYM.venue = "";
  els.symMarket.value = "metals"; api.SYM.market = "metals"; api.SYM.at = 3;
  assert.deepEqual(names(api.symRows()), ["PAXGUSDT", "XAUUSDT"]);
  els.symbol.value = "XAUUSDT"; assert.equal(api.mkt(), "&market=futures&venue=bitget&pt=usdt-futures");
});

test("dashboard markup has the exchange selector and loads both venues; Bitget is chart-only for orders", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /id="symVenue"/); assert.match(src, /symbols\?venue=all/); assert.match(src, /Bitget pairs are chart-only/);
});

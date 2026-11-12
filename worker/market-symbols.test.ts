import { test } from "node:test";
import assert from "node:assert/strict";
import { listBinanceSymbols, _resetSymbolCache, handleMarket, AllProvidersFailed } from "./market.ts";

const info = (symbols: any[]) => new Response(JSON.stringify({ symbols }), { status: 200 });
const SYMS = [
  { symbol: "ETHUSDT", status: "TRADING", baseAsset: "ETH", quoteAsset: "USDT", isSpotTradingAllowed: true },
  { symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", isSpotTradingAllowed: true },
  { symbol: "OLDUSDT", status: "BREAK", baseAsset: "OLD", quoteAsset: "USDT" },
  { symbol: "MARGINONLY", status: "TRADING", baseAsset: "M", quoteAsset: "X", isSpotTradingAllowed: false },
  { symbol: "bad sym!", status: "TRADING", baseAsset: "B", quoteAsset: "S" },
];

test("symbols: only TRADING spot pairs, sorted, slimmed", async () => {
  _resetSymbolCache();
  const r = await listBinanceSymbols("spot", (async () => info(SYMS)) as any);
  assert.deepEqual(r.rows, [{ s: "BTCUSDT", b: "BTC", q: "USDT", m: "spot", c: "crypto" }, { s: "ETHUSDT", b: "ETH", q: "USDT", m: "spot", c: "crypto" }]); assert.equal(r.cached, false);
});
test("symbols: fails over across hosts, caches, and serves a stale list rather than nothing", async () => {
  _resetSymbolCache(); const hosts: string[] = []; let t = 0;
  const f: any = async (u: string) => { hosts.push(new URL(u).host); return hosts.length === 1 ? new Response("no", { status: 451 }) : info(SYMS); };
  const a = await listBinanceSymbols("spot", f, () => t); assert.equal(hosts.length, 2); assert.equal(a.attempts[0].errorClass !== null, true); assert.equal(a.rows.length, 2);
  const b = await listBinanceSymbols("spot", f, () => t + 5 * 60_000); assert.equal(b.cached, true); assert.equal(hosts.length, 2);
  const down: any = async () => { throw new Error("offline"); };
  const c = await listBinanceSymbols("spot", down, () => t + 2 * 3600_000); assert.equal(c.stale, true); assert.equal(c.rows.length, 2); // stale beats nothing
});
test("symbols: with no cache and every host failing, nothing is invented", async () => {
  _resetSymbolCache(); const down: any = async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); };
  await assert.rejects(() => listBinanceSymbols("spot", down), (e: any) => e instanceof AllProvidersFailed && e.attempts[0].errorClass === "timeout");
  _resetSymbolCache(); const empty: any = async () => info([]); await assert.rejects(() => listBinanceSymbols("spot", empty), AllProvidersFailed);
});
test("GET /api/market/symbols: contract and 502 on failure", async () => {
  _resetSymbolCache(); const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => info(SYMS)) as any;
    const ok = await handleMarket(new Request("https://x.test/api/market/symbols"), {}); const j: any = await ok.json();
    assert.equal(ok.status, 200); assert.ok(j.count >= 2); assert.deepEqual(j.symbols[0], ["BTCUSDT", "BTC", "USDT", "spot", "crypto"]); assert.equal(j.refreshEverySeconds, 600); assert.equal(j.provider, "binance");
    _resetSymbolCache(); globalThis.fetch = (async () => new Response("x", { status: 503 })) as any;
    const bad = await handleMarket(new Request("https://x.test/api/market/symbols"), {}); assert.equal(bad.status, 502); assert.equal(((await bad.json()) as any).error, "symbols_unavailable");
  } finally { globalThis.fetch = real; _resetSymbolCache(); }
});

const FUT = [
  { symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", baseAsset: "BTC", quoteAsset: "USDT", underlyingType: "COIN" },
  { symbol: "TSLAUSDT", status: "TRADING", contractType: "TRADIFI_PERPETUAL", baseAsset: "TSLA", quoteAsset: "USDT", underlyingType: "EQUITY" },
  { symbol: "XAUUSDT", status: "TRADING", contractType: "TRADIFI_PERPETUAL", baseAsset: "XAU", quoteAsset: "USDT", underlyingType: "COMMODITY" },
  { symbol: "BTCUSDT_250627", status: "TRADING", contractType: "CURRENT_QUARTER", baseAsset: "BTC", quoteAsset: "USDT", underlyingType: "COIN" },
  { symbol: "ETHUSDC", status: "SETTLING", contractType: "PERPETUAL", baseAsset: "ETH", quoteAsset: "USDC", underlyingType: "COIN" },
];
test("futures list: perpetuals only, categorised (stocks, commodities), dated and settling contracts excluded", async () => {
  _resetSymbolCache(); const urls: string[] = [];
  const r = await listBinanceSymbols("futures", (async (u: string) => { urls.push(u); return info(FUT); }) as any);
  assert.ok(urls[0].startsWith("https://fapi.binance.com/fapi/v1/exchangeInfo"));
  assert.deepEqual(r.rows.map(x => [x.s, x.m, x.c]), [["BTCUSDT", "futures", "crypto"], ["TSLAUSDT", "futures", "stocks"], ["XAUUSDT", "futures", "metals"]]);
});
test("metals: gold, silver, copper perpetuals and gold-backed spot tokens are categorised 'metals'; lookalikes are not", async () => {
  _resetSymbolCache();
  const perp = (b: string, u = "COMMODITY") => ({ symbol: b + "USDT", status: "TRADING", contractType: "TRADIFI_PERPETUAL", baseAsset: b, quoteAsset: "USDT", underlyingType: u });
  const fut = await listBinanceSymbols("futures", (async () => info([perp("XAU"), perp("XAG"), perp("XPT"), perp("XPD"), perp("COPPER"), perp("CL"), perp("XAUT", "COIN")])) as any);
  assert.deepEqual(fut.rows.map(x => [x.b, x.c]), [["CL", "commodities"], ["COPPER", "metals"], ["XAG", "metals"], ["XAUT", "metals"], ["XAU", "metals"], ["XPD", "metals"], ["XPT", "metals"]]);
  _resetSymbolCache();
  const spot = (b: string) => ({ symbol: b + "USDT", status: "TRADING", isSpotTradingAllowed: true, baseAsset: b, quoteAsset: "USDT" });
  const sp = await listBinanceSymbols("spot", (async () => info([spot("PAXG"), spot("XAUT"), spot("BTC"), spot("XAUS")])) as any);
  assert.deepEqual(sp.rows.map(x => [x.b, x.c]), [["BTC", "crypto"], ["PAXG", "metals"], ["XAUS", "crypto"], ["XAUT", "metals"]]);
  _resetSymbolCache();
});
test("cache is per market and refreshes after 10 minutes", async () => {
  _resetSymbolCache(); let calls = 0, t = 0; const f: any = async (u: string) => { calls++; return info(u.includes("fapi") ? FUT : SYMS); };
  await listBinanceSymbols("spot", f, () => t); await listBinanceSymbols("futures", f, () => t); assert.equal(calls, 2);
  await listBinanceSymbols("spot", f, () => t + 9 * 60_000); assert.equal(calls, 2);
  const r = await listBinanceSymbols("spot", f, () => t + 10 * 60_000 + 1); assert.equal(calls, 3); assert.equal(r.cached, false);
});
test("/api/market/symbols?market=all merges both markets and reports a partial failure honestly", async () => {
  _resetSymbolCache(); const real = globalThis.fetch;
  try {
    globalThis.fetch = (async (u: string) => u.includes("fapi") ? new Response("x", { status: 503 }) : info(SYMS)) as any;
    const r: any = await (await handleMarket(new Request("https://x.test/api/market/symbols?market=all"), {})).json();
    assert.ok(r.symbols.every((x: any) => x[3] === "spot")); assert.equal(r.warnings[0].market, "futures"); assert.ok(r.sources.spot);
    _resetSymbolCache(); globalThis.fetch = (async (u: string) => info(u.includes("fapi") ? FUT : SYMS)) as any;
    const both: any = await (await handleMarket(new Request("https://x.test/api/market/symbols"), {})).json();
    assert.equal(both.symbols.filter((x: any) => x[3] === "futures").length, 3); assert.equal(both.warnings.length, 0);
    assert.equal((await handleMarket(new Request("https://x.test/api/market/symbols?market=options"), {})).status, 400);
  } finally { globalThis.fetch = real; _resetSymbolCache(); }
});
test("futures market data: only fapi hosts are contacted, never spot or other exchanges", async () => {
  const real = globalThis.fetch, hosts: string[] = [];
  try {
    globalThis.fetch = (async (u: string) => { hosts.push(new URL(u).host + new URL(u).pathname); return new Response("x", { status: 503 }); }) as any;
    const r = await handleMarket(new Request("https://x.test/api/market/klines?symbol=BTCUSDT&interval=1m&limit=5&market=futures"), {}); assert.equal(r.status, 502);
    assert.ok(hosts.length >= 1 && hosts.every(h => h.startsWith("fapi.binance.com/fapi/v1/klines")), hosts.join());
    assert.equal((await handleMarket(new Request("https://x.test/api/market/klines?symbol=BTCUSDT&market=swap"), {})).status, 400);
    hosts.length = 0; globalThis.fetch = (async (u: string) => { hosts.push(new URL(u).host); return new Response(JSON.stringify([[Date.now() - 60000, "1", "2", "0.5", "1.5", "10", 0, "0", 0, "4", "0", "0"]]), { status: 200 }); }) as any;
    const ok = await handleMarket(new Request("https://x.test/api/market/klines?symbol=BTCUSDT&interval=1m&limit=1&market=futures"), {}); assert.equal(ok.status, 200); assert.equal(ok.headers.get("x-eti-provider"), "binance_usdm");
  } finally { globalThis.fetch = real; }
});

import test from "node:test";
import assert from "node:assert/strict";
import { loadSignalInputs } from "./market-inputs.ts";
import { analyzeDerivativesContext } from "./derivatives.ts";

const NOW = 1_800_000_000_000;
function fetcherFor(calls: string[], openInterest = 12500, timestamp = NOW) {
  return (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    calls.push(u.pathname + u.search);
    if (u.pathname === "/api/v3/market/candles") return new Response(JSON.stringify({ code: "00000", data: [["1799999940000", "100", "101", "99", "100.5", "10"]] }));
    if (u.pathname === "/api/v3/market/orderbook") return new Response(JSON.stringify({ code: "00000", data: {
      bids: Array.from({ length: 10 }, (_, i) => [String(100 - i * 0.1), "10"]),
      asks: Array.from({ length: 10 }, (_, i) => [String(101 + i * 0.1), "10"])
    } }));
    if (u.pathname === "/api/v3/market/tickers") return new Response(JSON.stringify({ code: "00000", data: [{
      symbol: "BTCUSDT", lastPr: "100.5", open: "99", high24h: "102", low24h: "98", baseVolume: "10", quoteVolume: "1000",
      fundingRate: "0.0008", holdingAmount: String(openInterest), ts: String(timestamp)
    }] }));
    return new Response("not found", { status: 404 });
  }) as any;
}

test("Bitget futures loader keeps one venue/category and returns order book plus derivatives context", async () => {
  const calls: string[] = [];
  const r = await loadSignalInputs({} as any, "BTCUSDT", "intraday", "bitget", NOW, "futures", "USDT-FUTURES", fetcherFor(calls));
  if ("error" in r) throw new Error(JSON.stringify(r));
  assert.equal(r.provider, "bitget_mix");
  assert.equal(r.market, "futures");
  assert.equal(r.category, "USDT-FUTURES");
  assert.ok(r.depth && r.depth.bids.length === 10 && r.depth.asks.length === 10);
  assert.equal(r.derivatives?.fundingRate, 0.0008);
  assert.equal(r.derivatives?.openInterest, 12500);
  assert.equal(r.derivatives?.source, "bitget_mix");
  assert.ok(calls.every(x => x.includes("category=USDT-FUTURES")));
});

test("spot loader does not invent futures funding or open-interest values", async () => {
  const calls: string[] = [];
  const r = await loadSignalInputs({} as any, "BTCUSDT", "intraday", "bitget", NOW, "spot", "SPOT", fetcherFor(calls));
  if ("error" in r) throw new Error(JSON.stringify(r));
  assert.equal(r.market, "spot");
  assert.equal(r.derivatives, null);
  assert.ok(calls.every(x => !x.includes("/api/v3/market/tickers")));
});

test("futures loader compares open interest with the previous short-lived KV snapshot", async () => {
  const values = new Map<string, string>();
  const kv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); }
  };
  const env = { ETI_EXECUTION_LOG: kv } as any;
  const first = await loadSignalInputs(env, "BTCUSDT", "intraday", "bitget", NOW, "futures", "USDT-FUTURES", fetcherFor([], 10_000, NOW));
  if ("error" in first) throw new Error(JSON.stringify(first));
  assert.equal(first.derivatives?.previousOpenInterest, undefined);
  const second = await loadSignalInputs(env, "BTCUSDT", "intraday", "bitget", NOW + 60_000, "futures", "USDT-FUTURES", fetcherFor([], 9_000, NOW + 60_000));
  if ("error" in second) throw new Error(JSON.stringify(second));
  assert.equal(second.derivatives?.previousOpenInterest, 10_000);
  const analysis = analyzeDerivativesContext(second.derivatives, 1, NOW + 60_000);
  assert.equal(analysis.openInterestChangePct, -10);
  assert.ok(analysis.notes.some(n => /contracting sharply/.test(n)));
});

test("shared signal inputs use Binance USD-M futures through the same normalized gateway", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url); calls.push(u.pathname);
    if (u.pathname.endsWith("/klines")) return new Response(JSON.stringify([[String(NOW-60000), "100", "101", "99", "100.5", "10"]]));
    if (u.pathname.endsWith("/depth")) return new Response(JSON.stringify({ bids: [["100", "2"]], asks: [["101", "3"]] }));
    return new Response(JSON.stringify({ lastPrice: "100.5", priceChangePercent: "1", highPrice: "102", lowPrice: "98", volume: "100", quoteVolume: "10000" }));
  }) as any;
  const r = await loadSignalInputs({} as any, "BTCUSDT", "intraday", "binance", NOW, "futures", "linear", fetcher);
  if ("error" in r) throw new Error(JSON.stringify(r));
  assert.equal(r.provider, "binance_usdm");
  assert.equal(r.category, "linear");
  assert.ok(r.depth && r.depth.bids.length === 1);
  assert.ok(calls.some(x => x.startsWith("/fapi/")));
});

test("shared signal inputs use OKX perpetual swap IDs without changing venue provenance", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url); calls.push(u.pathname + u.search);
    const data = u.pathname.endsWith("/candles")
      ? [[String(NOW-60000), "100", "101", "99", "100.5", "10"]]
      : u.pathname.endsWith("/books") ? [{ bids: [["100", "2"]], asks: [["101", "3"]] }]
      : [{ last: "100.5", open24h: "99", high24h: "102", low24h: "98", vol24h: "100", volCcy24h: "10000" }];
    return new Response(JSON.stringify({ code: "0", data }));
  }) as any;
  const r = await loadSignalInputs({} as any, "BTCUSDT", "intraday", "okx", NOW, "futures", "swap", fetcher);
  if ("error" in r) throw new Error(JSON.stringify(r));
  assert.equal(r.provider, "okx");
  assert.equal(r.category, "swap");
  assert.ok(calls.some(x => x.includes("instId=BTC-USDT-SWAP")));
  assert.ok(r.depth && r.depth.asks.length === 1);
});


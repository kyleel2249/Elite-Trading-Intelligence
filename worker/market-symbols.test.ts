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
  const r = await listBinanceSymbols((async () => info(SYMS)) as any);
  assert.deepEqual(r.rows, [{ s: "BTCUSDT", b: "BTC", q: "USDT" }, { s: "ETHUSDT", b: "ETH", q: "USDT" }]); assert.equal(r.cached, false);
});
test("symbols: fails over across hosts, caches, and serves a stale list rather than nothing", async () => {
  _resetSymbolCache(); const hosts: string[] = []; let t = 0;
  const f: any = async (u: string) => { hosts.push(new URL(u).host); return hosts.length === 1 ? new Response("no", { status: 451 }) : info(SYMS); };
  const a = await listBinanceSymbols(f, () => t); assert.equal(hosts.length, 2); assert.equal(a.attempts[0].errorClass !== null, true); assert.equal(a.rows.length, 2);
  const b = await listBinanceSymbols(f, () => t + 1000); assert.equal(b.cached, true); assert.equal(hosts.length, 2);
  const down: any = async () => { throw new Error("offline"); };
  const c = await listBinanceSymbols(down, () => t + 2 * 3600_000); assert.equal(c.cached, true); assert.equal(c.rows.length, 2); // stale beats nothing
});
test("symbols: with no cache and every host failing, nothing is invented", async () => {
  _resetSymbolCache(); const down: any = async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); };
  await assert.rejects(() => listBinanceSymbols(down), (e: any) => e instanceof AllProvidersFailed && e.attempts[0].errorClass === "timeout");
  _resetSymbolCache(); const empty: any = async () => info([]); await assert.rejects(() => listBinanceSymbols(empty), AllProvidersFailed);
});
test("GET /api/market/symbols: contract and 502 on failure", async () => {
  _resetSymbolCache(); const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => info(SYMS)) as any;
    const ok = await handleMarket(new Request("https://x.test/api/market/symbols"), {}); const j: any = await ok.json();
    assert.equal(ok.status, 200); assert.equal(j.count, 2); assert.deepEqual(j.symbols[0], ["BTCUSDT", "BTC", "USDT"]); assert.equal(j.provider, "binance");
    _resetSymbolCache(); globalThis.fetch = (async () => new Response("x", { status: 503 })) as any;
    const bad = await handleMarket(new Request("https://x.test/api/market/symbols"), {}); assert.equal(bad.status, 502); assert.equal(((await bad.json()) as any).error, "symbols_unavailable");
  } finally { globalThis.fetch = real; _resetSymbolCache(); }
});

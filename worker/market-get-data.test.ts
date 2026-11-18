import test from "node:test";
import assert from "node:assert/strict";
import { getMarketData } from "./market.ts";

test("algorithm market requests use Bitget V2 fallback and retain derivatives fields", async () => {
  const urls: string[] = [];
  const fetcher = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    urls.push(u.hostname + u.pathname + u.search);
    if (u.hostname === "api.bitget.com" && u.pathname === "/api/v3/market/tickers") return new Response("blocked", { status: 403 });
    if (u.hostname === "capi.bitget.com" && u.pathname === "/api/v2/mix/market/ticker") return new Response(JSON.stringify({ code: "00000", data: [{
      symbol: "BTCUSDT", lastPr: "60000", open: "59000", high24h: "61000", low24h: "58000",
      baseVolume: "10", quoteVolume: "590000", fundingRate: "0.0007", holdingAmount: "12500",
      markPrice: "60010", indexPrice: "59990", bidPr: "59999", askPr: "60001", ts: "1794940561000"
    }] }));
    return new Response("not found", { status: 404 });
  }) as any;
  const r = await getMarketData("ticker", { symbol: "BTCUSDT", interval: "1m", limit: 1, market: "futures", category: "USDT-FUTURES" }, ["bitget_mix"], fetcher);
  assert.equal(r.provider, "bitget_mix");
  assert.equal((r.data as any).fundingRate, 0.0007);
  assert.equal((r.data as any).openInterest, 12500);
  assert.ok(urls.some(u => u.startsWith("capi.bitget.com/api/v2/mix/market/ticker?")));
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildAdvancedVolumeProfile } from "./advanced-volume-profile.ts";
import { handleAnalysis } from "./api.ts";

const candles = Array.from({ length: 30 }, (_, i) => {
  const close = 100 + Math.sin(i / 3) * 2;
  return [1700000000000 + i * 60000, close, close + 1, close - 1, close, 10] as [number,number,number,number,number,number];
});

test("uses execution prints for POC instead of spreading candle volume", () => {
  const trades = Array.from({ length: 40 }, (_, i) => ({ time: 1700000000000 + i, price: i < 30 ? 101 : 105, qty: i < 30 ? 2 : 1, side: i % 2 ? "buy" as const : "sell" as const }));
  const result = buildAdvancedVolumeProfile({ symbol: "BTCUSDT", candles, trades, bins: 48 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("profile unavailable");
  assert.equal(result.sourceCoverage.method, "transaction_level");
  assert.ok(Math.abs(result.poc - 101) < 0.2);
  assert.equal(result.sourceCoverage.exchangeTradeCount, 40);
  assert.ok(result.developingPocHistory.length > 1);
});

test("uses OHLCV approximation only when no execution prints exist", () => {
  const result = buildAdvancedVolumeProfile({ symbol: "ETHUSDT", candles, bins: 32 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("profile unavailable");
  assert.equal(result.sourceCoverage.method, "ohlcv_approximation");
  assert.match(result.method, /OHLCV approximation/);
});

test("counts decoded DEX swaps but excludes unpriced wallet transfers", () => {
  const result = buildAdvancedVolumeProfile({ symbol: "TOKENUSDC", swaps: [
    { time: 1700000000000, price: 2, baseQuantity: 50, quoteQuantity: 100, side: "buy", source: "ethereum:uniswap-v3" }
  ] });
  if (result.status !== "ok") throw new Error("profile unavailable");
  assert.equal(result.sourceCoverage.decodedSwapCount, 1);
  assert.equal(result.sourceCoverage.method, "transaction_level");
  assert.equal(result.sourceCoverage.eventCount, 1);
  assert.ok(result.poc > 0);
});

test("rejects empty data and clamps profile parameters", () => {
  const empty = buildAdvancedVolumeProfile({ symbol: "BTCUSDT" });
  assert.equal(empty.status, "unavailable");
  const result = buildAdvancedVolumeProfile({ symbol: "BTCUSDT", candles, bins: 999, valueAreaPct: 1 });
  if (result.status !== "ok") throw new Error("profile unavailable");
  assert.equal(result.bins.length, 200);
  assert.equal(result.valueAreaPct, 0.9);
});

test("marks historical POCs revisited only after their formation time", () => {
  const result = buildAdvancedVolumeProfile({ symbol: "BTCUSDT", candles, historicalPocs: [{ price: candles[5][2], formedAt: candles[5][0] - 1 }] });
  if (result.status !== "ok") throw new Error("profile unavailable");
  assert.equal(result.historicalPocs[0].status, "revisited");
});

test("read-only API accepts supplied exchange prints and returns multi-market profile", async () => {
  const request = new Request("https://eti.test/api/analysis/volume-profile?symbol=BTCUSDT&venue=bitget&market=futures", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ trades: Array.from({ length: 25 }, (_, i) => ({ time: 1700000000000 + i, price: i < 20 ? 100 : 102, qty: 1, isBuyerMaker: i % 2 === 0 })), candles })
  });
  const response = await handleAnalysis(request, {} as any);
  const data = await response.json() as any;
  assert.equal(response.status, 200);
  assert.equal(data.schema, "eti.multi-market-volume-profile/1");
  assert.equal(data.profiles[0].sourceCoverage.method, "transaction_level");
  assert.equal(data.submitsOrder, false);
  assert.equal(data.liveExecutionAllowed, false);
});

test("API rejects unpriced blockchain transfers instead of inventing a market price", async () => {
  const request = new Request("https://eti.test/api/analysis/volume-profile?symbol=TOKENUSDC", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ swaps: [{ time: 1700000000000, tokenAddress: "0xabc", amount: 500 }] })
  });
  const response = await handleAnalysis(request, {} as any);
  assert.equal(response.status, 400);
});

import test from "node:test";
import assert from "node:assert/strict";
import { handleV3AlphaLedger } from "./v3-alpha-ledger.ts";

test("V3 Alpha intelligence uses the selected OKX swap feed and retains venue provenance", async () => {
  const now = Date.now();
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const interval = url.searchParams.get("bar") || "1h";
    const unit = interval.endsWith("m") ? 60_000 : interval.endsWith("H") ? 3_600_000 : interval.endsWith("D") ? 86_400_000 : 3_600_000;
    const rows = Array.from({ length: 300 }, (_, i) => {
      const close = 100 + Math.sin(i / 9) * 3 + i * 0.01;
      return [String(now - (299 - i) * unit), String(close - 0.2), String(close + 0.8), String(close - 0.9), String(close), "25"];
    }).reverse();
    return new Response(JSON.stringify({ code: "0", data: rows }));
  }) as any;
  const request = new Request("https://eti.test/api/algo/v3-alpha/intelligence?symbol=BTCUSDT&strategy=intraday&venue=okx&market=futures&category=swap&simulations=100");
  const response = await handleV3AlphaLedger(request, {} as any);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.venue, "okx");
  assert.equal(body.market, "futures");
  assert.equal(body.category, "swap");
  assert.equal(body.marketDataSource, "okx_public_market_data");
});

test("V3 Alpha rejects unsupported venues rather than silently falling back to Bybit", async () => {
  const request = new Request("https://eti.test/api/algo/v3-alpha/intelligence?symbol=BTCUSDT&strategy=intraday&venue=unknown&market=futures&simulations=100");
  const response = await handleV3AlphaLedger(request, {} as any);
  assert.equal(response.status, 400);
});

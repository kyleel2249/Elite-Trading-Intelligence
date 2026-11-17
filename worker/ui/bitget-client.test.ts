import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BITGET_CLIENT_JS } from "./bitget-client.ts";

test("Bitget browser adapter parses and exposes public REST helpers", () => {
  assert.doesNotThrow(() => new vm.Script(BITGET_CLIENT_JS));
  for (const name of ["request", "candles", "context", "marketData", "symbols", "loadSignalInputs"]) {
    assert.ok(BITGET_CLIENT_JS.includes(name), name);
  }
  assert.ok(BITGET_CLIENT_JS.includes("https://api.bitget.com"));
  assert.ok(BITGET_CLIENT_JS.includes("https://capi.bitget.com"));
});

test("Bitget browser adapter falls back from a blocked V3 request to the V2 public endpoint", async () => {
  const calls: string[] = [];
  const sandbox: any = {
    window: {},
    AbortSignal,
    Response,
    fetch: async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v3/")) return new Response(JSON.stringify({ cloudflare: "block" }), { status: 403 });
      return new Response(JSON.stringify({ code: "00000", data: [
        ["3000", "3", "3.5", "2.5", "3.2", "4"],
        ["1000", "1", "1.5", "0.5", "1.2", "2"],
        ["2000", "2", "2.5", "1.5", "2.2", "3"]
      ] }), { status: 200 });
    }
  };
  vm.runInNewContext(BITGET_CLIENT_JS, sandbox);
  const rows = await sandbox.window.ETIBitget.candles({ symbol: "BTCUSDT", interval: "1m", limit: 210, market: "spot" });
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], 1000);
  assert.equal(rows[2][0], 3000);
  assert.ok(calls.some(url => url.includes("/api/v3/market/candles")));
  assert.ok(calls.some(url => url.includes("/api/v2/spot/market/candles")));
});

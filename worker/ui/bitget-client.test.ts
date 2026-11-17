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

import test from "node:test";
import assert from "node:assert/strict";
import app from "../main.ts";

test("main Worker mounts authenticated Bitget private API routes", async () => {
  const response = await app.fetch(new Request("https://eti.test/api/bitget/status", {
    headers: { authorization: "Bearer test-execution-token" }
  }), { ETI_EXECUTION_TOKEN: "test-execution-token" } as any);
  assert.equal(response.status, 200);
  const body: any = await response.json();
  assert.equal(body.venue, "bitget");
  assert.equal(body.credentials.complete, false);
  assert.ok(body.markets.includes("spot"));
  assert.ok(body.markets.includes("usdt-futures"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { handleBybitAccount, withBybitAccount } from "./route.ts";

const env = { ETI_EXECUTION_TOKEN: "master-token", BYBIT_API_KEY: "bybit-key", BYBIT_API_SECRET: "bybit-secret", BYBIT_ACCOUNT_ENV: "testnet" };

test("Bybit private account snapshot requires the master execution token", async () => {
  const response = await handleBybitAccount(new Request("https://eti.test/api/bybit/account"), env, {
    fetchImpl: async () => { throw new Error("must not call Bybit without authorization"); },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json() as any).error, "master_token_required");
});

test("Bybit account route is GET-only and exposes no order mutation endpoint", async () => {
  const post = await handleBybitAccount(new Request("https://eti.test/api/bybit/account", { method: "POST" }), env);
  assert.equal(post.status, 405);
  const unknown = await handleBybitAccount(new Request("https://eti.test/api/bybit/order", { headers: { authorization: "Bearer master-token" } }), env);
  assert.equal(unknown.status, 404);
});

test("authorized Bybit snapshot reads wallet and positions from the selected testnet host", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input); seen.push(url);
    const result = url.includes("wallet-balance")
      ? { list: [{ totalEquity: "1234.50", totalAvailableBalance: "900.25", coin: [{ coin: "USDT", walletBalance: "900.25", usdValue: "900.25" }] }] }
      : { list: [] };
    return new Response(JSON.stringify({ retCode: 0, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await handleBybitAccount(new Request("https://eti.test/api/bybit/account", { headers: { authorization: "Bearer master-token" } }), env, { fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.venue, "bybit");
  assert.equal(body.status, "connected");
  assert.equal(body.equityUsd, 1234.5);
  assert.equal(body.availableUsd, 900.25);
  assert.equal(body.permissions.readOnlySnapshot, true);
  assert.equal(body.permissions.orders, false);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(url => url.startsWith("https://api-testnet.bybit.com/")));
});

test("Bybit wrapper passes unrelated paths through unchanged", async () => {
  const response = new Response("pass-through");
  const app = withBybitAccount({ fetch: () => response });
  assert.equal(await app.fetch(new Request("https://eti.test/api/other"), env), response);
});

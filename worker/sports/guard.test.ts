import { test } from "node:test";
import assert from "node:assert/strict";
import { withSportsGuard, constantTimeEqual, resetSportsGuardCache } from "./guard.ts";

const env = { ETI_SPORTS_PAPER_TOKEN: "secret-token" } as any;
const json = (status = 200) => new Response(JSON.stringify({ ok: status === 200 }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

test("constantTimeEqual compares values and lengths", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("a wrong paper token is rejected before the route runs", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const app = withSportsGuard({ fetch: () => { calls++; return json(); } } as any);
  const r = await app.fetch(new Request("https://eti.test/api/sports/bets", { headers: { "x-eti-sports-token": "nope" } }), env);
  assert.equal(r.status, 401);
  assert.equal(calls, 0);
});

test("a correct token and a missing token are both delegated to the route", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const app = withSportsGuard({ fetch: () => { calls++; return json(); } } as any);
  await app.fetch(new Request("https://eti.test/api/sports/bets", { headers: { "x-eti-sports-token": "secret-token" } }), env);
  await app.fetch(new Request("https://eti.test/api/sports/bets"), env);
  assert.equal(calls, 2);
});

test("non-sports routes are delegated unchanged", async () => {
  resetSportsGuardCache();
  const app = withSportsGuard({ fetch: () => new Response("base") } as any);
  const r = await app.fetch(new Request("https://eti.test/market"), env);
  assert.equal(await r.text(), "base");
});

test("public football scans are cached and invalidated by a successful mutation", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const app = withSportsGuard({ fetch: () => { calls++; return json(); } } as any);
  const url = "https://eti.test/api/sports/football/next?limit=3";
  const first = await app.fetch(new Request(url), env);
  const second = await app.fetch(new Request(url), env);
  assert.equal(calls, 1);
  assert.equal(first.headers.get("x-eti-cache"), "miss");
  assert.equal(second.headers.get("x-eti-cache"), "hit");
  assert.equal(await first.text(), await second.text());
  await app.fetch(new Request("https://eti.test/api/sports/football/sync-history", { method: "POST", headers: { "x-eti-sports-token": "secret-token" }, body: "{}" }), env);
  await app.fetch(new Request(url), env);
  assert.equal(calls, 3);
});

test("concurrent identical scans share one provider call", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const app = withSportsGuard({ fetch: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return json(); } } as any);
  const url = "https://eti.test/api/sports/football/next?limit=5";
  const results = await Promise.all([app.fetch(new Request(url), env), app.fetch(new Request(url), env), app.fetch(new Request(url), env)]);
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.status === 200));
});

test("failed scans and automatic scans are never cached", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const failing = withSportsGuard({ fetch: () => { calls++; return json(503); } } as any);
  await failing.fetch(new Request("https://eti.test/api/sports/football/next?limit=2"), env);
  await failing.fetch(new Request("https://eti.test/api/sports/football/next?limit=2"), env);
  assert.equal(calls, 2);
  resetSportsGuardCache();
  calls = 0;
  const ok = withSportsGuard({ fetch: () => { calls++; return json(); } } as any);
  const headers = { "x-eti-sports-token": "secret-token" };
  await ok.fetch(new Request("https://eti.test/api/sports/football/next?limit=2&automatic=1", { headers }), env);
  await ok.fetch(new Request("https://eti.test/api/sports/football/next?limit=2&automatic=1", { headers }), env);
  assert.equal(calls, 2);
});

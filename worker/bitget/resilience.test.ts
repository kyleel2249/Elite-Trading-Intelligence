import { test } from "node:test";
import assert from "node:assert/strict";
import { bitgetGetSigned, bitgetSign, syncClock, getClockOffset, _resetClock, BITGET_ERROR_HINTS } from "./api.ts";

const env = { BITGET_API_KEY: "k", BITGET_API_SECRET: "s", BITGET_API_PASSPHRASE: "p" };
const ok = (data: unknown) => new Response(JSON.stringify({ code: "00000", msg: "success", data }));
const fail = (code: string, msg = "x", status = 400) => new Response(JSON.stringify({ code, msg }), { status });
const noSleep = async () => {};
test.beforeEach(() => _resetClock());

test("a timestamp rejection resynchronises from Bitget's clock and retries once with a corrected, correctly signed timestamp", async () => {
  const stamps: string[] = []; let local = 1_000_000;
  const fetchImpl: any = async (url: string, init: any) => {
    if (String(url).endsWith("/api/v2/public/time")) return ok({ serverTime: String(local + 60_000) });
    stamps.push(init.headers["ACCESS-TIMESTAMP"]);
    if (stamps.length === 1) return fail("40008", "Request timestamp expired");
    const expected = await bitgetSign("s", init.headers["ACCESS-TIMESTAMP"], "GET", "/api/v2/spot/account/assets", "");
    assert.equal(init.headers["ACCESS-SIGN"], expected);
    return ok([{ coin: "USDT" }]);
  };
  const data = await bitgetGetSigned(env, "/api/v2/spot/account/assets", {}, { fetchImpl, now: () => local, sleep: noSleep });
  assert.deepEqual(data, [{ coin: "USDT" }]);
  assert.equal(stamps.length, 2);
  assert.ok(Math.abs(Number(stamps[1]) - Number(stamps[0]) - 60_000) < 5);
  assert.ok(Math.abs(getClockOffset().offsetMs - 60_000) < 5);
});

test("transient failures (429, network error, 40010) are retried with backoff and then succeed", async () => {
  const script = [() => fail("429", "Too Many Requests", 429), () => { throw new TypeError("net"); }, () => fail("40010", "timeout", 400), () => ok({ done: true })];
  let i = 0; const sleeps: number[] = [];
  // 4 attempts would exceed the cap of 3, so verify the cap: the 4th scripted response is never reached.
  const fetchImpl: any = async () => script[i++]();
  await assert.rejects(bitgetGetSigned(env, "/api/v2/spot/account/assets", {}, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } }), (e: any) => e.code === "bitget_40010");
  assert.equal(i, 3); assert.equal(sleeps.length, 2);
  i = 3; assert.deepEqual(await bitgetGetSigned(env, "/api/v2/spot/account/assets", {}, { fetchImpl, sleep: noSleep }), { done: true });
});

test("authentication and permission errors are never retried and carry an explanation", async () => {
  for (const [code, needle] of [["40009", "Signature"], ["40014", "permission"], ["40018", "whitelist"], ["40012", "passphrase"]] as const) {
    let calls = 0;
    const fetchImpl: any = async () => { calls++; return fail(code); };
    await assert.rejects(bitgetGetSigned(env, "/api/v2/spot/account/assets", {}, { fetchImpl, sleep: noSleep }), (e: any) => e.code === "bitget_" + code && new RegExp(needle, "i").test(e.hint));
    assert.equal(calls, 1);
  }
  assert.ok(BITGET_ERROR_HINTS["40018"] && !BITGET_ERROR_HINTS["40019"]);
});

test("syncClock reports failure without changing the offset when Bitget is unreachable", async () => {
  const r = await syncClock({ fetchImpl: (async () => { throw new TypeError("x"); }) as any });
  assert.equal(r.ok, false); assert.equal(getClockOffset().offsetMs, 0);
});

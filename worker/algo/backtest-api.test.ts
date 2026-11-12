import test from "node:test";
import assert from "node:assert/strict";
import { handleAlgoBacktest } from "./backtest-api.ts";
import { withAlgo } from "./route.ts";
import { regimeSeries } from "./fixtures.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
function mock(seedBySymbol: Record<string, number>) {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input)), sym = u.searchParams.get("symbol") || "", seed = seedBySymbol[sym];
    if (seed === undefined) return new Response("no", { status: 500 });
    const rows = regimeSeries(1000, { seed, end: Date.now() }).map(r => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5])]);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

test("backtest endpoint validates parameters and method", async () => {
  for (const q of ["symbol=BAD%20X", "interval=2h", "feeBps=-1", "slippageBps=500", "markets=ok,ok,ok,bad%20x"]) assert.equal((await handleAlgoBacktest(new Request("https://eti.test/api/algo/backtest?" + q), {})).status, 400, q);
  assert.equal((await handleAlgoBacktest(new Request("https://eti.test/api/algo/backtest", { method: "POST" }), {})).status, 404);
});

test("backtest endpoint runs the 144+ combination lab on fetched candles and labels results backtested-only", async () => {
  mock({ BTCUSDT: 3, ETHUSDT: 8, SOLUSDT: 12 });
  const res = await handleAlgoBacktest(new Request("https://eti.test/api/algo/backtest?symbol=BTCUSDT&interval=1h&markets=ETHUSDT,SOLUSDT"), {});
  assert.equal(res.status, 200);
  const j = await res.json() as any;
  assert.ok(j.report.combinationsEvaluated >= 144); assert.equal(j.report.crossMarket.length, 2); assert.equal(j.performanceLabel, "backtested_only");
  assert.equal(j.report.costs.feeBps, 10); assert.match(j.note, /paper-trading and verified live/i);
  // The screen can nominate parameters but can never validate the live engines.
  assert.equal(j.validatedExpectancy, null); assert.equal(j.scope, "parametric_screen_with_simplified_rules"); assert.match(j.validationSource, /replay/i);
});

test("backtest endpoint reports a failed extra market without hiding it, and 503s when the primary market is unavailable", async () => {
  mock({ BTCUSDT: 3 });
  const j = await (await handleAlgoBacktest(new Request("https://eti.test/api/algo/backtest?symbol=BTCUSDT&markets=ETHUSDT"), {})).json() as any;
  assert.ok(j.failures.ETHUSDT); assert.equal(j.report.crossMarket.length, 0);
  mock({});
  assert.equal((await handleAlgoBacktest(new Request("https://eti.test/api/algo/backtest?symbol=BTCUSDT"), {})).status, 503);
});

test("router serves the backtest route and still delegates other routes untouched", async () => {
  const app = withAlgo({ fetch: async () => new Response("base") });
  assert.equal((await app.fetch(new Request("https://eti.test/api/algo/backtest?symbol=BAD%20X"), {})).status, 400);
  assert.equal(await (await app.fetch(new Request("https://eti.test/api/signals"), {})).text(), "base");
});

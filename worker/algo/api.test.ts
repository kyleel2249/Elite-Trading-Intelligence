import test from "node:test";
import assert from "node:assert/strict";
import { handleAlgoSignal } from "./api.ts";
import { handleOmnisignal } from "./omni-api.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const STEP: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };

function mockExchange(opts: { depth?: boolean } = {}) {
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.includes("depth")) {
      if (opts.depth === false) return new Response("{}", { status: 500 });
      const bids = Array.from({ length: 20 }, (_, i) => [String(100 - 0.01 - i * 0.05), "20"]), asks = Array.from({ length: 20 }, (_, i) => [String(100 + 0.01 + i * 0.05), "10"]);
      return new Response(JSON.stringify({ lastUpdateId: 1, bids, asks }), { status: 200 });
    }
    const step = (STEP[u.searchParams.get("interval") || "1h"] || 3600) * 1000, now = Date.now();
    const rows = Array.from({ length: 300 }, (_, i) => { const c = 50 + i * 0.3; const o = c - 0.1; return [now - (299 - i) * step, String(o), String(c + 0.2), String(o - 0.2), String(c), String(100 + (i % 5) * 10)]; });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

test("algo endpoint validates input and only accepts GET", async () => {
  assert.equal((await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?symbol=BAD%20X"), {})).status, 400);
  assert.equal((await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?strategy=yolo"), {})).status, 400);
  assert.equal((await handleAlgoSignal(new Request("https://eti.test/api/algo/signal", { method: "POST" }), {})).status, 404);
});

test("algo endpoint returns a full signal from live-shaped exchange data and discloses its data-quality limits", async () => {
  mockExchange();
  const res = await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?symbol=BTCUSDT&strategy=swing"), {});
  assert.equal(res.status, 200);
  const s = await res.json() as any;
  assert.equal(s.strategy, "swing"); assert.ok(["BUY", "SELL", "HOLD"].includes(s.action));
  assert.ok(["HIGH_CONVICTION", "CONFIRMED", "EARLY", "HOLD", "REJECTED"].includes(s.classification));
  assert.ok(s.consensus === null || s.consensus.executionEligible === false);
  assert.equal(s.dataQuality.providerCrossCheck, "not_performed"); assert.ok(s.dataQuality.timeframesLoaded.includes("1d"));
  assert.ok(s.liquidity && s.liquidity.status); assert.equal(s.submitsOrder, false); assert.equal(s.liveExecutionAllowed, false);
});

test("algo endpoint degrades (not fabricates) when the order book is unavailable", async () => {
  mockExchange({ depth: false });
  const s = await (await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?symbol=BTCUSDT&strategy=intraday"), {})).json() as any;
  assert.equal(s.dataQuality.orderBook, "unavailable"); assert.equal(s.liveExecutionAllowed, false); assert.notEqual(s.action, "BUY"); assert.notEqual(s.action, "SELL");
});

test("algo endpoint returns 503 DATA_UNRELIABLE when execution-timeframe data cannot be fetched", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const res = await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?symbol=BTCUSDT"), {});
  assert.equal(res.status, 503); assert.equal(((await res.json()) as any).decision, "DATA_UNRELIABLE");
});

test("single signal path: /api/algo/signal and /api/omnisignal return the same decision and trade plan for the same data", async () => {
  mockExchange();
  for (const q of ["strategy=intraday", "strategy=swing", "strategy=scalp&engines=swift"]) {
    const a = await (await handleAlgoSignal(new Request(`https://eti.test/api/algo/signal?symbol=BTCUSDT&${q}`), {})).json() as any;
    const b = await (await handleOmnisignal(new Request(`https://eti.test/api/omnisignal?symbol=BTCUSDT&${q}`), {})).json() as any;
    assert.equal(a.decision, b.decision, q); assert.deepEqual(a.stopLoss, b.stopLoss, q); assert.deepEqual(a.takeProfits, b.takeProfits, q); assert.equal(a.fusion.direction, b.fusion.direction, q);
    assert.equal(a.action, a.decision === "BUY" || a.decision === "SELL" ? a.decision : "HOLD");
  }
});

test("engines parameter is honoured and validated", async () => {
  mockExchange();
  const s = await (await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?symbol=BTCUSDT&strategy=intraday&engines=swift"), {})).json() as any;
  assert.equal(s.fusion.gainz.status, "NEUTRAL"); assert.match(s.fusion.gainz.evidence.join(" "), /disabled/i);
  assert.equal((await handleAlgoSignal(new Request("https://eti.test/api/algo/signal?engines=magic"), {})).status, 400);
});

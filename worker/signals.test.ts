import test from "node:test";
import assert from "node:assert/strict";
import { handleSignals } from "./signals.ts";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("signal endpoint rejects malformed symbols and unsupported intervals", async () => {
  const a = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTC%20USDT"), {});
  const b = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=7m"), {});
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
});

test("signal endpoint calculates market-derived BUY, ATR risk levels and attribution", async () => {
  const now = Date.now();
  const candles = Array.from({ length: 500 }, (_, i) => {
    const close = 100 + i * 0.8 + (i === 499 ? 3 : 0);
    const open = close - 0.25;
    return [now - (499 - i) * 3600000, String(open), String(close + 1.2), String(open - 0.5), String(close), String(i === 499 ? 5000 : 100 + (i % 7) * 25)];
  });
  globalThis.fetch = (async () => new Response(JSON.stringify(candles), { status: 200 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h"), {});
  assert.equal(res.status, 200);
  const signal = await res.json() as any;
  assert.equal(signal.action, "BUY");
  assert.ok(signal.entry > 0);
  assert.ok(signal.stopLoss < signal.entry);
  assert.equal(signal.targets.length, 3);
  assert.ok(signal.targets[0].price > signal.entry);
  assert.ok(signal.targets[2].price > signal.targets[1].price);
  assert.equal(signal.confidenceType, "heuristic_score_not_probability");
  assert.ok(signal.strategyAttribution.some((x: any) => x.trader.includes("Dennis")));
  assert.ok(signal.historicalValidation.sampleCount >= 0);
  if (signal.historicalValidation.sampleCount < 20) assert.equal(signal.historicalValidation.winRate, null);
});

test("signal endpoint fails closed when upstream market data is unavailable", async () => {
  globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h"), {});
  assert.equal(res.status, 503);
});

function series(fn: (i: number) => number, n = 500) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const close = fn(i), open = fn(i) - (i % 2 ? 0.1 : -0.1);
    return [now - (n - 1 - i) * 3600000, String(open), String(Math.max(open, close) + 0.5), String(Math.min(open, close) - 0.5), String(close), String(100 + (i % 5) * 10)];
  });
}
async function signalFor(candles: unknown[]) {
  globalThis.fetch = (async () => new Response(JSON.stringify(candles), { status: 200 })) as typeof fetch;
  const res = await handleSignals(new Request("https://eti.test/api/signals?symbol=BTCUSDT&interval=1h"), {});
  assert.equal(res.status, 200);
  return await res.json() as any;
}

test("downtrend is labelled SELL with stop above entry and three descending targets", async () => {
  const s = await signalFor(series(i => 500 - i * 0.8));
  assert.equal(s.label, "SELL");
  assert.equal(s.action, "SELL");
  assert.ok(s.stopLoss > s.entry);
  assert.ok(s.targets[0].price < s.entry && s.targets[2].price < s.targets[1].price);
});

test("a choppy chart still gets BUY or SELL, honestly marked low conviction and not tradeable", async () => {
  const s = await signalFor(series(i => 100 + Math.sin(i / 3) * 2));
  assert.ok(s.label === "BUY" || s.label === "SELL");
  assert.equal(s.action, s.label);
  assert.ok(s.entry > 0 && s.stopLoss > 0 && s.targets.length === 3);
  if (s.gatedAction === "WAIT") { assert.notEqual(s.conviction, "high"); assert.equal(s.tradeable, false); }
  assert.match(s.historicalValidation.note, /conviction/i);
  if (s.historicalValidation.sampleCount < 20) assert.equal(s.historicalValidation.winRate, null);
});

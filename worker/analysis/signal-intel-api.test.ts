import test from "node:test";
import assert from "node:assert/strict";
import { handleAnalysis } from "./api.ts";

function candles(n: number, step = 3600e3) {
  let x = 11, p = 100; const end = Math.floor(Date.now() / step) * step - step, out: number[][] = [];
  const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
  for (let i = 0; i < n; i++) { const o = p, c = p * (1 + 0.0015 + rnd() * 0.01); out.push([end - (n - 1 - i) * step, o, Math.max(o, c) * 1.003, Math.min(o, c) * 0.997, c, 1000 + 400 * Math.abs(rnd())]); p = c; }
  return out;
}
const post = (qs: string, body: unknown) => handleAnalysis(new Request(`https://eti.test/api/analysis/signal-intel${qs}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {} as any);

test("signal-intel POST returns a fused, read-only analysis", async () => {
  const res = await post("?symbol=BTCUSDT", { symbol: "BTCUSDT", timeframe: "1h", candles: candles(500) }), b: any = await res.json();
  assert.equal(res.status, 200);
  assert.equal(b.schema, "eti.signal-intel/1");
  assert.equal(b.submitsOrder, false); assert.equal(b.liveExecutionAllowed, false); assert.equal(b.canTriggerTrade, false);
  assert.ok(Array.isArray(b.votes) && b.votes.length > 8); assert.ok(Array.isArray(b.filters));
  assert.ok(b.chart.ichimoku.cloud.length > 0);
  assert.ok(b.derivatives.liquidationNote);
});
test("signal-intel validates timeframe and candles and appears in the endpoint index", async () => {
  assert.equal((await post("?symbol=BTCUSDT", { timeframe: "7h", candles: candles(200) })).status, 400);
  assert.equal((await post("?symbol=BTCUSDT", { timeframe: "1h", candles: [[1, 2]] })).status, 400);
  const idx: any = await (await handleAnalysis(new Request("https://eti.test/api/analysis"), {} as any)).json();
  assert.ok(idx.endpoints.includes("/api/analysis/signal-intel"));
});
test("signal-intel GET with no exchange access fails closed instead of inventing data", async () => {
  const orig = globalThis.fetch; globalThis.fetch = (async () => { throw new Error("offline"); }) as any;
  try { const res = await handleAnalysis(new Request("https://eti.test/api/analysis/signal-intel?symbol=BTCUSDT&timeframe=1h"), {} as any); assert.equal(res.status, 424); }
  finally { globalThis.fetch = orig; }
});

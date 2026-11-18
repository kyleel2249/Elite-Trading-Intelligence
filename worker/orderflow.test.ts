import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderFlow, normalizeDepth, normalizeTrades, recordDepthSnapshot, summarizeDepthHistory, type DepthHistoryStore } from "./analysis/orderflow.ts";

const depth = { bids: [[99, 10], [98, 20]] as [number, number][], asks: [[101, 8], [102, 15]] as [number, number][] };
const trades = [
  { time: 1000, price: 100, qty: 2, isBuyerMaker: false },
  { time: 2000, price: 100, qty: 1, isBuyerMaker: true },
  { time: 3000, price: 101, qty: 4, isBuyerMaker: false },
  { time: 4000, price: 101, qty: 1, isBuyerMaker: true }
];

test("order-flow validation rejects crossed books and malformed trade rows", () => {
  assert.equal(normalizeDepth({ bids: [[101, 1]], asks: [[100, 1]] }), null);
  assert.equal(normalizeTrades([{ time: 1, price: 1, qty: 1, isBuyerMaker: "false" }]), null);
  assert.equal(normalizeDepth(depth)?.bids[0][0], 99);
  assert.equal(normalizeTrades(trades)?.length, 4);
});

test("footprint uses aggressor-side semantics and produces deterministic delta/CVD", () => {
  const result = buildOrderFlow({ symbol: "BTCUSDT", venue: "bybit", market: "spot", provider: "bybit", trades, depth, bucketSize: 1, now: 5000 });
  assert.equal(result.tape.buyVolume, 6);
  assert.equal(result.tape.sellVolume, 2);
  assert.equal(result.tape.delta, 4);
  assert.equal(result.tape.deltaPct, 50);
  assert.equal(result.tape.cumulativeDelta, 4);
  assert.equal(result.footprint.length, 2);
  assert.equal(result.submitsOrder, false);
});

test("depth metrics calculate spread, notional imbalance and microprice", () => {
  const result = buildOrderFlow({ symbol: "BTCUSDT", venue: "bitget", market: "futures", provider: "bitget", trades, depth, bucketSize: 1, now: 5000 });
  assert.equal(result.depth.spread, 2);
  assert.equal(result.depth.mid, 100);
  assert.ok(result.depth.imbalance > 0);
  assert.ok(result.depth.microprice > 99 && result.depth.microprice < 101);
});

test("depth history stores bounded timestamped snapshots and summarizes persistence", async () => {
  let value: string | null = null;
  const store: DepthHistoryStore = {
    async get() { return value; },
    async put(_key, next) { value = next; }
  };
  const first = await recordDepthSnapshot(store, { symbol: "BTCUSDT", venue: "bybit", market: "spot", depth, now: 10000, bucketSize: 1 });
  const second = await recordDepthSnapshot(store, { symbol: "BTCUSDT", venue: "bybit", market: "spot", depth, now: 16000, bucketSize: 1 });
  assert.equal(first?.length, 1);
  assert.equal(second?.length, 2);
  const summary = summarizeDepthHistory(second!, 1);
  assert.equal(summary.bids[0].persistencePct, 100);
  assert.equal(summary.asks[0].persistencePct, 100);
});

test("missing KV leaves history unavailable without failing current order-flow analysis", async () => {
  assert.equal(await recordDepthSnapshot(undefined, { symbol: "BTCUSDT", venue: "bybit", market: "spot", depth, now: 10000, bucketSize: 1 }), null);
});

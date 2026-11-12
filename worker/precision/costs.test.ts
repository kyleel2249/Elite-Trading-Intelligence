import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLiquidity } from "../algo/liquidity.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { estimateCosts, netRewardRisk, walkBook } from "./costs.ts";
import { NOW, depthAround } from "./testkit.ts";

test("walkBook computes the volume-weighted fill by hand-checkable arithmetic", () => {
  // 100 @ 1 unit (100 quote), then 101 @ 1 unit (101 quote). Buying 150 quote: 100 at 100, then 50 at 101.
  const w = walkBook([[100, 1], [101, 1]], 150)!;
  const base = 100 / 100 + 50 / 101;
  assert.ok(Math.abs(w.vwap - 150 / base) < 1e-9);
  assert.equal(w.best, 100);
  assert.ok(Math.abs(w.slippageBps - Math.abs(w.vwap - 100) / 100 * 1e4) < 1e-9);
  assert.equal(walkBook([[100, 1], [101, 1]], 100)!.slippageBps, 0, "an order inside the best level has no slippage");
});

test("walkBook never extrapolates past the visible book and ignores invalid levels", () => {
  assert.equal(walkBook([[100, 1]], 500), null);
  assert.equal(walkBook([], 10), null);
  assert.equal(walkBook([[100, 1]], 0), null);
  assert.equal(walkBook([[NaN, 1], [-5, 2], [100, 0], [100, 1]], 50)!.vwap, 100);
});

test("net reward-to-risk charges costs to both sides and is always below gross", () => {
  // reward 3, stop 1, costs 0.2: a winner nets 2.8, a loser loses 1.2.
  assert.equal(netRewardRisk(3, 1, 0.2), Number((2.8 / 1.2).toFixed(2)));
  assert.ok(netRewardRisk(3, 1, 0.2) < 3);
  assert.equal(netRewardRisk(3, 1, 0), 3);
  assert.ok(netRewardRisk(0.1, 1, 0.2) < 0, "costs larger than the reward make the trade negative");
  assert.equal(netRewardRisk(1, 0, 0), 0);
});

test("costs come from the order book when it can be used, and say so", () => {
  const depth = depthAround(100);
  const liq = analyzeLiquidity(depth, 100, NOW);
  const c = estimateCosts({ entry: 100, direction: 1, stopDistance: 1, quote: "USDT", depth, liquidity: liq, cfg: DEFAULT_CONFIG.costs });
  assert.equal(c.slippageSource, "order_book_walk");
  assert.equal(c.spreadSource, "order_book");
  assert.ok(c.spreadBps !== null && c.spreadBps > 0);
  // 2 sides of fees + spread + entry and exit slippage, nothing hidden.
  const expected = 2 * c.feeBpsPerSide + (c.spreadBps as number) + c.slippageBpsPerSide.entry + c.slippageBpsPerSide.exit;
  assert.ok(Math.abs(c.roundTripBps - expected) < 0.05);
  assert.ok(Math.abs(c.roundTripPrice - 100 * c.roundTripBps / 1e4) < 1e-4);
  assert.ok(Math.abs(c.costInR - c.roundTripPrice / 1) < 0.001);
  assert.ok(c.excludes.some(e => /funding/.test(e)));
});

test("costs fall back to a labelled assumption without a usable book or for a non-USD quote", () => {
  const none = estimateCosts({ entry: 100, direction: -1, stopDistance: 1, quote: "USDT", depth: null, liquidity: null, cfg: DEFAULT_CONFIG.costs });
  assert.equal(none.slippageSource, "assumed");
  assert.equal(none.spreadBps, null);
  assert.equal(none.spreadSource, "unavailable");
  assert.equal(none.roundTripBps, 2 * DEFAULT_CONFIG.costs.takerFeeBps + 2 * DEFAULT_CONFIG.costs.assumedSlippageBps);
  assert.match(none.note, /assumed/);

  const depth = depthAround(100);
  const btcQuoted = estimateCosts({ entry: 100, direction: 1, stopDistance: 1, quote: "BTC", depth, liquidity: analyzeLiquidity(depth, 100, NOW), cfg: DEFAULT_CONFIG.costs });
  assert.equal(btcQuoted.slippageSource, "assumed", "a USD notional cannot be walked against a BTC-quoted book");

  // Thin book: the reference order cannot be absorbed, so slippage is assumed rather than extrapolated.
  const thin = { bids: depth.bids.slice(0, 5).map(([p]) => [p, 0.001] as [number, number]), asks: depth.asks.slice(0, 5).map(([p]) => [p, 0.001] as [number, number]), timestamp: NOW };
  const t = estimateCosts({ entry: 100, direction: 1, stopDistance: 1, quote: "USDT", depth: thin, liquidity: analyzeLiquidity(thin, 100, NOW), cfg: DEFAULT_CONFIG.costs });
  assert.equal(t.slippageSource, "assumed");
});

test("a zero stop distance yields an explicit worst-case cost-in-R rather than Infinity or NaN", () => {
  const c = estimateCosts({ entry: 100, direction: 1, stopDistance: 0, quote: "USDT", depth: null, liquidity: null, cfg: DEFAULT_CONFIG.costs });
  assert.equal(c.costInR, 999);
  assert.ok(Number.isFinite(c.costInR));
});

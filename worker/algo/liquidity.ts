// Order-book and liquidity intelligence. Visible resting liquidity is NOT guaranteed executable liquidity.
export interface DepthSnapshot { bids: [number, number][]; asks: [number, number][]; timestamp: number }
export interface LargeOrder { side: "bid" | "ask"; price: number; notional: number; distancePct: number }
export interface LiquidityAnalysis {
  status: "ok" | "degraded" | "blocked"; issues: string[]; spreadBps: number | null; imbalance: number | null; bidDepth: number; askDepth: number;
  largeOrders: LargeOrder[]; ageMs: number; depthRatioVsPrev: number | null; deteriorating: boolean; bestBid: number | null; bestAsk: number | null;
  caveat: string;
}
export interface LiquidityOptions { maxAgeMs?: number; maxSpreadBps?: number; bandPct?: number; minLevels?: number; wallMultiple?: number; prev?: LiquidityAnalysis | null }
const CAVEAT = "Visible resting orders can be cancelled before they fill; this is not guaranteed executable liquidity.";

export function analyzeLiquidity(depth: DepthSnapshot | null | undefined, price: number, now: number, o: LiquidityOptions = {}): LiquidityAnalysis {
  const { maxAgeMs = 5000, maxSpreadBps = 15, bandPct = 0.005, minLevels = 5, wallMultiple = 5, prev = null } = o;
  const empty = (status: "blocked", issue: string): LiquidityAnalysis => ({ status, issues: [issue], spreadBps: null, imbalance: null, bidDepth: 0, askDepth: 0, largeOrders: [], ageMs: Infinity, depthRatioVsPrev: null, deteriorating: false, bestBid: null, bestAsk: null, caveat: CAVEAT });
  if (!depth) return empty("blocked", "Order book unavailable");
  const issues: string[] = [];
  const valid = (l: [number, number][]) => l.filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[0] > 0 && x[1] > 0);
  const bids = valid(depth.bids).sort((a, b) => b[0] - a[0]), asks = valid(depth.asks).sort((a, b) => a[0] - b[0]);
  if (bids.length !== depth.bids.length || asks.length !== depth.asks.length) issues.push("Order book contained invalid levels that were discarded");
  if (bids.length < minLevels || asks.length < minLevels) return { ...empty("blocked", `Incomplete order book (${bids.length} bids / ${asks.length} asks)`), ageMs: now - depth.timestamp };
  const bb = bids[0][0], ba = asks[0][0];
  if (bb >= ba) return { ...empty("blocked", "Crossed or locked order book (inconsistent data)"), ageMs: now - depth.timestamp, bestBid: bb, bestAsk: ba };
  const ageMs = now - depth.timestamp;
  let status: LiquidityAnalysis["status"] = "ok";
  if (ageMs > maxAgeMs || ageMs < -2000) { status = "blocked"; issues.push(`Order book is stale (${Math.round(ageMs)} ms old)`); }
  const mid = (bb + ba) / 2, spreadBps = (ba - bb) / mid * 1e4;
  if (Math.abs(mid - price) / price > 0.01) { status = "blocked"; issues.push("Order-book mid differs from last price by more than 1%: possible wrong-asset or stale data"); }
  if (spreadBps > maxSpreadBps) { if (status === "ok") status = "degraded"; issues.push(`Spread ${spreadBps.toFixed(1)} bps exceeds limit ${maxSpreadBps}`); }
  const inBand = (l: [number, number][], side: 1 | -1) => l.filter(x => side > 0 ? x[0] >= mid * (1 - bandPct) : x[0] <= mid * (1 + bandPct)).reduce((s, x) => s + x[0] * x[1], 0);
  const bidDepth = inBand(bids, 1), askDepth = inBand(asks, -1), tot = bidDepth + askDepth;
  const imbalance = tot > 0 ? (bidDepth - askDepth) / tot : 0;
  const notionals = [...bids, ...asks].map(x => x[0] * x[1]).sort((a, b) => a - b), med = notionals[Math.floor(notionals.length / 2)] || 0;
  const largeOrders: LargeOrder[] = [];
  for (const [side, l] of [["bid", bids], ["ask", asks]] as const) for (const [p, q] of l) if (med > 0 && p * q >= med * wallMultiple) largeOrders.push({ side, price: p, notional: p * q, distancePct: Math.abs(p - mid) / mid * 100 });
  largeOrders.sort((a, b) => b.notional - a.notional);
  const depthRatioVsPrev = prev && prev.bidDepth + prev.askDepth > 0 ? tot / (prev.bidDepth + prev.askDepth) : null;
  const deteriorating = depthRatioVsPrev !== null && depthRatioVsPrev < 0.5;
  if (deteriorating) { if (status === "ok") status = "degraded"; issues.push("Market depth fell by more than half versus the previous snapshot"); }
  return { status, issues, spreadBps, imbalance, bidDepth, askDepth, largeOrders: largeOrders.slice(0, 5), ageMs, depthRatioVsPrev, deteriorating, bestBid: bb, bestAsk: ba, caveat: CAVEAT };
}

/** Directional support from the order book, 0..100 (50 = neutral). */
export function liquidityForDirection(la: LiquidityAnalysis, dir: 1 | -1, maxSpreadBps = 15): { score: number; trapNearby: boolean; notes: string[] } {
  if (la.status === "blocked" || la.imbalance === null || la.spreadBps === null) return { score: 0, trapNearby: false, notes: la.issues };
  const notes: string[] = [];
  let score = 50 + la.imbalance * dir * 35 - Math.min(20, la.spreadBps / maxSpreadBps * 10);
  const opposing = la.largeOrders.filter(l => (dir > 0 ? l.side === "ask" : l.side === "bid") && l.distancePct <= 0.3);
  const trapNearby = opposing.length > 0;
  if (trapNearby) { score -= 20; notes.push(`Large ${dir > 0 ? "ask" : "bid"} wall within ${opposing[0].distancePct.toFixed(2)}% of price (possible liquidity trap or absorption)`); }
  const support = la.largeOrders.filter(l => (dir > 0 ? l.side === "bid" : l.side === "ask") && l.distancePct <= 0.5);
  if (support.length) { score += 5; notes.push("Large resting orders sit on the supportive side (may be cancelled)"); }
  if (la.status === "degraded") { score -= 10; notes.push(...la.issues); }
  return { score: Math.max(0, Math.min(100, score)), trapNearby, notes };
}

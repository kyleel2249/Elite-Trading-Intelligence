import type { Depth, Kline, Trade } from "../market.ts";

export interface DepthHistoryStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface DepthSnapshot {
  capturedAt: number;
  bids: [number, number][];
  asks: [number, number][];
}
export interface OrderFlowInput {
  symbol: string;
  venue: "bybit" | "bitget";
  market: "spot" | "futures";
  provider: string;
  trades: Trade[];
  depth: Depth;
  candles?: Kline[];
  bucketSize?: number;
  now?: number;
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round = (n: number, digits = 6) => Number(n.toFixed(digits));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function normalizeTrades(value: unknown): Trade[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) return null;
  const out: Trade[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const time = Number(row.time), price = Number(row.price), qty = Number(row.qty);
    if (![time, price, qty].every(Number.isFinite) || time <= 0 || price <= 0 || qty <= 0 || typeof row.isBuyerMaker !== "boolean") return null;
    out.push({ time, price, qty, isBuyerMaker: row.isBuyerMaker });
  }
  return out.sort((a, b) => a.time - b.time);
}
export function normalizeDepth(value: unknown): Depth | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.bids) || !Array.isArray(raw.asks) || raw.bids.length < 1 || raw.asks.length < 1 || raw.bids.length > 100 || raw.asks.length > 100) return null;
  const parse = (levels: unknown[]): [number, number][] | null => {
    const out: [number, number][] = [];
    for (const level of levels) {
      if (!Array.isArray(level) || level.length < 2) return null;
      const price = Number(level[0]), qty = Number(level[1]);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) return null;
      out.push([price, qty]);
    }
    return out;
  };
  const bids = parse(raw.bids), asks = parse(raw.asks);
  if (!bids || !asks) return null;
  bids.sort((a, b) => b[0] - a[0]); asks.sort((a, b) => a[0] - b[0]);
  if (bids[0][0] >= asks[0][0]) return null;
  return { bids, asks };
}
function defaultBucketSize(price: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)) - 4);
  return Math.max(Number.EPSILON, magnitude);
}
export function buildOrderFlow(input: OrderFlowInput) {
  const now = input.now ?? Date.now(), trades = normalizeTrades(input.trades), depth = normalizeDepth(input.depth);
  if (!trades || !depth) throw new Error("invalid_orderflow_input");
  const lastPrice = trades[trades.length - 1].price, bucketSize = input.bucketSize && finite(input.bucketSize) && input.bucketSize > 0 ? input.bucketSize : defaultBucketSize(lastPrice);
  const bins = new Map<number, { price: number; buyVolume: number; sellVolume: number; buyNotional: number; sellNotional: number; trades: number }>();
  let buyVolume = 0, sellVolume = 0, cumulativeDelta = 0, cumulativeBuy = 0, cumulativeSell = 0;
  const cvd: { time: number; value: number }[] = [];
  for (const trade of trades) {
    const key = round(Math.round(trade.price / bucketSize) * bucketSize, 12);
    const bin = bins.get(key) ?? { price: key, buyVolume: 0, sellVolume: 0, buyNotional: 0, sellNotional: 0, trades: 0 };
    const buyAggressor = !trade.isBuyerMaker;
    if (buyAggressor) { buyVolume += trade.qty; cumulativeBuy += trade.qty; bin.buyVolume += trade.qty; bin.buyNotional += trade.qty * trade.price; }
    else { sellVolume += trade.qty; cumulativeSell += trade.qty; bin.sellVolume += trade.qty; bin.sellNotional += trade.qty * trade.price; }
    bin.trades++; bins.set(key, bin); cumulativeDelta += buyAggressor ? trade.qty : -trade.qty;
    cvd.push({ time: trade.time, value: round(cumulativeDelta, 8) });
  }
  const footprint = [...bins.values()].map(bin => {
    const total = bin.buyVolume + bin.sellVolume, ratio = bin.sellVolume > 0 ? bin.buyVolume / bin.sellVolume : bin.buyVolume > 0 ? null : 1;
    const imbalance = (ratio === null && bin.buyVolume > 0) || (ratio !== null && ratio >= 3) ? "buy" : bin.buyVolume > 0 && (bin.sellVolume === 0 || (ratio !== null && ratio <= 1 / 3)) ? "sell" : "balanced";
    return { ...bin, totalVolume: round(total, 8), delta: round(bin.buyVolume - bin.sellVolume, 8), deltaPct: total ? round((bin.buyVolume - bin.sellVolume) / total * 100, 2) : 0, imbalance };
  }).sort((a, b) => a.price - b.price);
  const bestBid = depth.bids[0], bestAsk = depth.asks[0], mid = (bestBid[0] + bestAsk[0]) / 2;
  const bidNotional = depth.bids.slice(0, 10).reduce((s, x) => s + x[0] * x[1], 0), askNotional = depth.asks.slice(0, 10).reduce((s, x) => s + x[0] * x[1], 0);
  const topBidQty = depth.bids.slice(0, 10).reduce((s, x) => s + x[1], 0), topAskQty = depth.asks.slice(0, 10).reduce((s, x) => s + x[1], 0);
  const spreadBps = mid > 0 ? (bestAsk[0] - bestBid[0]) / mid * 10000 : 0;
  const depthImbalance = bidNotional + askNotional > 0 ? (bidNotional - askNotional) / (bidNotional + askNotional) : 0;
  const microprice = topBidQty + topAskQty > 0 ? (bestAsk[0] * topBidQty + bestBid[0] * topAskQty) / (topBidQty + topAskQty) : mid;
  const total = buyVolume + sellVolume, delta = buyVolume - sellVolume;
  const firstPrice = trades[0].price, priceChangePct = firstPrice ? (lastPrice / firstPrice - 1) * 100 : 0;
  const lastCandle = input.candles?.at(-1), candleRange = lastCandle ? lastCandle[2] - lastCandle[3] : 0;
  const candleBodyShare = lastCandle && candleRange > 0 ? Math.abs(lastCandle[4] - lastCandle[1]) / candleRange : null;
  const avgTradeVolume = total / Math.max(1, footprint.length);
  const pressure = Math.abs(delta) >= avgTradeVolume * 3 && total > 0;
  const absorptionCandidates = pressure && candleBodyShare !== null && candleBodyShare <= 0.2
    ? [{ direction: delta > 0 ? "buy_aggression" : "sell_aggression", classification: "possible_absorption", evidence: "Large net aggressive volume coincides with a small candle body; replenishment and queue-level evidence are unavailable.", confidence: "low" }]
    : [];
  const imbalanceLevels = footprint.filter(x => x.imbalance !== "balanced").slice(-30);
  return {
    schema: "eti.orderflow/1", symbol: input.symbol, venue: input.venue, market: input.market, provider: input.provider,
    generatedAt: new Date(now).toISOString(), bucketSize: round(bucketSize, 12),
    tape: { trades: trades.length, buyVolume: round(buyVolume, 8), sellVolume: round(sellVolume, 8), delta: round(delta, 8), deltaPct: total ? round(delta / total * 100, 2) : 0, cumulativeDelta: round(cumulativeDelta, 8), priceChangePct: round(priceChangePct, 5), cvd: cvd.filter((_, i) => i === 0 || i === cvd.length - 1 || i % Math.max(1, Math.floor(cvd.length / 80)) === 0) },
    footprint, imbalanceLevels,
    depth: { bestBid: bestBid[0], bestAsk: bestAsk[0], mid: round(mid, 12), spread: round(bestAsk[0] - bestBid[0], 12), spreadBps: round(spreadBps, 4), bidNotional: round(bidNotional, 4), askNotional: round(askNotional, 4), imbalance: round(depthImbalance, 5), microprice: round(microprice, 12), bids: depth.bids.slice(0, 20), asks: depth.asks.slice(0, 20) },
    absorptionCandidates, dataQuality: { tradeCount: trades.length, tradeAgeMs: Math.max(0, now - trades[trades.length - 1].time), depthLevels: { bids: depth.bids.length, asks: depth.asks.length }, candleContextAvailable: !!lastCandle, estimatedHistoricalCvd: false, notes: ["Aggressor side follows exchange isBuyerMaker semantics: buyer-maker means sell aggression.", "A single depth snapshot cannot prove absorption, spoofing, or institutional intent.", "Footprint bins are derived from the supplied public trade tape, not OHLCV volume allocation."] },
    submitsOrder: false, liveExecutionAllowed: false
  };
}
function historyKey(symbol: string, venue: string, market: string) {
  return "eti:depth-history:v1:" + venue + ":" + market + ":" + symbol;
}
export async function recordDepthSnapshot(store: DepthHistoryStore | undefined, input: { symbol: string; venue: string; market: string; depth: Depth; now: number; bucketSize: number }): Promise<DepthSnapshot[] | null> {
  if (!store) return null;
  const key = historyKey(input.symbol, input.venue, input.market);
  let rows: DepthSnapshot[] = [];
  try {
    const raw = await store.get(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) rows = parsed.filter((x): x is DepthSnapshot => x && finite(x.capturedAt) && Array.isArray(x.bids) && Array.isArray(x.asks)).slice(-71);
    }
    const last = rows.at(-1);
    if (!last || input.now - last.capturedAt >= 5000) {
      rows.push({ capturedAt: input.now, bids: input.depth.bids.slice(0, 20), asks: input.depth.asks.slice(0, 20) });
      rows = rows.slice(-72);
      await store.put(key, JSON.stringify(rows), { expirationTtl: 7 * 86400 });
    }
    return rows;
  } catch { return null; }
}
export function summarizeDepthHistory(rows: DepthSnapshot[], bucketSize: number) {
  if (!rows.length) return { bids: [], asks: [] };
  const summarize = (side: "bids" | "asks") => {
    const levels = new Map<number, { price: number; observations: number; maxQty: number; averageQty: number }>();
    for (const snap of rows) for (const [price, qty] of snap[side]) {
      const key = round(Math.round(price / bucketSize) * bucketSize, 12);
      const current = levels.get(key) ?? { price: key, observations: 0, maxQty: 0, averageQty: 0 };
      current.observations++; current.maxQty = Math.max(current.maxQty, qty); current.averageQty += qty; levels.set(key, current);
    }
    return [...levels.values()].map(x => ({ price: x.price, observations: x.observations, persistencePct: round(x.observations / rows.length * 100, 1), maxQty: round(x.maxQty, 8), averageQty: round(x.averageQty / x.observations, 8) })).filter(x => x.persistencePct >= 25).sort((a, b) => b.persistencePct * b.averageQty - a.persistencePct * a.averageQty).slice(0, 20);
  };
  return { bids: summarize("bids"), asks: summarize("asks") };
}

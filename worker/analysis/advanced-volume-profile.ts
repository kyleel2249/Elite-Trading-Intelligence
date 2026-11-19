import type { Kline } from "../market.ts";

export interface VolumePrint {
  time: number;
  price: number;
  qty: number;
  side?: "buy" | "sell" | "unknown";
  source?: string;
  id?: string;
}
export interface SwapVolumeEvent {
  time: number;
  price: number;
  baseQuantity?: number;
  quoteQuantity?: number;
  side?: "buy" | "sell" | "unknown";
  source?: string;
  txHash?: string;
  pool?: string;
}
export interface AdvancedProfileInput {
  symbol: string;
  candles?: Kline[];
  trades?: VolumePrint[];
  swaps?: SwapVolumeEvent[];
  bins?: number;
  valueAreaPct?: number;
  currentPrice?: number;
  now?: number;
  historicalPocs?: Array<{ price: number; formedAt: number; source?: string }>;
}
export interface AdvancedProfileNode {
  index: number;
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  deltaPct: number;
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number, d = 8) => Number(v.toFixed(d));

function profileFromBins(
  low: number, high: number, volumes: number[], buys: number[], sells: number[], valueAreaPct: number,
  currentPrice: number, method: string, eventCount: number
) {
  const count = volumes.length, step = (high - low) / count;
  let pocIndex = 0;
  for (let i = 1; i < count; i++) if (volumes[i] > volumes[pocIndex]) pocIndex = i;
  const totalVolume = volumes.reduce((sum, v) => sum + v, 0);
  let left = pocIndex, right = pocIndex, accumulated = volumes[pocIndex], target = totalVolume * valueAreaPct;
  while (accumulated < target && (left > 0 || right < count - 1)) {
    const lv = left > 0 ? volumes[left - 1] : -1;
    const rv = right < count - 1 ? volumes[right + 1] : -1;
    if (rv > lv || (rv === lv && right < count - 1 && (pocIndex - left) >= (right - pocIndex))) {
      right++; accumulated += volumes[right];
    } else if (left > 0) {
      left--; accumulated += volumes[left];
    } else {
      right++; accumulated += volumes[right];
    }
  }
  const priceAt = (i: number) => low + (i + 0.5) * step;
  const smoothed = volumes.map((v, i) => (v + (volumes[i - 1] ?? v) + (volumes[i + 1] ?? v)) / 3);
  const mean = totalVolume / count, hvn: number[] = [], lvn: number[] = [];
  for (let i = 1; i < count - 1; i++) {
    if (smoothed[i] > smoothed[i - 1] && smoothed[i] >= smoothed[i + 1] && smoothed[i] >= mean * 1.3) hvn.push(round(priceAt(i)));
    if (smoothed[i] < smoothed[i - 1] && smoothed[i] <= smoothed[i + 1] && smoothed[i] <= mean * 0.6) lvn.push(round(priceAt(i)));
  }
  const nodes: AdvancedProfileNode[] = volumes.map((volume, index) => {
    const buyVolume = buys[index], sellVolume = sells[index], delta = buyVolume - sellVolume;
    return { index, price: round(priceAt(index)), volume: round(volume), buyVolume: round(buyVolume), sellVolume: round(sellVolume), delta: round(delta), deltaPct: volume ? round(delta / volume * 100, 3) : 0 };
  });
  return {
    poc: round(priceAt(pocIndex)), pocIndex, vah: round(low + (right + 1) * step), val: round(low + left * step),
    low: round(low), high: round(high), totalVolume: round(totalVolume), hvn, lvn, bins: nodes,
    location: currentPrice > low + (right + 1) * step ? "above_value" : currentPrice < low + left * step ? "below_value" : "inside_value",
    distanceFromPocPct: currentPrice > 0 ? round((currentPrice - priceAt(pocIndex)) / currentPrice * 100, 4) : null,
    eventCount, method
  };
}

function addEvent(volumes: number[], buys: number[], sells: number[], low: number, step: number, price: number, qty: number, side: VolumePrint["side"]) {
  const index = clamp(Math.floor((price - low) / step), 0, volumes.length - 1);
  volumes[index] += qty;
  if (side === "buy") buys[index] += qty;
  else if (side === "sell") sells[index] += qty;
}

function sessionName(time: number): string {
  const hour = new Date(time).getUTCHours();
  if (hour >= 0 && hour < 8) return "asia";
  if (hour >= 7 && hour < 16) return "london";
  if (hour >= 13 && hour < 22) return "new_york";
  return "off_hours";
}

/** Exchange prints and decoded DEX swaps are price/volume events. Wallet transfers without a market price are deliberately excluded. */
export function buildAdvancedVolumeProfile(input: AdvancedProfileInput) {
  const now = input.now ?? Date.now(), candles = (input.candles ?? []).filter(r => r.every(finite));
  const trades = (input.trades ?? []).filter(t => finite(t.time) && finite(t.price) && finite(t.qty) && t.time > 0 && t.price > 0 && t.qty > 0);
  const swaps = (input.swaps ?? []).filter(s => finite(s.time) && finite(s.price) && s.time > 0 && s.price > 0 && (finite(s.baseQuantity) && s.baseQuantity > 0 || finite(s.quoteQuantity) && s.quoteQuantity > 0))
    .map(s => ({ time: s.time, price: s.price, qty: finite(s.baseQuantity) && s.baseQuantity! > 0 ? s.baseQuantity! : s.quoteQuantity! / s.price, side: s.side ?? "unknown" as const, source: s.source ?? "onchain_swap" }));
  const events: VolumePrint[] = [...trades, ...swaps].sort((a, b) => a.time - b.time);
  const lows = [...candles.map(r => r[3]), ...events.map(e => e.price)];
  const highs = [...candles.map(r => r[2]), ...events.map(e => e.price)];
  if (lows.length === 0) return { schema: "eti.volume-profile/2", symbol: input.symbol, status: "unavailable", reason: "No valid candle, exchange trade or decoded swap data was supplied.", poc: null, vah: null, val: null, sourceCoverage: { method: "unavailable" }, submitsOrder: false };
  let low = Math.min(...lows), high = Math.max(...highs);
  if (!(high > low)) { const pad = Math.max(high * 0.0005, 1e-8); low -= pad; high += pad; }
  const count = Math.round(clamp(input.bins ?? 64, 24, 200)), valueAreaPct = clamp(input.valueAreaPct ?? 0.7, 0.5, 0.9), step = (high - low) / count;
  const volumes = new Array(count).fill(0), buys = new Array(count).fill(0), sells = new Array(count).fill(0);
  const hasPrints = events.length > 0;
  if (hasPrints) {
    for (const event of events) addEvent(volumes, buys, sells, low, step, event.price, event.qty, event.side);
  } else {
    // OHLCV is a lower-fidelity fallback: each candle's volume is spread uniformly over its covered price rows.
    for (const row of candles) {
      const a = clamp(Math.floor((row[3] - low) / step), 0, count - 1), b = clamp(Math.floor((row[2] - low) / step), 0, count - 1);
      const per = row[5] / Math.max(1, b - a + 1);
      for (let i = a; i <= b; i++) volumes[i] += per;
    }
  }
  const currentPrice = finite(input.currentPrice) && input.currentPrice > 0 ? input.currentPrice : candles.at(-1)?.[4] ?? events.at(-1)?.price ?? 0;
  const method = hasPrints
    ? "Trade-level profile: each exchange print and decoded DEX swap is assigned to its execution-price row. Buy/sell delta is reported only where aggressor side is supplied."
    : "OHLCV approximation: each candle's volume is distributed evenly across the price rows covered by its high-low range; not tick-level execution volume.";
  const profile = profileFromBins(low, high, volumes, buys, sells, valueAreaPct, currentPrice, method, events.length);
  const developing: Array<{ time: number; poc: number; totalVolume: number }> = [];
  if (events.length) {
    const dv = new Array(count).fill(0), db = new Array(count).fill(0), ds = new Array(count).fill(0);
    const stride = Math.max(1, Math.floor(events.length / 40));
    events.forEach((event, i) => {
      addEvent(dv, db, ds, low, step, event.price, event.qty, event.side);
      if (i === events.length - 1 || i % stride === 0) {
        const part = profileFromBins(low, high, dv, db, ds, valueAreaPct, event.price, method, i + 1);
        developing.push({ time: event.time, poc: part.poc, totalVolume: part.totalVolume });
      }
    });
  }
  const sessions: Record<string, { volume: number; trades: number; buyVolume: number; sellVolume: number }> = {};
  for (const event of events) {
    const name = sessionName(event.time), s = sessions[name] ?? (sessions[name] = { volume: 0, trades: 0, buyVolume: 0, sellVolume: 0 });
    s.volume += event.qty; s.trades++;
    if (event.side === "buy") s.buyVolume += event.qty;
    if (event.side === "sell") s.sellVolume += event.qty;
  }
  const touchedHistoricalPocs = (input.historicalPocs ?? []).map(p => {
    const later = candles.filter(c => c[0] > p.formedAt);
    const touched = later.some(c => c[3] <= p.price && c[2] >= p.price);
    return { ...p, status: touched ? "revisited" : "naked" };
  });
  const totalPrintVolume = events.reduce((sum, e) => sum + e.qty, 0);
  const totalCandleVolume = candles.reduce((sum, c) => sum + c[5], 0);
  const sourceCounts: Record<string, number> = {};
  for (const e of events) sourceCounts[e.source ?? "exchange_or_supplied"] = (sourceCounts[e.source ?? "exchange_or_supplied"] ?? 0) + 1;
  return {
    schema: "eti.volume-profile/2", symbol: input.symbol, status: "ok", generatedAt: new Date(now).toISOString(),
    ...profile, valueAreaPct, currentPrice: round(currentPrice), developingPoc: developing.at(-1)?.poc ?? profile.poc,
    developingPocHistory: developing, sessions,
    historicalPocs: touchedHistoricalPocs,
    sourceCoverage: { eventCount: events.length, exchangeTradeCount: trades.length, decodedSwapCount: swaps.length, sourceCounts, candleCount: candles.length, candleVolume: round(totalCandleVolume), printVolume: round(totalPrintVolume), method: hasPrints ? "transaction_level" : "ohlcv_approximation" },
    limitations: [
      "Generic wallet transfers are not trading volume and are excluded unless decoded into a priced DEX swap with base or quote quantity.",
      "DEX swap coverage depends on the chain, pool, decoder and RPC/indexer feed supplied; this endpoint does not claim universal blockchain coverage.",
      "Cross-venue volumes are not automatically fungible: compare venue profiles separately before using a consolidated profile.",
      "Buy/sell delta is unknown when the source does not provide reliable aggressor-side classification.",
      "FX, equities and other financial instruments require a licensed or operator-connected transaction feed; supplied OHLCV remains an approximation."
    ],
    submitsOrder: false, liveExecutionAllowed: false
  };
}

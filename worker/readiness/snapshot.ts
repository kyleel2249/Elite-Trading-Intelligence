// Measured market conditions for the Readiness Engine. Pure functions over candles / order book supplied by the caller
// (api.ts fetches them). Nothing here fetches, guesses or fills gaps: absent input yields null, which the engine reports as "not evaluated".
import type { Kline } from "../market.ts";
import { analyzeLiquidity, type DepthSnapshot, type LiquidityAnalysis } from "../algo/liquidity.ts";
import { volatility, type VolClass } from "../algo/indicators.ts";
import { classifyRegime, type RegimeResult } from "../algo/regime.ts";
import { analyzeTimeframe, buildConsensus, marketStructure, TIMEFRAMES, type Strategy, type Timeframe, type TimeframeAnalysis } from "../algo/timeframes.ts";
import { buildSignal, type AlgoSignal } from "../algo/signal.ts";
import { HOUR, SESSION_DEFS, localTime, sessionActive, type SessionId, type Zone } from "./calendar.ts";

export const MIN_SESSION_INSTANCES = 10;
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const rangePct = (k: Kline) => ((k[2] - k[3]) / k[4]) * 100;

export interface SessionStat { session: SessionId; bars: number; instances: number; avgRangePct: number; rangeVsBaseline: number; volumeVsBaseline: number; efficiency: number | null; sampleOk: boolean }
export interface HourStat { hourUtc: number; bars: number; rangeVsBaseline: number; volumeVsBaseline: number }
export interface DayStat { dow: number; days: number; avgRangePct: number; rangeVsBaseline: number; volumeVsBaseline: number }
export interface HistoryStats { bars: number; days: number; /** False when the source supplies no volume: volume ratios are then 1 and must not be interpreted. */ volumeKnown: boolean; baselineRangePct: number; sessions: SessionStat[]; hours: HourStat[]; weekdays: DayStat[] }

/** Session / hour-of-day / weekday behaviour measured from closed hourly candles. Weekday-only for sessions and hours; weekends are reported separately. */
export function historyStats(hourly: Kline[], now: number, opts: { minBarsPerDay?: number; volumeKnown?: boolean } = {}): HistoryStats | null {
  const rows = hourly.filter(k => k[0] + HOUR <= now);
  if (rows.length < 24 * 14) return null;
  const wk = rows.filter(k => { const d = new Date(k[0]).getUTCDay(); return d >= 1 && d <= 5; });
  const baseRange = mean(wk.map(rangePct)), baseVol = mean(wk.map(k => k[5]));
  if (!(baseRange > 0) || !(baseVol > 0)) return null;
  const sessions: SessionStat[] = (["sydney", "asian", "london", "new_york", "london_ny_overlap"] as SessionId[]).map(id => {
    const zone: Zone = id === "london_ny_overlap" ? "America/New_York" : SESSION_DEFS[id].zone, inst = new Map<string, Kline[]>();
    for (const k of rows) if (sessionActive(id, k[0], false)) { const key = localTime(zone, k[0]).key; (inst.get(key) ?? inst.set(key, []).get(key)!).push(k); }
    const all = [...inst.values()], full = all.filter(g => g.length >= Math.max(2, Math.floor((id === "london_ny_overlap" ? 4 : 9) * 0.8)));
    const bars = full.flat(), eff = full.map(g => { const path = g.reduce((s, k) => s + (k[2] - k[3]), 0); return path > 0 ? Math.abs(g.at(-1)![4] - g[0][1]) / path : 0; });
    return { session: id, bars: bars.length, instances: full.length, avgRangePct: mean(bars.map(rangePct)), rangeVsBaseline: mean(bars.map(rangePct)) / baseRange, volumeVsBaseline: mean(bars.map(k => k[5])) / baseVol, efficiency: eff.length ? mean(eff) : null, sampleOk: full.length >= MIN_SESSION_INSTANCES };
  });
  const hours: HourStat[] = Array.from({ length: 24 }, (_, h) => { const b = wk.filter(k => new Date(k[0]).getUTCHours() === h); return { hourUtc: h, bars: b.length, rangeVsBaseline: mean(b.map(rangePct)) / baseRange, volumeVsBaseline: mean(b.map(k => k[5])) / baseVol }; });
  const byDay = new Map<string, Kline[]>(); for (const k of rows) { const key = new Date(k[0]).toISOString().slice(0, 10); (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(k); }
  const days = [...byDay.entries()].filter(([, g]) => g.length >= (opts.minBarsPerDay ?? 24)).map(([key, g]) => ({ dow: new Date(key + "T00:00:00Z").getUTCDay(), range: ((Math.max(...g.map(k => k[2])) - Math.min(...g.map(k => k[3]))) / g[0][1]) * 100, vol: g.reduce((s, k) => s + k[5], 0) }));
  const dailyRange = mean(days.filter(d => d.dow >= 1 && d.dow <= 5).map(d => d.range)), dailyVol = mean(days.filter(d => d.dow >= 1 && d.dow <= 5).map(d => d.vol));
  const weekdays: DayStat[] = [0, 1, 2, 3, 4, 5, 6].map(dow => { const g = days.filter(d => d.dow === dow); return { dow, days: g.length, avgRangePct: mean(g.map(d => d.range)), rangeVsBaseline: mean(g.map(d => d.range)) / dailyRange, volumeVsBaseline: mean(g.map(d => d.vol)) / dailyVol }; });
  return { bars: rows.length, days: days.length, volumeKnown: opts.volumeKnown ?? true, baselineRangePct: baseRange, sessions, hours, weekdays };
}

/** Pearson correlation of hourly log returns over the most recent aligned bars. */
export function returnCorrelation(a: Kline[], b: Kline[], bars = 168): { corr: number; bars: number } | null {
  const mb = new Map(b.map(k => [k[0], k[4]])), pairs: [number, number][] = [];
  for (let i = 1; i < a.length; i++) { const p = mb.get(a[i - 1][0]), q = mb.get(a[i][0]); if (p && q) pairs.push([Math.log(a[i][4] / a[i - 1][4]), Math.log(q / p)]); }
  const w = pairs.slice(-bars); if (w.length < 48) return null;
  const mx = mean(w.map(p => p[0])), my = mean(w.map(p => p[1]));
  let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of w) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? { corr: sxy / Math.sqrt(sxx * syy), bars: w.length } : null;
}

/** Average execution price versus mid when walking the visible book for `notional` quote units. Null when visible depth cannot absorb it. */
export function slippageBps(depth: DepthSnapshot, notional: number): { buyBps: number | null; sellBps: number | null } {
  const bids = [...depth.bids].sort((x, y) => y[0] - x[0]), asks = [...depth.asks].sort((x, y) => x[0] - y[0]);
  if (!bids.length || !asks.length) return { buyBps: null, sellBps: null };
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const walk = (lv: [number, number][], side: 1 | -1) => { let need = notional, cost = 0, qty = 0; for (const [p, q] of lv) { const take = Math.min(q * p, need); cost += take; qty += take / p; need -= take; if (need <= 1e-9) break; } return need > 1e-9 ? null : (side * (cost / qty - mid)) / mid * 1e4; };
  return { buyBps: walk(asks, 1), sellBps: walk(bids, -1) };
}

export interface QuoteInput { bid: number; ask: number; time: number | null }
/** Liquidity view from a top-of-book quote only. Depth and slippage are NOT known and are reported as such. */
export function quoteLiquidity(q: QuoteInput, price: number, now: number, maxSpreadBps: number): NonNullable<MarketSnapshot["liquidity"]> {
  const out = (status: "ok" | "degraded" | "blocked", issues: string[], spread: number | null, age: number) => ({ status, issues, spreadBps: spread, ageMs: age, bidDepth: 0, askDepth: 0, slippageBuyBps: null, slippageSellBps: null, referenceNotional: 0, depthKnown: false });
  const age = q.time === null ? Infinity : now - q.time;
  if (!(q.bid > 0 && q.ask > 0) || q.bid >= q.ask) return out("blocked", ["Crossed, locked or invalid quote"], null, age);
  const mid = (q.bid + q.ask) / 2, spread = (q.ask - q.bid) / mid * 1e4, issues: string[] = []; let status: "ok" | "degraded" | "blocked" = "ok";
  if (Math.abs(mid - price) / price > 0.02) { status = "blocked"; issues.push("Quote differs from the last candle by more than 2%: possible wrong asset or stale data"); }
  if (q.time === null) { status = status === "blocked" ? status : "degraded"; issues.push("Quote carries no timestamp: freshness unverified"); }
  else if (age > 600_000) { status = "blocked"; issues.push(`Quote is stale (${Math.round(age / 1000)} s old)`); }
  else if (age > 120_000 && status === "ok") { status = "degraded"; issues.push(`Quote is ${Math.round(age / 1000)} s old`); }
  if (spread > maxSpreadBps && status === "ok") { status = "degraded"; issues.push(`Spread ${spread.toFixed(1)} bps exceeds limit ${maxSpreadBps}`); }
  return out(status, issues, spread, Number.isFinite(age) ? age : 0);
}

export interface MarketSnapshot {
  symbol: string; provider: string; /** True only when the full live fetch (all timeframes, order book, reference asset) was attempted. */ liveData: boolean; generatedAt: number; lastCandleTime: number; dataAgeSec: number; stale: boolean; price: number;
  volatility: { atrPercent: number; percentile: number; classification: VolClass; expansion: boolean; contraction: boolean };
  regime: Pick<RegimeResult, "regime" | "confidence" | "adx" | "reasons">;
  structure: { bias: "bull" | "bear" | "neutral"; support: number | null; resistance: number | null };
  trend: { direction: "bull" | "bear" | "neutral"; weightedScore: number; frames: { timeframe: Timeframe; trend: string; adx: number; reliability: number }[]; conflicts: string[]; unavailable: Timeframe[] };
  setup: Pick<AlgoSignal, "action" | "classification" | "confidence" | "tradeable" | "notes"> | null;
  liquidity: (Pick<LiquidityAnalysis, "status" | "issues" | "spreadBps" | "ageMs" | "bidDepth" | "askDepth"> & { slippageBuyBps: number | null; slippageSellBps: number | null; referenceNotional: number; /** False for top-of-book quote sources (stocks, forex): spread is verified, depth and slippage are not. */ depthKnown: boolean }) | null;
  ticker: { quoteVolume24h: number; changePct24h: number } | null;
  history: HistoryStats | null;
  correlation: { reference: string; corr: number; bars: number; referenceVolPercentile: number | null } | null;
  failures: Record<string, string>;
}
export interface SnapshotInput {
  symbol: string; now: number; strategy: Strategy; provider: string; candles: Partial<Record<Timeframe, Kline[]>>; hourly: Kline[] | null; depth: DepthSnapshot | null;
  ticker?: { quoteVolume: number; priceChangePercent: number } | null; reference?: { symbol: string; hourly: Kline[] } | null; failures?: Record<string, string>; referenceNotional?: number; live?: boolean;
  /** Top-of-book quote for sources without an order book. */ quote?: QuoteInput | null; maxSpreadBps?: number; minBarsPerDay?: number;
}
export function buildSnapshot(i: SnapshotInput): MarketSnapshot | null {
  // Sources that give no volume (many FX feeds) must not look like zero-volume anomalies to the regime classifier: volume is neutralised
  // to a constant and volume-based statistics are flagged unknown instead of being invented.
  const volumeKnown = [...(i.hourly ?? []), ...Object.values(i.candles).flat()].some(k => !!k && k[5] > 0);
  if (!volumeKnown) { const flat = (r: Kline[]) => r.map(k => [k[0], k[1], k[2], k[3], k[4], 1] as Kline); for (const tf of Object.keys(i.candles) as Timeframe[]) if (i.candles[tf]) i.candles[tf] = flat(i.candles[tf]!); if (i.hourly) i.hourly = flat(i.hourly); if (i.reference) i.reference = { ...i.reference, hourly: flat(i.reference.hourly) }; }
  const h = i.candles["1h"] ?? i.hourly;
  if (!h || h.length < 100) return null;
  const last = h.at(-1)!, price = last[4], vol = volatility(h), regime = classifyRegime(h), st = marketStructure(h);
  const analyses: Partial<Record<Timeframe, TimeframeAnalysis | null>> = {}; for (const tf of TIMEFRAMES) { const r = i.candles[tf]; analyses[tf] = r ? analyzeTimeframe(tf, r) : null; }
  const cons = buildConsensus(analyses, i.strategy);
  const sig = buildSignal({ symbol: i.symbol, strategy: i.strategy, candles: i.candles, depth: i.depth ?? (i.quote ? undefined : null), now: i.now, provider: i.provider });
  const la = i.depth ? analyzeLiquidity(i.depth, price, i.now) : null, notional = i.referenceNotional ?? 10_000;
  const slip = i.depth ? slippageBps(i.depth, notional) : null;
  const refVol = i.reference && i.reference.hourly.length >= 100 ? volatility(i.reference.hourly).percentile : null;
  const corr = i.reference ? returnCorrelation(h, i.reference.hourly) : null;
  const ageSec = (i.now - last[0]) / 1000;
  return {
    symbol: i.symbol, provider: i.provider, liveData: i.live ?? true, generatedAt: i.now, lastCandleTime: last[0], dataAgeSec: Math.round(ageSec), stale: ageSec > 3600 * 3 || ageSec < -60, price,
    volatility: { atrPercent: vol.atrPercent, percentile: vol.percentile, classification: vol.classification, expansion: vol.expansion, contraction: vol.contraction },
    regime: { regime: regime.regime, confidence: regime.confidence, adx: regime.adx, reasons: regime.reasons },
    structure: { bias: st.bias, support: st.support, resistance: st.resistance },
    trend: { direction: cons.direction, weightedScore: cons.weightedScore, frames: TIMEFRAMES.flatMap(tf => (analyses[tf] ? [{ timeframe: tf, trend: analyses[tf]!.trend, adx: analyses[tf]!.adx, reliability: analyses[tf]!.reliability }] : [])), conflicts: cons.conflicts, unavailable: cons.unavailable },
    setup: { action: sig.action, classification: sig.classification, confidence: sig.confidence, tradeable: sig.tradeable, notes: sig.notes.slice(0, 6) },
    liquidity: la ? { status: la.status, issues: la.issues, spreadBps: la.spreadBps, ageMs: la.ageMs, bidDepth: la.bidDepth, askDepth: la.askDepth, slippageBuyBps: slip?.buyBps ?? null, slippageSellBps: slip?.sellBps ?? null, referenceNotional: notional, depthKnown: true } : i.quote ? quoteLiquidity(i.quote, price, i.now, i.maxSpreadBps ?? 15) : null,
    ticker: i.ticker ? { quoteVolume24h: i.ticker.quoteVolume, changePct24h: i.ticker.priceChangePercent } : null,
    history: i.hourly ? historyStats(i.hourly, i.now, { minBarsPerDay: i.minBarsPerDay, volumeKnown }) : null,
    correlation: i.reference && corr ? { reference: i.reference.symbol, corr: corr.corr, bars: corr.bars, referenceVolPercentile: refVol } : null,
    failures: i.failures ?? {},
  };
}

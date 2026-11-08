import { getMarketData, providerOrder, INTERVALS, INTERVAL_SECONDS, type Kline, type MarketEnv } from "./market.ts";

export interface SignalEnv extends MarketEnv {}

export interface IndicatorSnapshot {
  ema20: number; ema50: number; ema200: number;
  rsi14: number; macd: number; macdSignal: number; macdHistogram: number;
  atr14: number; atrPercent: number; adx14: number;
  bollingerUpper: number; bollingerMiddle: number; bollingerLower: number;
  volumeRatio: number; breakoutHigh20: number; breakoutLow20: number;
}

export interface SignalResult {
  symbol: string; provider: string; interval: string; asOf: string;
  action: "BUY" | "SELL" | "WAIT"; score: number; confidence: number;
  confidenceType: "heuristic_score_not_probability";
  entry: number | null; stopLoss: number | null;
  targets: { target: number; price: number; rewardRisk: number }[];
  riskRewardToTarget3: number | null;
  indicators: IndicatorSnapshot | null;
  evidence: string[]; strategyAttribution: { trader: string; documentedPrinciple: string; contribution: string }[];
  invalidation: string[]; dataQuality: { status: string; candleCount: number; provider: string };
  historicalValidation: { status: string; method: string; sampleCount: number; wins: number; losses: number; winRate: number | null; note: string };
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}
function rsi(values: number[], period = 14): number {
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}
function atr(rows: Kline[], period = 14): number {
  const tr = rows.slice(1).map((r, i) => Math.max(r[2] - r[3], Math.abs(r[2] - rows[i][4]), Math.abs(r[3] - rows[i][4])));
  if (tr.length < period) return NaN;
  let v = mean(tr.slice(0, period));
  for (let i = period; i < tr.length; i++) v = (v * (period - 1) + tr[i]) / period;
  return v;
}
function adx(rows: Kline[], period = 14): number {
  const plus: number[] = [], minus: number[] = [], trs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const up = rows[i][2] - rows[i - 1][2], down = rows[i - 1][3] - rows[i][3];
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4])));
  }
  if (trs.length < period * 2) return NaN;
  const dx: number[] = [];
  for (let i = period; i < trs.length; i++) {
    const start = i - period;
    const trSum = trs.slice(start, i).reduce((a, b) => a + b, 0);
    const p = plus.slice(start, i).reduce((a, b) => a + b, 0);
    const m = minus.slice(start, i).reduce((a, b) => a + b, 0);
    const pdi = trSum ? 100 * p / trSum : 0, mdi = trSum ? 100 * m / trSum : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  return dx.length ? mean(dx.slice(-period)) : NaN;
}
function indicators(rows: Kline[]): IndicatorSnapshot | null {
  if (rows.length < 210) return null;
  const close = rows.map(r => r[4]), volumes = rows.map(r => r[5]);
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200);
  // EMA is recursive from the first value, so one pass yields the same value as re-running on each prefix (O(n) instead of O(n^2)).
  const e12 = ema(close, 12), e26 = ema(close, 26);
  const mLine = close.map((_, i) => e12[i] - e26[i]);
  const mSignal = ema(mLine, 9);
  const a = atr(rows), last = close.at(-1)!;
  const sample = close.slice(-20), mid = mean(sample), sd = Math.sqrt(mean(sample.map(x => (x - mid) ** 2)));
  const vBase = mean(volumes.slice(-21, -1));
  return {
    ema20: e20.at(-1)!, ema50: e50.at(-1)!, ema200: e200.at(-1)!,
    rsi14: rsi(close), macd: mLine.at(-1)!, macdSignal: mSignal.at(-1)!, macdHistogram: mLine.at(-1)! - mSignal.at(-1)!,
    atr14: a, atrPercent: a / last * 100, adx14: adx(rows),
    bollingerUpper: mid + 2 * sd, bollingerMiddle: mid, bollingerLower: mid - 2 * sd,
    volumeRatio: vBase > 0 ? volumes.at(-1)! / vBase : 0,
    breakoutHigh20: Math.max(...rows.slice(-21, -1).map(r => r[2])),
    breakoutLow20: Math.min(...rows.slice(-21, -1).map(r => r[3])),
  };
}

function evaluate(rows: Kline[], symbol: string, provider: string, interval: string, validation = false): SignalResult | null {
  const ind = indicators(rows);
  if (!ind) return null;
  const last = rows.at(-1)!, price = last[4];
  let score = 0;
  const evidence: string[] = [];
  const add = (condition: boolean, points: number, positive: string, negative: string) => {
    if (condition) { score += points; evidence.push(positive); }
    else { score -= points; evidence.push(negative); }
  };
  add(price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200, 22, "Price and EMA20/50/200 are aligned bullishly (trend-following)", "Price and EMA20/50/200 are not aligned bullishly");
  add(ind.macdHistogram > 0, 14, "MACD histogram is positive (momentum confirmation)", "MACD histogram is non-positive");
  if (ind.rsi14 >= 52 && ind.rsi14 <= 70) { score += 10; evidence.push("RSI supports bullish momentum without an extreme reading"); }
  else if (ind.rsi14 <= 48 && ind.rsi14 >= 30) { score -= 10; evidence.push("RSI supports bearish momentum without an extreme reading"); }
  else evidence.push("RSI is neutral or stretched; no momentum bonus");
  add(price > ind.breakoutHigh20, 14, "Close broke above the prior 20-candle high (Darvas/O'Neil-style breakout)", "No confirmed upside 20-candle breakout");
  if (price < ind.breakoutLow20) { score -= 14; evidence.push("Close broke below the prior 20-candle low"); }
  if (ind.volumeRatio >= 1.25) { score += price >= last[1] ? 8 : -8; evidence.push("Volume is at least 1.25x its prior 20-candle average"); }
  else evidence.push("Volume has not confirmed the move");
  if (ind.adx14 >= 20) { score += (ind.ema20 > ind.ema50 ? 6 : -6); evidence.push("ADX indicates a directional trend is present"); }
  else evidence.push("ADX indicates weak or absent trend strength");
  if (price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200) score -= 22;
  score = Math.max(-100, Math.min(100, score));
  const action = score >= 55 ? "BUY" : score <= -55 ? "SELL" : "WAIT";
  const direction = action === "BUY" ? 1 : action === "SELL" ? -1 : 0;
  const stopDistance = Math.max(ind.atr14 * 1.5, price * 0.002);
  const entry = direction ? price : null;
  const stopLoss = direction ? price - direction * stopDistance : null;
  const targets = direction ? [1, 2, 3].map(r => ({ target: r, price: price + direction * stopDistance * r, rewardRisk: r })) : [];
  const attribution = [
    { trader: "Richard Dennis / William Eckhardt / Ed Seykota", documentedPrinciple: "Systematic trend following and disciplined exits", contribution: "EMA alignment and ATR-based stop distance" },
    { trader: "Nicolas Darvas / William O'Neil", documentedPrinciple: "Price breakouts with confirmation", contribution: "Prior 20-candle high/low breakout and volume confirmation" },
    { trader: "Paul Tudor Jones", documentedPrinciple: "Capital preservation and asymmetric risk", contribution: "Predefined invalidation and staged 1R/2R/3R targets" },
    { trader: "Jim Simons (high-level inspiration only)", documentedPrinciple: "Statistical testing of repeatable patterns", contribution: "Signals require empirical validation; no claim to proprietary Renaissance methods" },
  ];
  return {
    symbol, provider, interval, asOf: new Date(last[0]).toISOString(), action, score,
    confidence: Math.abs(score), confidenceType: "heuristic_score_not_probability",
    entry, stopLoss, targets, riskRewardToTarget3: direction ? 3 : null, indicators: ind,
    evidence, strategyAttribution: attribution,
    invalidation: direction ? [`Close beyond stop level ${stopLoss}`, "Signal is invalid if the market quote or candle stream becomes stale", "Re-evaluate after each completed candle; do not widen stops to avoid a loss"] : ["No directional trade until score reaches +55 or -55 and data remains fresh"],
    dataQuality: { status: "validated_public_exchange_candles", candleCount: rows.length, provider },
    historicalValidation: validation ? { status: "computed", method: "Walk-forward candle replay; stop-first assumption when stop and target touch in the same candle; TP1 defines a win", sampleCount: 0, wins: 0, losses: 0, winRate: null, note: "Insufficient closed observations to publish a rate" } : { status: "pending", method: "Walk-forward candle replay", sampleCount: 0, wins: 0, losses: 0, winRate: null, note: "Not yet computed; no win rate is claimed" },
  };
}

function backtest(rows: Kline[], symbol: string, provider: string, interval: string) {
  let wins = 0, losses = 0, samples = 0;
  const horizon = 12;
  for (let i = 210; i + horizon < rows.length; i += horizon) {
    const s = evaluate(rows.slice(0, i + 1), symbol, provider, interval, true);
    if (!s || s.action === "WAIT" || s.entry === null || s.stopLoss === null) continue;
    const dir = s.action === "BUY" ? 1 : -1, stop = s.stopLoss, target = s.targets[0].price;
    let outcome: "win" | "loss" | null = null;
    for (const bar of rows.slice(i + 1, i + 1 + horizon)) {
      const stopHit = dir > 0 ? bar[3] <= stop : bar[2] >= stop;
      const targetHit = dir > 0 ? bar[2] >= target : bar[3] <= target;
      if (stopHit) { outcome = "loss"; break; }
      if (targetHit) { outcome = "win"; break; }
    }
    samples++; if (outcome === "win") wins++; else losses++;
  }
  return { status: samples >= 20 ? "computed" : "insufficient_sample", method: "Non-overlapping walk-forward candle replay; conservative stop-first tie handling; TP1 defines a win; fees, slippage and funding excluded", sampleCount: samples, wins, losses, winRate: samples >= 20 ? Number((wins / samples * 100).toFixed(1)) : null, note: samples >= 20 ? "Historical simulation only; not a forecast. Results may overfit and omit fees, slippage and market impact." : "Fewer than 20 closed observations: win rate withheld rather than presented as reliable." };
}

export async function handleSignals(req: Request, env: SignalEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/signals" || req.method !== "GET") return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const interval = url.searchParams.get("interval") || "1h";
  const requestedProvider = url.searchParams.get("provider");
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !INTERVALS.includes(interval)) return new Response(JSON.stringify({ error: "invalid_symbol_or_interval" }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    const result = await getMarketData("klines", { symbol, interval, limit: 500 }, providerOrder(env, requestedProvider));
    const rows = result.data as Kline[];
    const latestAge = (Date.now() - rows.at(-1)![0]) / 1000;
    if (latestAge < -60 || latestAge > (INTERVAL_SECONDS[interval] || 60) * 3) return new Response(JSON.stringify({ error: "stale_market_data", ageSeconds: Math.round(latestAge), maxAgeSeconds: (INTERVAL_SECONDS[interval] || 60) * 3 }), { status: 503, headers: { "content-type": "application/json" } });
    const signal = evaluate(rows, symbol, result.provider, interval);
    if (!signal) return new Response(JSON.stringify({ error: "insufficient_history", requiredCandles: 210, received: rows.length }), { status: 422, headers: { "content-type": "application/json" } });
    signal.historicalValidation = backtest(rows, symbol, result.provider, interval);
    return new Response(JSON.stringify(signal), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "market_data_unavailable", detail: e instanceof Error ? e.message : "unknown" }), { status: 503, headers: { "content-type": "application/json" } });
  }
}

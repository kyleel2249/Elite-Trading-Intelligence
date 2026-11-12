import { getMarketData, providerOrder, INTERVALS, INTERVAL_SECONDS, type Kline, type MarketEnv } from "./market.ts";
import { runModules, attributionFor, stanceCounts, statEdge, edgeAttribution, kellySizing, type AttributionEntry, type Regime, type StatEdge, type PositionSizing } from "./strategies.ts";

export interface SignalEnv extends MarketEnv {}

export interface IndicatorSnapshot {
  ema20: number; ema50: number; ema200: number;
  rsi14: number; macd: number; macdSignal: number; macdHistogram: number;
  atr14: number; atrPercent: number; adx14: number;
  bollingerUpper: number; bollingerMiddle: number; bollingerLower: number;
  volumeRatio: number; breakoutHigh20: number; breakoutLow20: number;
}

/** One factor of the heuristic confluence score, signed. Sum of points = raw score before the +/-100 clamp. */
export interface ScoreComponent { id: string; label: string; points: number; max: number }

export type Conviction = "high" | "medium" | "low";
type Num = number | null;

/** A point on the candle series where the engine's directional label flipped, or where conviction first became high. */
export interface ChartMarker { time: number; kind: "flip" | "high"; label: "BUY" | "SELL"; score: number; conviction: Conviction }

/** One walk-forward replay trade produced by the same labelling rule (TP1-before-stop, stop-first on ties). */
export interface ReplayTrade {
  time: number; exitTime: number | null; label: "BUY" | "SELL"; conviction: Conviction; score: number;
  entry: number; stop: number; tp1: number; outcome: "win" | "loss" | "unresolved";
}

/**
 * Per-candle engine output, aligned by `times` (candle open time, ms). Every array has the same length as `times`.
 * The last element of each series equals the corresponding value in `indicators` / `score` of the signal result.
 */
export interface ChartPayload {
  window: number;
  times: number[];
  ema20: Num[]; ema50: Num[]; ema200: Num[];
  bbUpper: Num[]; bbMiddle: Num[]; bbLower: Num[];
  rsi: Num[]; macd: Num[]; macdSignal: Num[]; macdHistogram: Num[];
  adx: Num[]; atr: Num[]; volumeRatio: Num[];
  breakoutHigh: Num[]; breakoutLow: Num[];
  score: number[]; direction: (1 | -1)[]; conviction: Conviction[];
  /** Engine regime per candle (ADX 25+ trend, under 20 range, otherwise transition). */
  regime: Regime["state"][];
  /** Active documented methods supporting / opposing the lean at each candle. */
  supporting: number[]; opposing: number[];
  /** True where conviction was lowered one tier because more active methods opposed than supported the lean. */
  downgraded: boolean[];
  markers: ChartMarker[]; replay: ReplayTrade[];
  levels: { asOf: number; direction: 1 | -1; entry: number; stopLoss: number; targets: number[]; breakoutHigh20: number; breakoutLow20: number };
}

export interface SignalResult {
  symbol: string; provider: string; interval: string; asOf: string;
  action: "BUY" | "SELL" | "WAIT"; score: number; confidence: number;
  /** Always BUY or SELL: the directional lean of the score. `action` mirrors it. */
  label: "BUY" | "SELL";
  /** The original quality gate (BUY/SELL only at |score| >= 55, otherwise WAIT). */
  gatedAction: "BUY" | "SELL" | "WAIT";
  conviction: Conviction;
  /** True only when the gated action is BUY/SELL, i.e. a real, high-conviction setup. */
  tradeable: boolean;
  confidenceType: "heuristic_score_not_probability";
  entry: number | null; stopLoss: number | null;
  targets: { target: number; price: number; rewardRisk: number }[];
  riskRewardToTarget3: number | null;
  indicators: IndicatorSnapshot | null;
  evidence: string[];
  /** Signed contribution of each scoring factor; powers the score-breakdown chart. */
  components: ScoreComponent[];
  strategyAttribution: AttributionEntry[];
  regime: Regime; statisticalEdge: StatEdge | null; positionSizing: PositionSizing | null;
  invalidation: string[]; dataQuality: { status: string; candleCount: number; provider: string };
  historicalValidation: { status: string; method: string; sampleCount: number; wins: number; losses: number; winRate: number | null; note: string; unresolved?: number; highConviction?: { sampleCount: number; wins: number; losses: number; winRate: number | null } };
  /** Per-candle series for the dashboard charts. Present on /api/signals responses. */
  chart?: ChartPayload;
}

export const MIN_CANDLES = 210;
const DEFAULT_WINDOW = 120;
const MIN_WINDOW = 30;
const MAX_WINDOW = 500;

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
export function indicators(rows: Kline[]): IndicatorSnapshot | null {
  if (rows.length < MIN_CANDLES) return null;
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

// ------------------------------------------------------------------ scoring
// One scoring rule shared by the live signal, the walk-forward replay and the per-candle chart series,
// so what the charts show is exactly what the engine computed.

interface ScoreOutcome { score: number; evidence: string[]; components: ScoreComponent[] }

function scoreIndicators(ind: IndicatorSnapshot, price: number, open: number): ScoreOutcome {
  let score = 0;
  const evidence: string[] = [];
  const components: ScoreComponent[] = [];
  const push = (id: string, label: string, points: number, max: number) => { components.push({ id, label, points, max }); score += points; };
  const add = (id: string, label: string, condition: boolean, points: number, positive: string, negative: string) => {
    if (condition) { push(id, label, points, points); evidence.push(positive); }
    else { push(id, label, -points, points); evidence.push(negative); }
  };
  add("trend", "EMA 20/50/200 trend", price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200, 22, "Price and EMA20/50/200 are aligned bullishly (trend-following)", "Price and EMA20/50/200 are not aligned bullishly");
  add("macd", "MACD histogram", ind.macdHistogram > 0, 14, "MACD histogram is positive (momentum confirmation)", "MACD histogram is non-positive");
  if (ind.rsi14 >= 52 && ind.rsi14 <= 70) { push("rsi", "RSI 14 momentum", 10, 10); evidence.push("RSI supports bullish momentum without an extreme reading"); }
  else if (ind.rsi14 <= 48 && ind.rsi14 >= 30) { push("rsi", "RSI 14 momentum", -10, 10); evidence.push("RSI supports bearish momentum without an extreme reading"); }
  else { push("rsi", "RSI 14 momentum", 0, 10); evidence.push("RSI is neutral or stretched; no momentum bonus"); }
  add("breakout", "20-candle breakout", price > ind.breakoutHigh20, 14, "Close broke above the prior 20-candle high (Darvas/O'Neil-style breakout)", "No confirmed upside 20-candle breakout");
  if (price < ind.breakoutLow20) { push("breakdown", "20-candle breakdown", -14, 14); evidence.push("Close broke below the prior 20-candle low"); }
  else push("breakdown", "20-candle breakdown", 0, 14);
  if (ind.volumeRatio >= 1.25) { push("volume", "Relative volume", price >= open ? 8 : -8, 8); evidence.push("Volume is at least 1.25x its prior 20-candle average"); }
  else { push("volume", "Relative volume", 0, 8); evidence.push("Volume has not confirmed the move"); }
  if (ind.adx14 >= 20) { push("adx", "ADX trend strength", ind.ema20 > ind.ema50 ? 6 : -6, 6); evidence.push("ADX indicates a directional trend is present"); }
  else { push("adx", "ADX trend strength", 0, 6); evidence.push("ADX indicates weak or absent trend strength"); }
  if (price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200) push("bearStack", "Full bearish EMA stack", -22, 22);
  else push("bearStack", "Full bearish EMA stack", 0, 22);
  score = Math.max(-100, Math.min(100, score));
  return { score, evidence, components };
}

/** Every chart gets a BUY or SELL label. A score of exactly 0 is broken by trend (EMA20 vs EMA50, then price vs EMA50). */
function directionalLabel(score: number, ind: IndicatorSnapshot, price: number): "BUY" | "SELL" {
  const lean = score !== 0 ? score : (ind.ema20 !== ind.ema50 ? ind.ema20 - ind.ema50 : price - ind.ema50);
  return lean >= 0 ? "BUY" : "SELL";
}
const convictionOf = (score: number): Conviction => Math.abs(score) >= 55 ? "high" : Math.abs(score) >= 30 ? "medium" : "low";

/** Disagreement between active documented methods lowers conviction by one tier instead of being averaged away. */
function applyDisagreement(base: Conviction, supporting: number, opposing: number): { conviction: Conviction; downgraded: boolean } {
  const downgraded = opposing > supporting && base !== "low";
  return { conviction: downgraded ? (base === "high" ? "medium" : "low") : base, downgraded };
}

function evaluate(rows: Kline[], symbol: string, provider: string, interval: string, validation = false): SignalResult | null {
  const ind = indicators(rows);
  if (!ind) return null;
  const last = rows.at(-1)!, price = last[4];
  const { score, evidence, components } = scoreIndicators(ind, price, last[1]);
  const gatedAction = score >= 55 ? "BUY" : score <= -55 ? "SELL" : "WAIT";
  const label = directionalLabel(score, ind, price);
  const action = label;
  const direction: 1 | -1 = label === "BUY" ? 1 : -1;
  const { regime, results } = runModules(rows, ind);
  const { supporting, opposing } = stanceCounts(results, direction);
  const { conviction, downgraded } = applyDisagreement(convictionOf(score), supporting, opposing);
  evidence.unshift("Conviction " + conviction.toUpperCase() + " (|score| " + Math.abs(score) + "): " + (conviction === "high" ? "confluence is strong enough to treat as a trade setup" : conviction === "medium" ? "partial confluence; size down" : "weak confluence; this is a directional lean, not a validated edge") + (downgraded ? "; lowered because " + opposing + " active documented method(s) oppose vs " + supporting + " supporting" : ""));
  evidence.push("Regime " + regime.state.toUpperCase() + " (ADX " + regime.adx + "); documented methods: " + supporting + " supporting, " + opposing + " opposing");
  const stopDistance = Math.max(ind.atr14 * 1.5, price * 0.002);
  const entry: number | null = price;
  const stopLoss: number | null = price - direction * stopDistance;
  const targets = [1, 2, 3].map(r => ({ target: r, price: price + direction * stopDistance * r, rewardRisk: r }));
  return {
    symbol, provider, interval, asOf: new Date(last[0]).toISOString(), action, score,
    label, gatedAction, conviction, tradeable: conviction === "high" && gatedAction !== "WAIT",
    confidence: Math.abs(score), confidenceType: "heuristic_score_not_probability",
    entry, stopLoss, targets, riskRewardToTarget3: 3, indicators: ind,
    evidence, components, strategyAttribution: attributionFor(results, direction), regime, statisticalEdge: null, positionSizing: null,
    invalidation: [`Close beyond stop level ${stopLoss}`, "Signal is invalid if the market quote or candle stream becomes stale", "Re-evaluate after each completed candle; do not widen stops to avoid a loss", ...(gatedAction === "WAIT" ? ["Below |score| 55 this is a lean only; the quality gate would normally stand aside"] : [])],
    dataQuality: { status: "validated_public_exchange_candles", candleCount: rows.length, provider },
    historicalValidation: validation ? { status: "computed", method: "Walk-forward candle replay; stop-first assumption when stop and target touch in the same candle; TP1 defines a win", sampleCount: 0, wins: 0, losses: 0, winRate: null, note: "Insufficient closed observations to publish a rate" } : { status: "pending", method: "Walk-forward candle replay", sampleCount: 0, wins: 0, losses: 0, winRate: null, note: "Not yet computed; no win rate is claimed" },
  };
}

// ---------------------------------------------------------- per-candle series
// Full-length versions of the indicators above. Each element at bar b equals what indicators() returns for rows[0..b].

function rsiSeries(values: number[], period = 14): Num[] {
  const out: Num[] = values.map(() => null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  gain /= period; loss /= period;
  const val = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  out[period] = val();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}
function atrSeries(rows: Kline[], period = 14): Num[] {
  const out: Num[] = rows.map(() => null);
  const tr = rows.slice(1).map((r, i) => Math.max(r[2] - r[3], Math.abs(r[2] - rows[i][4]), Math.abs(r[3] - rows[i][4])));
  if (tr.length < period) return out;
  let v = mean(tr.slice(0, period));
  out[period] = v;
  for (let i = period; i < tr.length; i++) { v = (v * (period - 1) + tr[i]) / period; out[i + 1] = v; }
  return out;
}
function adxSeries(rows: Kline[], period = 14): Num[] {
  const out: Num[] = rows.map(() => null);
  const n = rows.length;
  const plus: number[] = [], minus: number[] = [], trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = rows[i][2] - rows[i - 1][2], down = rows[i - 1][3] - rows[i][3];
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4])));
  }
  const cum = (a: number[]) => { const c = [0]; a.forEach((v, i) => c.push(c[i] + v)); return c; };
  const cp = cum(plus), cm = cum(minus), ct = cum(trs);
  // dx[i] uses the trailing window [i-period, i) exactly like adx(); bar b sees dx[period..b-1].
  const dx: number[] = [];
  for (let i = period; i < trs.length; i++) {
    const trSum = ct[i] - ct[i - period], p = cp[i] - cp[i - period], m = cm[i] - cm[i - period];
    const pdi = trSum ? 100 * p / trSum : 0, mdi = trSum ? 100 * m / trSum : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  for (let b = period * 2; b < n; b++) {
    // dx index for i is i - period; the last dx visible to bar b is i = b - 1.
    const hi = b - 1 - period;
    if (hi - period + 1 < 0) continue;
    out[b] = mean(dx.slice(hi - period + 1, hi + 1));
  }
  return out;
}

const tidy = (v: Num): Num => v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(10));
const tidyAll = (a: Num[]): Num[] => a.map(tidy);

function buildChart(rows: Kline[], windowSize: number, replay: ReplayTrade[]): ChartPayload | null {
  const n = rows.length;
  if (n < MIN_CANDLES) return null;
  const close = rows.map(r => r[4]), volumes = rows.map(r => r[5]);
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200);
  const e12 = ema(close, 12), e26 = ema(close, 26);
  const mLine = close.map((_, i) => e12[i] - e26[i]);
  const mSignal = ema(mLine, 9);
  const rsiS = rsiSeries(close), atrS = atrSeries(rows), adxS = adxSeries(rows);

  const snapshotAt = (b: number): IndicatorSnapshot => {
    const sample = close.slice(b - 19, b + 1), mid = mean(sample), sd = Math.sqrt(mean(sample.map(x => (x - mid) ** 2)));
    const vBase = mean(volumes.slice(b - 20, b));
    const prior = rows.slice(b - 20, b);
    const a = atrS[b] as number;
    return {
      ema20: e20[b], ema50: e50[b], ema200: e200[b],
      rsi14: rsiS[b] as number, macd: mLine[b], macdSignal: mSignal[b], macdHistogram: mLine[b] - mSignal[b],
      atr14: a, atrPercent: a / close[b] * 100, adx14: adxS[b] as number,
      bollingerUpper: mid + 2 * sd, bollingerMiddle: mid, bollingerLower: mid - 2 * sd,
      volumeRatio: vBase > 0 ? volumes[b] / vBase : 0,
      breakoutHigh20: Math.max(...prior.map(r => r[2])),
      breakoutLow20: Math.min(...prior.map(r => r[3])),
    };
  };

  const first = Math.max(MIN_CANDLES - 1, n - windowSize);
  // One extra leading bar (when available) only to decide whether the first visible bar is a flip.
  const from = Math.max(MIN_CANDLES - 1, first - 1);
  const snaps: IndicatorSnapshot[] = [], scores: number[] = [], dirs: (1 | -1)[] = [], convs: Conviction[] = [];
  const regimes: Regime["state"][] = [], sups: number[] = [], opps: number[] = [], downs: boolean[] = [];
  for (let b = from; b < n; b++) {
    const s = snapshotAt(b);
    const sc = scoreIndicators(s, close[b], rows[b][1]).score;
    const dirn: 1 | -1 = directionalLabel(sc, s, close[b]) === "BUY" ? 1 : -1;
    const { regime, results } = runModules(rows.slice(0, b + 1), s);
    const { supporting, opposing } = stanceCounts(results, dirn);
    const cv = applyDisagreement(convictionOf(sc), supporting, opposing);
    snaps.push(s); scores.push(sc); dirs.push(dirn); convs.push(cv.conviction);
    regimes.push(regime.state); sups.push(supporting); opps.push(opposing); downs.push(cv.downgraded);
  }
  const skip = first - from; // 0 or 1 leading bar not displayed
  const markers: ChartMarker[] = [];
  for (let k = skip; k < scores.length; k++) {
    if (k === 0) continue; // no previous bar to compare against
    const flipped = dirs[k] !== dirs[k - 1];
    const newHigh = convs[k] === "high" && (convs[k - 1] !== "high" || flipped);
    if (!flipped && !newHigh) continue;
    markers.push({ time: rows[from + k][0], kind: newHigh ? "high" : "flip", label: dirs[k] === 1 ? "BUY" : "SELL", score: scores[k], conviction: convs[k] });
  }
  const vis = <T>(a: T[]) => a.slice(skip);
  const idx = Array.from({ length: n - first }, (_, i) => first + i);
  const lastSnap = snaps.at(-1)!;
  const entry = close[n - 1];
  const dir = dirs.at(-1)!;
  const stopDistance = Math.max(lastSnap.atr14 * 1.5, entry * 0.002);
  const times = idx.map(b => rows[b][0]);
  return {
    window: times.length,
    times,
    ema20: tidyAll(idx.map(b => e20[b])), ema50: tidyAll(idx.map(b => e50[b])), ema200: tidyAll(idx.map(b => e200[b])),
    bbUpper: tidyAll(vis(snaps).map(s => s.bollingerUpper)), bbMiddle: tidyAll(vis(snaps).map(s => s.bollingerMiddle)), bbLower: tidyAll(vis(snaps).map(s => s.bollingerLower)),
    rsi: tidyAll(idx.map(b => rsiS[b])), macd: tidyAll(idx.map(b => mLine[b])), macdSignal: tidyAll(idx.map(b => mSignal[b])), macdHistogram: tidyAll(idx.map(b => mLine[b] - mSignal[b])),
    adx: tidyAll(idx.map(b => adxS[b])), atr: tidyAll(idx.map(b => atrS[b])), volumeRatio: tidyAll(vis(snaps).map(s => s.volumeRatio)),
    breakoutHigh: tidyAll(vis(snaps).map(s => s.breakoutHigh20)), breakoutLow: tidyAll(vis(snaps).map(s => s.breakoutLow20)),
    score: vis(scores), direction: vis(dirs), conviction: vis(convs),
    regime: vis(regimes), supporting: vis(sups), opposing: vis(opps), downgraded: vis(downs),
    markers, replay: replay.filter(t => t.time >= times[0]),
    levels: {
      asOf: times.at(-1)!, direction: dir, entry, stopLoss: entry - dir * stopDistance,
      targets: [1, 2, 3].map(r => entry + dir * stopDistance * r),
      breakoutHigh20: lastSnap.breakoutHigh20, breakoutLow20: lastSnap.breakoutLow20,
    },
  };
}

function backtest(rows: Kline[], symbol: string, provider: string, interval: string) {
  let wins = 0, losses = 0, unresolved = 0, hcWins = 0, hcLosses = 0;
  const horizon = 12;
  const trades: ReplayTrade[] = [];
  for (let i = MIN_CANDLES; i + horizon < rows.length; i += horizon) {
    const s = evaluate(rows.slice(0, i + 1), symbol, provider, interval, true);
    if (!s || s.entry === null || s.stopLoss === null) continue;
    const dir = s.label === "BUY" ? 1 : -1, stop = s.stopLoss, target = s.targets[0].price;
    let outcome: "win" | "loss" | null = null;
    let exitTime: number | null = null;
    for (const bar of rows.slice(i + 1, i + 1 + horizon)) {
      const stopHit = dir > 0 ? bar[3] <= stop : bar[2] >= stop;
      const targetHit = dir > 0 ? bar[2] >= target : bar[3] <= target;
      if (stopHit) { outcome = "loss"; exitTime = bar[0]; break; }
      if (targetHit) { outcome = "win"; exitTime = bar[0]; break; }
    }
    trades.push({ time: rows[i][0], exitTime, label: s.label, conviction: s.conviction, score: s.score, entry: s.entry, stop, tp1: target, outcome: outcome ?? "unresolved" });
    if (outcome === null) { unresolved++; continue; }
    if (outcome === "win") wins++; else losses++;
    if (s.conviction === "high") { if (outcome === "win") hcWins++; else hcLosses++; }
  }
  const samples = wins + losses, hcSamples = hcWins + hcLosses;
  const rate = (w: number, n: number) => n >= 20 ? Number((w / n * 100).toFixed(1)) : null;
  return {
    trades,
    validation: {
      status: samples >= 20 ? "computed" : "insufficient_sample",
      method: "Replay of this same BUY/SELL labelling rule on this chart's own history; one signal per 12 candles (non-overlapping); a win is TP1 reached before the stop, stop-first when both touch in one candle; signals resolving in neither are excluded and counted as unresolved; fees, slippage and funding excluded",
      sampleCount: samples, wins, losses, unresolved, winRate: rate(wins, samples),
      highConviction: { sampleCount: hcSamples, wins: hcWins, losses: hcLosses, winRate: rate(hcWins, hcSamples) },
      note: samples >= 20 ? "Historical simulation of TP1-before-stop only; not a forecast and not a guarantee. Results can overfit and omit fees, slippage and market impact." : "Fewer than 20 resolved observations on this chart: win rate withheld rather than presented as reliable.",
    },
  };
}

const jsonError = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Full engine output (signal, replay validation, statistical edge, sizing) for already-validated candles. Shared by /api/signals and the Global Alpha layer. */
export function signalFromCandles(rows: Kline[], symbol: string, provider: string, interval: string): { signal: SignalResult; trades: ReplayTrade[] } | null {
  const signal = evaluate(rows, symbol, provider, interval);
  if (!signal) return null;
  const { trades, validation } = backtest(rows, symbol, provider, interval);
  const hc = validation.highConviction;
  validation.note = "Current conviction: " + signal.conviction.toUpperCase() + (signal.conviction === "low" ? " (directional lean, not a validated edge). " : ". ") +
    (hc.winRate !== null ? "High-conviction-only win rate on this chart: " + hc.winRate + "% (n=" + hc.sampleCount + "). " : "") + validation.note;
  signal.historicalValidation = validation;
  const edge = statEdge(validation);
  signal.statisticalEdge = edge;
  signal.strategyAttribution.push(edgeAttribution(edge));
  signal.positionSizing = kellySizing(validation, edge);
  return { signal, trades };
}

export async function handleSignals(req: Request, env: SignalEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/signals" || req.method !== "GET") return jsonError({ error: "not_found" }, 404);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const interval = url.searchParams.get("interval") || "1h";
  const requestedProvider = url.searchParams.get("provider");
  const market = url.searchParams.get("market") === "futures" ? "futures" : "spot";
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !INTERVALS.includes(interval)) return jsonError({ error: "invalid_symbol_or_interval" }, 400);
  const windowRaw = url.searchParams.get("window");
  let windowSize = DEFAULT_WINDOW;
  if (windowRaw !== null) {
    if (!/^\d+$/.test(windowRaw) || Number(windowRaw) < MIN_WINDOW || Number(windowRaw) > MAX_WINDOW) return jsonError({ error: "invalid_window", min: MIN_WINDOW, max: MAX_WINDOW }, 400);
    windowSize = Number(windowRaw);
  }
  try {
    const result = await getMarketData("klines", { symbol, interval, limit: 1000, market }, providerOrder(env, requestedProvider));
    const rows = result.data as Kline[];
    const latestAge = (Date.now() - rows.at(-1)![0]) / 1000;
    if (latestAge < -60 || latestAge > (INTERVAL_SECONDS[interval] || 60) * 3) return jsonError({ error: "stale_market_data", ageSeconds: Math.round(latestAge), maxAgeSeconds: (INTERVAL_SECONDS[interval] || 60) * 3 }, 503);
    const built = signalFromCandles(rows, symbol, result.provider, interval);
    if (!built) return jsonError({ error: "insufficient_history", requiredCandles: MIN_CANDLES, received: rows.length }, 422);
    const { signal, trades } = built;
    const chart = buildChart(rows, windowSize, trades);
    if (chart) signal.chart = chart;
    return new Response(JSON.stringify(signal), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
  } catch (e) {
    return jsonError({ error: "market_data_unavailable", detail: e instanceof Error ? e.message : "unknown" }, 503);
  }
}

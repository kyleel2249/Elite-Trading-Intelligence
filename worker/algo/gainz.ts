// GainzAlgo-inspired engine: adaptive signal generation from EMA 9/21/50 alignment, RSI momentum intelligence,
// breakout intelligence and a signal-quality filter. Independent implementation from public concepts.
// RSI extremes are never treated as reversal instructions. Breakouts require a closed candle plus confirmation.
import type { Kline } from "../market.ts";
import { adxSeries, atrSeries, ema, volatility } from "./indicators.ts";
import { classifyRegime } from "./regime.ts";
import { computeLevels } from "./levels.ts";
import { EXECUTION_TF, HOLDING_PERIOD, TF_SECONDS, marketStructure, swingPivots } from "./timeframes.ts";
import type { EngineInput, EngineSignal } from "./engine.ts";

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

export function rsiSeries(close: number[], period = 14): number[] {
  const out = new Array(close.length).fill(NaN);
  if (close.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = close[i] - close[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= period; l /= period;
  out[period] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period; l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

// ---------- B. EMA 9/21/50 alignment ----------
export interface EmaAlignment {
  state: "bull" | "bear" | "mixed"; compressed: boolean; compression: number; transition: "to_bull" | "to_bear" | "none";
  continuation: boolean; potentialReversal: boolean; ema9: number; ema21: number; ema50: number;
}
export function emaAlignment(rows: Kline[], atrNow: number, periods: [number, number, number] = [9, 21, 50]): EmaAlignment {
  const close = rows.map(r => r[4]), n = close.length - 1;
  const [e1, e2, e3] = periods.map(p => ema(close, p));
  const st = (i: number): "bull" | "bear" | "mixed" => (e1[i] > e2[i] && e2[i] > e3[i] ? "bull" : e1[i] < e2[i] && e2[i] < e3[i] ? "bear" : "mixed");
  const state = st(n);
  const compression = Math.abs(e1[n] - e3[n]) / atrNow; // spread between fastest and slowest EMA in ATR units
  let transition: EmaAlignment["transition"] = "none";
  for (let i = n; i > n - 5 && i > 0; i--) if (st(i) !== st(i - 1) && st(i) !== "mixed") { transition = st(i) === "bull" ? "to_bull" : "to_bear"; break; }
  const dir = state === "bull" ? 1 : state === "bear" ? -1 : 0;
  const slope = (e2[n] - e2[n - 5]) / (5 * atrNow);
  const continuation = dir !== 0 && Math.sign(slope) === dir && close[n] * dir > e1[n] * dir - 0.5 * atrNow;
  // Potential reversal: price crossed the slow EMA against a prior established alignment.
  const potentialReversal = dir !== 0 && (close[n] - e3[n]) * dir < 0;
  return { state, compressed: compression < 0.6, compression, transition, continuation, potentialReversal, ema9: e1[n], ema21: e2[n], ema50: e3[n] };
}

// ---------- C. RSI momentum intelligence ----------
export interface RsiIntel {
  value: number; slope: number; acceleration: number; zone: "overbought" | "oversold" | "bullish" | "bearish" | "neutral";
  divergence: "bullish" | "bearish" | "none"; exhaustion: boolean;
  /** Always false: overbought/oversold readings are context, never an automatic reversal instruction. */
  reversalInstruction: false;
}
export function rsiIntel(rows: Kline[], period = 14): RsiIntel {
  const close = rows.map(r => r[4]), r = rsiSeries(close, period), n = close.length - 1, v = r[n];
  const slope = (v - r[n - 3]) / 3, prevSlope = (r[n - 3] - r[n - 6]) / 3, accel = slope - prevSlope;
  const zone = v >= 70 ? "overbought" : v <= 30 ? "oversold" : v >= 55 ? "bullish" : v <= 45 ? "bearish" : "neutral";
  // Divergence between the two most recent swing pivots in price and the RSI at those pivots.
  const piv = swingPivots(rows, 3, 3, 120), highs = piv.filter(p => p.kind === "high"), lows = piv.filter(p => p.kind === "low");
  let divergence: RsiIntel["divergence"] = "none";
  if (highs.length >= 2) { const a = highs.at(-2)!, b = highs.at(-1)!; if (b.price > a.price && r[b.index] < r[a.index] - 2) divergence = "bearish"; }
  if (divergence === "none" && lows.length >= 2) { const a = lows.at(-2)!, b = lows.at(-1)!; if (b.price < a.price && r[b.index] > r[a.index] + 2) divergence = "bullish"; }
  const exhaustion = (v >= 70 && slope < 0 && accel < 0) || (v <= 30 && slope > 0 && accel > 0);
  return { value: v, slope, acceleration: accel, zone, divergence, exhaustion, reversalInstruction: false };
}

// ---------- D. Breakout intelligence ----------
export interface BreakoutIntel {
  breakout: "bullish" | "bearish" | "none"; confirmed: boolean; closeConfirmed: boolean; volumeConfirmed: boolean; momentumConfirmed: boolean; structureConfirmed: boolean;
  failed: "bullish" | "bearish" | "none"; liquiditySweep: "bullish" | "bearish" | "none"; squeeze: boolean; squeezeReleased: boolean;
  level: number | null; relativeVolume: number;
}
export function breakoutIntel(rows: Kline[], atrNow: number, lookback = 20): BreakoutIntel {
  const n = rows.length - 1, last = rows[n], prior = rows.slice(n - lookback, n);
  const hi = Math.max(...prior.map(r => r[2])), lo = Math.min(...prior.map(r => r[3]));
  const vBase = mean(rows.slice(n - lookback, n).map(r => r[5])), rv = vBase > 0 ? last[5] / vBase : 0;
  const body = Math.abs(last[4] - last[1]);
  const breakout = last[4] > hi ? "bullish" : last[4] < lo ? "bearish" : "none";
  const dir = breakout === "bullish" ? 1 : breakout === "bearish" ? -1 : 0;
  const closeConfirmed = dir !== 0 && body >= 0.4 * atrNow && ((dir > 0 ? last[4] - last[3] : last[2] - last[4]) / Math.max(last[2] - last[3], 1e-12)) >= 0.6;
  const volumeConfirmed = dir !== 0 && rv >= 1.3;
  const e = ema(rows.map(r => r[4]), 21), momentumConfirmed = dir !== 0 && Math.sign(e[n] - e[n - 3]) === dir;
  const st = marketStructure(rows), structureConfirmed = dir !== 0 && (st.bias === "neutral" || st.bias === (dir > 0 ? "bull" : "bear"));
  // Failed breakout: one of the last 3 closed bars broke the prior range but the latest close is back inside it.
  let failed: BreakoutIntel["failed"] = "none";
  const win = rows.slice(n - 3, n), rng = rows.slice(n - 3 - lookback, n - 3);
  if (rng.length === lookback) {
    const rh = Math.max(...rng.map(r => r[2])), rl = Math.min(...rng.map(r => r[3]));
    if (win.some(r => r[4] > rh) && last[4] <= rh) failed = "bullish";
    else if (win.some(r => r[4] < rl) && last[4] >= rl) failed = "bearish";
  }
  // Liquidity sweep: the wick pierces the prior extreme but the candle closes back inside the range.
  const liquiditySweep: BreakoutIntel["liquiditySweep"] = last[2] > hi && last[4] < hi && (last[2] - Math.max(last[1], last[4])) > 0.5 * (last[2] - last[3]) ? "bearish"
    : last[3] < lo && last[4] > lo && (Math.min(last[1], last[4]) - last[3]) > 0.5 * (last[2] - last[3]) ? "bullish" : "none";
  const atrS = atrSeries(rows).filter(Number.isFinite), aNow = atrS.at(-1)!, aHist = atrS.slice(-100);
  const pct = aHist.filter(v => v <= aNow).length / aHist.length;
  const prevAtr = atrS.at(-6) ?? aNow;
  const squeeze = pct <= 0.2, squeezeReleased = aNow > prevAtr * 1.2 && atrS.slice(-12, -2).some(v => aHist.filter(h => h <= v).length / aHist.length <= 0.25);
  return { breakout, confirmed: dir !== 0 && closeConfirmed && volumeConfirmed && momentumConfirmed && structureConfirmed, closeConfirmed, volumeConfirmed, momentumConfirmed, structureConfirmed, failed, liquiditySweep, squeeze, squeezeReleased, level: dir > 0 ? hi : dir < 0 ? lo : null, relativeVolume: rv };
}
/** A retest is a pullback to a previously broken level that holds. Checked over the last `window` bars. */
export function retestOf(rows: Kline[], level: number, dir: 1 | -1, atrNow: number, window = 6): boolean {
  const n = rows.length - 1, tail = rows.slice(n - window + 1);
  const touched = tail.some(r => (dir > 0 ? r[3] <= level + 0.3 * atrNow : r[2] >= level - 0.3 * atrNow));
  const held = tail.every(r => (dir > 0 ? r[4] >= level - 0.3 * atrNow : r[4] <= level + 0.3 * atrNow));
  return touched && held && (rows[n][4] - level) * dir > 0;
}

// ---------- E/F. Adaptive volatility filter + signal quality ----------
export interface AdaptiveThreshold { threshold: number; adx: number; reasons: string[] }
/** Minimum |score| required to act. It rises in noisy, directionless or high-volatility conditions to suppress BUY/SELL flip-flopping. */
export function adaptiveThreshold(adx: number, volPct: number, compressed: boolean, base = 35): AdaptiveThreshold {
  let t = base; const reasons: string[] = [];
  if (adx < 18) { t += 15; reasons.push(`ADX ${adx.toFixed(0)} shows no trend: threshold raised`); }
  else if (adx > 30) { t -= 5; reasons.push(`ADX ${adx.toFixed(0)} shows a strong trend: threshold relaxed`); }
  if (volPct >= 0.9) { t += 10; reasons.push("Volatility is extreme: threshold raised"); }
  if (compressed) { t += 5; reasons.push("EMAs are compressed: threshold raised"); }
  return { threshold: t, adx, reasons };
}

export function gainzEngine(inp: EngineInput): EngineSignal {
  const now = inp.now ?? Date.now(), execTf = EXECUTION_TF[inp.strategy], rows = inp.candles[execTf];
  const base = { engine: "gainz" as const, symbol: inp.symbol, confidenceType: "heuristic_score_not_probability" as const, expectedHolding: HOLDING_PERIOD[inp.strategy], generatedAt: new Date(now).toISOString() };
  const neutral = (why: string[], extra: Partial<EngineSignal> = {}): EngineSignal => ({ ...base, status: "NEUTRAL", direction: 0, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, regime: "unknown", evidence: why, invalidation: [], expiresAt: null, details: {}, ...extra });
  if (!rows || rows.length < 100) return neutral([`Execution timeframe ${execTf} has fewer than 100 valid candles`]);
  const age = (now - rows.at(-1)![0]) / 1000;
  if (age < -60 || age > TF_SECONDS[execTf] * 3) return neutral([`Execution candles are stale (${Math.round(age)}s old)`]);
  const a = atrSeries(rows).at(-1)!, adx = adxSeries(rows).adx.at(-1)!;
  if (!Number.isFinite(a) || !Number.isFinite(adx) || a <= 0) return neutral(["Indicator inputs are not finite"]);
  const regime = classifyRegime(rows);
  if (!regime.profile.allowNewEntries) return neutral([`Regime ${regime.regime} suspends new entries`], { regime: regime.regime });
  const vol = volatility(rows), al = emaAlignment(rows, a), rs = rsiIntel(rows), bo = breakoutIntel(rows, a), st = marketStructure(rows);
  const price = rows.at(-1)![4], th = adaptiveThreshold(adx, vol.percentile, al.compressed);

  // Directional score: each family adds or subtracts bounded points; no single family can exceed its cap.
  let score = 0; const ev: string[] = [];
  const add = (pts: number, text: string) => { score += pts; ev.push(`${pts >= 0 ? "+" : ""}${pts} ${text}`); };
  if (al.state === "bull") add(al.continuation ? 28 : 18, `EMA 9/21/50 bullish alignment${al.continuation ? " with continuation" : ""}`);
  else if (al.state === "bear") add(al.continuation ? -28 : -18, `EMA 9/21/50 bearish alignment${al.continuation ? " with continuation" : ""}`);
  else ev.push("EMA 9/21/50 not aligned");
  if (al.transition !== "none") add(al.transition === "to_bull" ? 6 : -6, `Fresh EMA alignment transition ${al.transition}`);
  // RSI: slope and acceleration confirm momentum; extremes only dampen conviction, they never flip direction.
  if (rs.value >= 50 && rs.slope > 0) add(Math.min(16, 8 + (rs.acceleration > 0 ? 4 : 0) + (rs.value < 70 ? 4 : 0)), `RSI ${rs.value.toFixed(0)} rising${rs.acceleration > 0 ? " and accelerating" : ""}`);
  else if (rs.value <= 50 && rs.slope < 0) add(-Math.min(16, 8 + (rs.acceleration < 0 ? 4 : 0) + (rs.value > 30 ? 4 : 0)), `RSI ${rs.value.toFixed(0)} falling${rs.acceleration < 0 ? " and accelerating" : ""}`);
  else ev.push(`RSI ${rs.value.toFixed(0)} gives no directional momentum`);
  if (rs.divergence === "bearish") add(-8, "Bearish RSI divergence"); else if (rs.divergence === "bullish") add(8, "Bullish RSI divergence");
  if (bo.breakout !== "none") {
    const s = bo.breakout === "bullish" ? 1 : -1, pts = bo.confirmed ? 24 : 6;
    add(s * pts, bo.confirmed ? `${bo.breakout} breakout confirmed by candle close, volume ${bo.relativeVolume.toFixed(2)}x, momentum and structure` : `${bo.breakout} breakout NOT fully confirmed (close:${bo.closeConfirmed} volume:${bo.volumeConfirmed} momentum:${bo.momentumConfirmed} structure:${bo.structureConfirmed})`);
    if (bo.confirmed && bo.level !== null && retestOf(rows.slice(0, -1), bo.level, s as 1 | -1, a)) add(s * 4, "Breakout level retest held");
  }
  if (bo.failed !== "none") add(bo.failed === "bullish" ? -14 : 14, `Failed ${bo.failed} breakout`);
  if (bo.liquiditySweep !== "none") add(bo.liquiditySweep === "bullish" ? 8 : -8, `Liquidity sweep reclaimed (${bo.liquiditySweep})`);
  if (bo.squeezeReleased) ev.push("Volatility squeeze has released: breakouts carry more weight");
  if (st.bias !== "neutral") add(st.bias === "bull" ? 8 : -8, `Swing structure ${st.bias === "bull" ? "higher highs/lows" : "lower highs/lows"}`);
  score = Math.max(-100, Math.min(100, score));

  const details = { ema: al, rsi: rs, breakout: bo, volatility: vol, threshold: th, score };
  const dir: 1 | -1 | 0 = score >= th.threshold ? 1 : score <= -th.threshold ? -1 : 0;
  if (dir === 0) return neutral([...ev, `|score| ${Math.abs(score).toFixed(0)} below adaptive threshold ${th.threshold}`, ...th.reasons], { regime: regime.regime, details });

  // Signal-quality filter: independent gates. Any hard failure invalidates the candidate.
  const gates: { name: string; pass: boolean; hard: boolean }[] = [
    { name: "trend confirmation", pass: al.state === (dir > 0 ? "bull" : "bear") || bo.confirmed, hard: true },
    { name: "momentum", pass: rs.slope * dir >= 0 && !rs.exhaustion, hard: false },
    { name: "volume", pass: bo.relativeVolume >= 0.8, hard: false },
    { name: "volatility", pass: vol.classification !== "extreme", hard: true },
    { name: "market structure", pass: st.bias === "neutral" || st.bias === (dir > 0 ? "bull" : "bear"), hard: false },
    { name: "no failed breakout against", pass: bo.failed !== (dir > 0 ? "bullish" : "bearish"), hard: true },
  ];
  const failed = gates.filter(g => !g.pass), hardFail = failed.filter(g => g.hard);
  const levels = computeLevels(price, dir, a, vol.classification, st, { stopMult: regime.profile.stopMult, maxStopPct: inp.maxStopPct ?? 5 });
  if (levels.riskRewardToTP3 < 1.5) failed.push({ name: "risk/reward", pass: false, hard: true }), hardFail.push({ name: "risk/reward", pass: false, hard: true });
  if (levels.exceedsMaxStop) hardFail.push({ name: "stop distance", pass: false, hard: true });
  if (hardFail.length || failed.length >= 3) return { ...base, status: "INVALIDATED", direction: dir, entryZone: null, stopLoss: null, takeProfits: null, confidence: 0, regime: regime.regime, evidence: [...ev, `Quality filter rejected: ${failed.map(f => f.name).join(", ")}`], invalidation: [], expiresAt: null, details: { ...details, gates } };
  const expires = now + TF_SECONDS[execTf] * 6 * 1000;
  const confidence = Math.round(clamp((Math.abs(score) - th.threshold) / (100 - th.threshold) * 40 + 40 + (6 - gates.filter(g => !g.pass).length) * 3 - failed.length * 6));
  return { ...base, status: "SIGNAL", direction: dir, entryZone: levels.entryZone, stopLoss: levels.stop, takeProfits: levels.targets.map(t => ({ label: t.label, price: t.price, rewardRisk: t.rewardRisk })), confidence, regime: regime.regime,
    evidence: [...ev, ...th.reasons, ...(failed.length ? [`Soft cautions: ${failed.map(f => f.name).join(", ")}`] : [])],
    invalidation: [`Close beyond stop ${levels.stop.toFixed(4)}`, "Fast EMA alignment reverses with a closed candle through EMA 50", "Failed breakout against the position", `Signal expires ${new Date(expires).toISOString()}`, "Stops are never widened to avoid a loss"],
    expiresAt: new Date(expires).toISOString(), details: { ...details, gates, levels } };
}

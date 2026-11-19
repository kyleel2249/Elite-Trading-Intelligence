// Technical & institutional signal intelligence: regime-adaptive weighted fusion of the indicator suite with SMC, order-flow and derivatives evidence,
// conflict detection, false-signal filters, multi-timeframe confluence, walk-forward validation and a risk-adjusted trade plan.
// Read-only: it never submits an order and never enables execution. It extends (does not replace) the ETI engines it reads from.
import type { Kline } from "../market.ts";
import { classifyRegime, MIN_REGIME_CANDLES, type RegimeResult } from "../algo/regime.ts";
import { computeLevels, type TradeLevels } from "../algo/levels.ts";
import { marketStructure } from "../algo/timeframes.ts";
import { volatility } from "../algo/indicators.ts";
import { wilson } from "../algo/performance.ts";
import { analyzeDerivativesContext, type DerivativesSnapshot } from "../algo/derivatives.ts";
import { analyzeSmc } from "./smc-intel.ts";
import { analyzeFundingHistory, analyzeOpenInterest, estimateLiquidationZones, type FundingPoint, type OiPoint } from "./derivatives-intel.ts";
import { computeSuite, swingFib, type Suite } from "./indicator-suite.ts";

export type Dir = 1 | -1 | 0;
export type Mode = "trend" | "range" | "transition";
export type VoteGroup = "trend" | "momentum" | "volatility" | "volume" | "structure" | "orderflow";
export interface Vote { id: string; label: string; group: VoteGroup; style: "trend" | "reversion"; direction: Dir; strength: number; weight: number; detail: string }

export const SIGNAL_THRESHOLD = 30;
export const WARMUP = 80;
export const MIN_CANDLES = 120;
const fin = (x: number | undefined | null): x is number => typeof x === "number" && Number.isFinite(x);
const sgn = (x: number): Dir => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r6 = (x: number | null | undefined): number | null => (fin(x) ? Number(x.toPrecision(9)) : null);

/** Cheap, causal regime switch used identically for live fusion, chart markers and validation (the named regime from classifyRegime is reported separately). */
export function modeAt(s: Suite, i: number): Mode {
  const adx = s.adx.adx[i];
  return !fin(adx) ? "transition" : adx >= 22 ? "trend" : adx < 18 ? "range" : "transition";
}

const BASE: Record<string, [number, VoteGroup, "trend" | "reversion"]> = {
  ema_stack: [1.2, "trend", "trend"], ichimoku: [1.3, "trend", "trend"], supertrend: [1.2, "trend", "trend"], adx_di: [1.0, "trend", "trend"], macd: [1.0, "trend", "trend"], vwap: [0.6, "trend", "trend"],
  rsi: [0.9, "momentum", "reversion"], cci: [0.6, "momentum", "reversion"], mfi: [0.6, "momentum", "reversion"], bollinger: [0.8, "volatility", "reversion"],
  obv: [0.7, "volume", "trend"], cvd_proxy: [0.5, "volume", "trend"],
};
function mk(id: string, label: string, mode: Mode, dir: Dir, strength: number, detail: string): Vote {
  const [w, group, style] = BASE[id];
  const mult = mode === "trend" ? (style === "trend" ? 1.25 : 0.6) : mode === "range" ? (style === "trend" ? 0.6 : 1.3) : 1;
  return { id, label, group, style, direction: dir, strength: clamp(strength, 0, 1), weight: Number((w * mult).toFixed(3)), detail };
}

/** All indicator votes at bar i, using only bars 0..i. */
export function votesAt(rows: Kline[], s: Suite, i: number, mode: Mode = modeAt(s, i)): Vote[] {
  const v: Vote[] = [], c = s.close[i], f = (x: number, d = 2) => (fin(x) ? x.toFixed(d) : "n/a");
  // Trend
  if (fin(s.ema20[i]) && fin(s.ema50[i]) && i >= 49) {
    const e200 = i >= 199 ? s.ema200[i] : NaN, hasLong = fin(e200);
    const bull = c > s.ema20[i] && s.ema20[i] > s.ema50[i] && (!hasLong || s.ema50[i] > e200), bear = c < s.ema20[i] && s.ema20[i] < s.ema50[i] && (!hasLong || s.ema50[i] < e200);
    const half = !bull && !bear ? (c > s.ema50[i] && s.ema20[i] > s.ema50[i] ? 1 : c < s.ema50[i] && s.ema20[i] < s.ema50[i] ? -1 : 0) : 0;
    v.push(mk("ema_stack", "EMA 20/50/200 stack", mode, bull ? 1 : bear ? -1 : (half as Dir), bull || bear ? 1 : half ? 0.5 : 0, `close ${f(c)} vs EMA20 ${f(s.ema20[i])}, EMA50 ${f(s.ema50[i])}${hasLong ? `, EMA200 ${f(e200)}` : " (EMA200 needs 200 bars)"}`));
  }
  const ca = s.ich.cloudA[i], cb = s.ich.cloudB[i], tk = s.ich.tenkan[i], kj = s.ich.kijun[i];
  if (fin(ca) && fin(cb) && fin(tk) && fin(kj)) {
    const top = Math.max(ca, cb), bot = Math.min(ca, cb), pos = c > top ? 1 : c < bot ? -1 : 0, cross = tk > kj ? 1 : tk < kj ? -1 : 0, chk = s.ich.chikou[i];
    const sc = pos * 0.5 + cross * 0.3 + chk * 0.2;
    v.push(mk("ichimoku", "Ichimoku cloud", mode, Math.abs(sc) >= 0.5 ? sgn(sc) : 0, Math.abs(sc), `price ${pos > 0 ? "above" : pos < 0 ? "below" : "inside"} the cloud, Tenkan ${cross > 0 ? "above" : cross < 0 ? "below" : "level with"} Kijun, Chikou ${chk > 0 ? "confirms bullish" : chk < 0 ? "confirms bearish" : "neutral"}`));
  }
  if (s.st.dir[i] !== 0) {
    const fresh = s.st.flippedAt[i] >= 0 && i - s.st.flippedAt[i] <= 3;
    v.push(mk("supertrend", "Supertrend (10, 3)", mode, s.st.dir[i] as Dir, fresh ? 1 : 0.7, `${s.st.dir[i] > 0 ? "bullish" : "bearish"}${fresh ? ", fresh flip within 3 bars" : ""}, line ${f(s.st.line[i])}`));
  }
  const adx = s.adx.adx[i], pdi = s.adx.plusDI[i], mdi = s.adx.minusDI[i];
  if (fin(adx) && fin(pdi) && fin(mdi)) v.push(mk("adx_di", "ADX / DI", mode, adx >= 20 ? sgn(pdi - mdi) : 0, adx >= 20 ? clamp((adx - 20) / 25 + 0.4, 0, 1) : 0, `ADX ${f(adx, 1)} (${adx >= 20 ? "trending" : "no trend"}), +DI ${f(pdi, 1)}, -DI ${f(mdi, 1)}`));
  const h = s.macd.hist[i], hp = s.macd.hist[i - 1];
  if (fin(h) && fin(hp)) {
    const cross = (h > 0) !== (hp > 0), rising = h > hp;
    v.push(mk("macd", "MACD histogram", mode, sgn(h), clamp((h > 0 === rising ? 0.7 : 0.35) + (cross ? 0.3 : 0), 0, 1), `histogram ${f(h, 4)} ${rising ? "rising" : "falling"}${cross ? ", fresh zero-line cross" : ""}`));
  }
  if (fin(s.vwap.vwap[i])) v.push(mk("vwap", "Session VWAP", mode, c > s.vwap.vwap[i] ? 1 : c < s.vwap.vwap[i] ? -1 : 0, 0.5, `close ${f(c)} ${c > s.vwap.vwap[i] ? "above" : "below"} VWAP ${f(s.vwap.vwap[i])}`));
  // Momentum: trend-following in trends, mean-reverting in ranges
  const rsi = s.rsi[i];
  if (fin(rsi)) {
    const d: Dir = mode === "range" ? (rsi < 30 ? 1 : rsi > 70 ? -1 : 0) : rsi >= 50 && rsi < 70 ? 1 : rsi <= 50 && rsi > 30 ? -1 : 0;
    v.push(mk("rsi", "RSI (14)", mode, d, mode === "range" ? (d ? 0.8 : 0) : d ? 0.6 : rsi >= 70 || rsi <= 30 ? 0.0 : 0, `RSI ${f(rsi, 1)}${rsi >= 70 ? " overbought" : rsi <= 30 ? " oversold" : ""}; read as ${mode === "range" ? "mean-reversion" : "trend momentum"}`));
  }
  const cci = s.cci[i];
  if (fin(cci)) {
    const d: Dir = mode === "range" ? (cci < -150 ? 1 : cci > 150 ? -1 : 0) : cci > 100 ? 1 : cci < -100 ? -1 : 0;
    v.push(mk("cci", "CCI (20)", mode, d, d ? clamp(Math.abs(cci) / 200, 0.4, 1) : 0, `CCI ${f(cci, 0)}`));
  }
  const mfi = s.mfi[i];
  if (fin(mfi)) {
    const d: Dir = mode === "range" ? (mfi < 20 ? 1 : mfi > 80 ? -1 : 0) : mfi > 55 && mfi < 85 ? 1 : mfi < 45 && mfi > 15 ? -1 : 0;
    v.push(mk("mfi", "Money Flow Index", mode, d, d ? 0.6 : 0, `MFI ${f(mfi, 1)}`));
  }
  const pb = s.bb.pctB[i], bw = s.bb.bandwidth[i];
  if (fin(pb)) {
    const expanding = fin(bw) && fin(s.bb.bandwidth[i - 3]) && bw > s.bb.bandwidth[i - 3];
    const d: Dir = mode === "range" ? (pb > 1 ? -1 : pb < 0 ? 1 : 0) : pb > 1 && expanding ? 1 : pb < 0 && expanding ? -1 : 0;
    v.push(mk("bollinger", "Bollinger Bands", mode, d, d ? 0.7 : 0, `%B ${f(pb, 2)}, bandwidth ${expanding ? "expanding" : "not expanding"}`));
  }
  // Volume
  if (fin(s.obv[i]) && fin(s.obvEma[i]) && i >= 10) {
    const obvUp = s.obv[i] > s.obv[i - 10], pxUp = c > s.close[i - 10], diverge = obvUp !== pxUp;
    v.push(mk("obv", "On-Balance Volume", mode, sgn(s.obv[i] - s.obvEma[i]), diverge ? 0.3 : 0.6, `OBV ${s.obv[i] > s.obvEma[i] ? "above" : "below"} its EMA20${diverge ? "; diverges from price over 10 bars" : ""}`));
    const cv = s.cvd.cvd; const cUp = cv[i] > cv[i - 10];
    v.push(mk("cvd_proxy", "CVD (candle proxy)", mode, cUp ? 1 : -1, cUp === pxUp ? 0.5 : 0.25, `candle-based delta ${cUp ? "rising" : "falling"} over 10 bars${cUp === pxUp ? "" : ", diverging from price"} (approximation: candles carry no taker side)`));
  }
  return v;
}

export interface Fusion { score: number; direction: Dir; bullShare: number; conflicted: boolean; agreement: number; groups: Record<string, { net: number; dir: Dir }>; groupsAgree: number; groupsTotal: number; votesAgree: number; votesTotal: number }
export function fuse(votes: Vote[], threshold = SIGNAL_THRESHOLD): Fusion {
  let num = 0, den = 0, bull = 0, bear = 0;
  const g: Record<string, { n: number; d: number }> = {};
  for (const x of votes) {
    num += x.weight * x.direction * x.strength; den += x.weight;
    if (x.direction === 1) bull += x.weight * x.strength; else if (x.direction === -1) bear += x.weight * x.strength;
    const e = g[x.group] ?? { n: 0, d: 0 }; e.n += x.weight * x.direction * x.strength; e.d += x.weight; g[x.group] = e;
  }
  const score = den > 0 ? clamp(100 * num / den, -100, 100) : 0, direction: Dir = Math.abs(score) >= threshold ? sgn(score) : 0, tot = bull + bear;
  const groups: Fusion["groups"] = {};
  for (const [k, e] of Object.entries(g)) { const net = e.d ? e.n / e.d : 0; groups[k] = { net: Number(net.toFixed(3)), dir: Math.abs(net) >= 0.15 ? sgn(net) : 0 }; }
  const gd = Object.values(groups), agreeing = direction ? votes.filter((x) => x.direction === direction).length : 0;
  return {
    score: Number(score.toFixed(2)), direction, bullShare: tot ? bull / tot : 0.5, conflicted: tot > 0 && Math.min(bull, bear) / tot >= 0.35, agreement: tot ? Math.max(bull, bear) / tot : 0,
    groups, groupsAgree: direction ? gd.filter((x) => x.dir === direction).length : 0, groupsTotal: gd.length, votesAgree: agreeing, votesTotal: votes.length,
  };
}

/** Per-bar causal fused signal with the cheap gate shared by chart markers and walk-forward validation. */
export function signalAt(rows: Kline[], s: Suite, i: number): { score: number; dir: Dir; gated: Dir } {
  const f = fuse(votesAt(rows, s, i));
  const stretched = fin(s.atr[i]) && fin(s.ema20[i]) && f.direction !== 0 && (s.close[i] - s.ema20[i]) * f.direction / s.atr[i] >= 2.5;
  const gated: Dir = f.direction !== 0 && !f.conflicted && f.groupsAgree >= 3 && !stretched ? f.direction : 0;
  return { score: f.score, dir: f.direction, gated };
}

export interface Marker { t: number; dir: 1 | -1; price: number; score: number; label: "BUY" | "SELL" }
/** BUY/SELL markers at the close of the bar that produced them. Each uses only data up to that bar, so adding later candles never moves or removes one. */
export function signalMarkers(rows: Kline[], s: Suite, from = WARMUP, cooldown = 5): Marker[] {
  const out: Marker[] = []; let prev: Dir = 0, last = -1e9;
  for (let i = from; i < rows.length; i++) {
    const g = signalAt(rows, s, i).gated;
    if (g !== 0 && g !== prev && i - last >= cooldown) { out.push({ t: rows[i][0], dir: g, price: rows[i][4], score: signalAt(rows, s, i).score, label: g === 1 ? "BUY" : "SELL" }); last = i; }
    prev = g;
  }
  return out;
}

export const VALIDATION_BARRIER = { stopAtr: 1.5, targetAtr: 2.25, breakevenWinRate: 0.4, costBps: 12 };
export interface Validation {
  status: "sufficient" | "insufficient_sample" | "insufficient_history"; scope: "indicator_core_walk_forward"; candlesUsed: number; horizonBars: number; n: number; wins: number; losses: number; expired: number;
  winRate: number | null; ci95: { low: number; high: number } | null; expectancyR: number | null; inverseWinRate: number | null; edge: number | null; breakevenWinRate: number; barrier: { stopAtr: number; targetAtr: number }; costBps: number; note: string;
}
/** Walk-forward replay: every sample uses only data available at its bar, entry is the NEXT bar's open, costs are deducted, and a bar touching both barriers counts as a loss. */
export function walkForward(rows: Kline[], s: Suite = computeSuite(rows), horizon = 12, minSample = 30): Validation {
  const B = VALIDATION_BARRIER, base = { scope: "indicator_core_walk_forward" as const, candlesUsed: rows.length, horizonBars: horizon, breakevenWinRate: B.breakevenWinRate, barrier: { stopAtr: B.stopAtr, targetAtr: B.targetAtr }, costBps: B.costBps };
  const empty = (status: Validation["status"], note: string): Validation => ({ ...base, status, n: 0, wins: 0, losses: 0, expired: 0, winRate: null, ci95: null, expectancyR: null, inverseWinRate: null, edge: null, note });
  if (rows.length < WARMUP + horizon + 20) return empty("insufficient_history", `Need at least ${WARMUP + horizon + 20} closed candles; received ${rows.length}.`);
  const run = (i: number, dir: 1 | -1) => {
    const entry = rows[i + 1][1], atr = s.atr[i]; if (!(atr > 0) || !(entry > 0)) return null;
    const stop = entry - dir * B.stopAtr * atr, tgt = entry + dir * B.targetAtr * atr, risk = B.stopAtr * atr, cost = (entry * B.costBps / 10000) / risk;
    for (let j = i + 1; j <= i + horizon && j < rows.length; j++) {
      const hitStop = dir > 0 ? rows[j][3] <= stop : rows[j][2] >= stop, hitTgt = dir > 0 ? rows[j][2] >= tgt : rows[j][3] <= tgt;
      if (hitStop) return { out: "loss" as const, r: -1 - cost };
      if (hitTgt) return { out: "win" as const, r: B.targetAtr / B.stopAtr - cost };
    }
    const endC = rows[Math.min(i + horizon, rows.length - 1)][4];
    return { out: "expired" as const, r: clamp((endC - entry) * dir / risk, -1, B.targetAtr / B.stopAtr) - cost };
  };
  let wins = 0, losses = 0, expired = 0, rSum = 0, invWins = 0, invN = 0, n = 0, prev: Dir = 0;
  for (let i = WARMUP; i < rows.length - horizon - 1; i++) {
    const g = signalAt(rows, s, i).gated;
    if (g !== 0 && g !== prev) {
      const res = run(i, g as 1 | -1), inv = run(i, (-g) as 1 | -1);
      if (res) { n++; rSum += res.r; if (res.out === "win") wins++; else if (res.out === "loss") losses++; else expired++; if (inv) { invN++; if (inv.out === "win") invWins++; } i += horizon - 1; prev = 0; continue; }
    }
    prev = g;
  }
  if (n === 0) return empty("insufficient_sample", "The indicator core produced no gated signals in this window.");
  const winRate = wins / n, ci = wilson(wins, n);
  return { ...base, status: n >= minSample ? "sufficient" : "insufficient_sample", n, wins, losses, expired, winRate: Number(winRate.toFixed(4)), ci95: ci ? { low: Number(ci.low.toFixed(4)), high: Number(ci.high.toFixed(4)) } : null,
    expectancyR: Number((rSum / n).toFixed(3)), inverseWinRate: invN ? Number((invWins / invN).toFixed(4)) : null, edge: invN ? Number((winRate - invWins / invN).toFixed(4)) : null,
    note: n >= minSample ? "Walk-forward replay of the indicator core on this symbol and timeframe. Past performance does not guarantee future results." : `Only ${n} samples (< ${minSample}); the estimate is too noisy to calibrate confidence.` };
}

export interface TfView { timeframe: string; weight: number; score: number; direction: Dir; mode: Mode; candles: number }
const TF_WEIGHT: Record<string, number> = { "1m": 0.5, "5m": 1, "15m": 1.5, "30m": 1.75, "1h": 2, "4h": 2.5, "1d": 3, "1w": 3 };
export const TF_MS: Record<string, number> = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3, "1w": 604800e3 };
const closedOnly = (rows: Kline[], tfMs: number, now: number) => { let e = rows.length; while (e > 0 && rows[e - 1][0] + tfMs > now) e--; return rows.slice(0, e); };

export interface FilterResult { id: string; pass: boolean; severity: "block" | "downgrade"; detail: string }
export interface SignalIntelInput {
  symbol: string; timeframe: string; market: "spot" | "futures"; now: number;
  candles: Record<string, Kline[]>; validationRows?: Kline[];
  orderflow?: { trades: number; deltaPct: number; cumulativeDelta: number; depthImbalance: number; spreadBps: number } | null;
  derivatives?: DerivativesSnapshot | null; oi?: OiPoint[] | null; funding?: FundingPoint[] | null;
}

export function buildSignalIntel(inp: SignalIntelInput) {
  const tfMs = TF_MS[inp.timeframe] ?? 3600e3, rows = closedOnly(inp.candles[inp.timeframe] ?? [], tfMs, inp.now);
  const base = { schema: "eti.signal-intel/1", symbol: inp.symbol, timeframe: inp.timeframe, market: inp.market, generatedAt: new Date(inp.now).toISOString(), nonRepainting: true as const, closedCandlesOnly: true as const, canTriggerTrade: false as const, submitsOrder: false as const, liveExecutionAllowed: false as const };
  if (rows.length < MIN_CANDLES) return { ...base, status: "insufficient_history" as const, action: "WAIT" as const, candles: rows.length, reason: `Need at least ${MIN_CANDLES} closed candles on ${inp.timeframe}; received ${rows.length}.` };
  const n = rows.length, i = n - 1, s = computeSuite(rows), mode = modeAt(s, i), price = rows[i][4], atr = s.atr[i];
  const regime: RegimeResult = classifyRegime(rows), vol = volatility(rows), structure = marketStructure(rows);
  const votes = votesAt(rows, s, i, mode);
  // SMC evidence (existing ETI engine, closed candles only)
  const smc = analyzeSmc(rows, inp.timeframe), smcNotes: string[] = [];
  if (smc.status === "ready") {
    const sv = (id: string, label: string, dir: Dir, strength: number, weight: number, detail: string) => { if (dir) votes.push({ id, label, group: "structure", style: "trend", direction: dir, strength, weight, detail }); };
    const dirOf = (d: string): Dir => (d === "bullish" ? 1 : d === "bearish" ? -1 : 0);
    const ev = smc.detections.filter((d) => (d.kind === "choch" || d.kind === "bos") && d.confirmation === "confirmed" && d.freshnessBars <= 20).sort((a, b) => a.freshnessBars - b.freshnessBars)[0];
    if (ev) sv(ev.kind, ev.kind === "choch" ? "Change of Character" : "Break of Structure", dirOf(ev.direction), 0.8, ev.kind === "choch" ? 1.2 : 1.0, `${ev.direction} ${ev.kind.toUpperCase()} ${ev.freshnessBars} bars ago at ${ev.zone.low}`);
    const inZone = (d: { zone: { low: number; high: number } }) => price >= d.zone.low && price <= d.zone.high;
    const ob = smc.detections.find((d) => d.kind === "order_block" && d.state === "active" && d.confirmation === "confirmed" && inZone(d));
    if (ob) sv("order_block", "Order block", dirOf(ob.direction), 0.8, 0.9, `price is inside an active ${ob.direction} order block ${ob.zone.low}-${ob.zone.high}`);
    const fvg = smc.detections.find((d) => d.kind === "fair_value_gap" && (d.state === "open" || d.state === "partially_filled") && inZone(d));
    if (fvg) sv("fair_value_gap", "Fair value gap", dirOf(fvg.direction), 0.6, 0.6, `price is inside an unfilled ${fvg.direction} gap ${fvg.zone.low}-${fvg.zone.high}`);
    const sw = smc.detections.find((d) => d.kind === "liquidity_sweep" && d.state === "reclaimed" && d.freshnessBars <= 10);
    if (sw) sv("liquidity_sweep", "Liquidity sweep reclaimed", dirOf(sw.direction), 0.8, 0.9, `${sw.direction} sweep reclaimed ${sw.freshnessBars} bars ago`);
    if (smc.premiumDiscount && !smc.premiumDiscount.outsideRange && smc.premiumDiscount.zone !== "equilibrium") sv("premium_discount", "Premium / discount", smc.premiumDiscount.zone === "discount" ? 1 : -1, 0.4, 0.5, `price in the ${smc.premiumDiscount.zone} half of the range (${smc.premiumDiscount.positionPct.toFixed(0)}%)`);
  } else smcNotes.push(smc.reason ?? "SMC unavailable");
  // Order-flow evidence (only when real trades/depth were supplied)
  const of = inp.orderflow ?? null;
  if (of && of.trades >= 30 && Math.abs(of.deltaPct) >= 10) votes.push({ id: "tape_delta", label: "Tape delta (exchange trades)", group: "orderflow", style: "trend", direction: sgn(of.deltaPct), strength: clamp(Math.abs(of.deltaPct) / 40, 0.25, 1), weight: 0.7, detail: `aggressive buy/sell delta ${of.deltaPct.toFixed(1)}% over ${of.trades} recent trades (a short sample)` });
  if (of && Math.abs(of.depthImbalance) >= 0.15) votes.push({ id: "book_imbalance", label: "Order-book imbalance", group: "orderflow", style: "trend", direction: sgn(of.depthImbalance), strength: clamp(Math.abs(of.depthImbalance) / 0.5, 0.3, 1), weight: 0.5, detail: `top-10 depth imbalance ${(of.depthImbalance * 100).toFixed(1)}% (resting orders can be withdrawn)` });
  const fusion = fuse(votes);
  // Multi-timeframe confluence
  const tfs: TfView[] = [];
  for (const [tf, raw] of Object.entries(inp.candles)) {
    const r = closedOnly(raw, TF_MS[tf] ?? 3600e3, inp.now); if (tf === inp.timeframe || r.length < MIN_CANDLES) continue;
    const ss = computeSuite(r), m = modeAt(ss, r.length - 1), f = fuse(votesAt(r, ss, r.length - 1, m));
    tfs.push({ timeframe: tf, weight: TF_WEIGHT[tf] ?? 1, score: f.score, direction: f.direction, mode: m, candles: r.length });
  }
  const higher = tfs.filter((t) => (TF_MS[t.timeframe] ?? 0) > tfMs), htfW = higher.reduce((a, t) => a + t.weight, 0);
  const htfScore = htfW ? higher.reduce((a, t) => a + t.weight * t.score, 0) / htfW : null;
  const allW = tfs.reduce((a, t) => a + t.weight, 0), alignment = fusion.direction && allW ? tfs.filter((t) => t.direction === fusion.direction).reduce((a, t) => a + t.weight, 0) / allW : null;
  // Derivatives
  const dir = fusion.direction, ctx = analyzeDerivativesContext(inp.derivatives ?? null, dir === 0 ? 0 : dir, inp.now);
  const oi = analyzeOpenInterest(inp.oi ?? null, rows), funding = analyzeFundingHistory(inp.funding ?? null);
  const liquidation = inp.market === "futures" ? estimateLiquidationZones(rows, atr) : [];
  // Plan
  let plan: (TradeLevels & { actionable: boolean; suggestedRiskPct: number; sizingNote: string }) | null = null;
  if (dir !== 0 && fin(atr)) {
    const lv = computeLevels(price, dir as 1 | -1, atr, vol.classification, structure, { stopMult: regime.profile.stopMult });
    plan = { ...lv, actionable: false, suggestedRiskPct: 0, sizingNote: "" };
  }
  // Validation
  const validation = walkForward(inp.validationRows && inp.validationRows.length >= rows.length ? closedOnly(inp.validationRows, tfMs, inp.now) : rows);
  // Filters
  const filters: FilterResult[] = [], add = (id: string, pass: boolean, severity: FilterResult["severity"], detail: string) => filters.push({ id, pass, severity, detail });
  const age = inp.now - (rows[i][0] + tfMs);
  add("fresh_data", age <= tfMs * 3, "block", age <= tfMs * 3 ? "last closed candle is current" : `last closed candle is ${Math.round(age / tfMs)} periods old`);
  add("regime_allows_entries", regime.profile.allowNewEntries, "block", `regime ${regime.regime}${regime.profile.allowNewEntries ? "" : " blocks new entries"}`);
  add("no_conflict", !fusion.conflicted, "block", fusion.conflicted ? "bullish and bearish evidence are both substantial; the engines disagree" : "evidence is not materially split");
  add("independent_groups", dir === 0 || fusion.groupsAgree >= 3, "block", `${fusion.groupsAgree} of ${fusion.groupsTotal} evidence groups agree (need 3)`);
  add("min_confirmations", dir === 0 || fusion.votesAgree >= regime.profile.minConfirmations, "block", `${fusion.votesAgree} confirmations (regime needs ${regime.profile.minConfirmations})`);
  const counter = dir !== 0 && htfScore !== null && Math.sign(htfScore) === -dir && Math.abs(htfScore) >= 30, reversal = votes.some((v) => v.id === "choch" && v.direction === dir);
  add("higher_timeframe_alignment", !counter || reversal, "block", htfScore === null ? "no higher timeframe available" : counter && !reversal ? `trades against higher timeframes (score ${htfScore.toFixed(0)}) without a confirmed change of character` : `higher-timeframe score ${htfScore.toFixed(0)}`);
  const ext = fin(s.ema20[i]) && fin(atr) && dir !== 0 ? (price - s.ema20[i]) * dir / atr : 0;
  add("not_overextended", ext < 2.5, "block", `price is ${ext.toFixed(1)} ATR from EMA20 in the signal direction`);
  add("volatility_not_extreme", vol.classification !== "extreme", "block", `volatility ${vol.classification}`);
  if (plan) { add("reward_risk", !plan.exceedsMaxStop && plan.targets[1].rewardRisk >= 1.5, "block", `TP2 reward/risk ${plan.targets[1].rewardRisk.toFixed(2)}${plan.exceedsMaxStop ? "; stop exceeds the maximum allowed" : ""}`); }
  const valNeg = validation.status === "sufficient" && (validation.expectancyR ?? 0) <= 0;
  add("validation_expectancy", !valNeg, "block", validation.status === "sufficient" ? `walk-forward expectancy ${validation.expectancyR}R over ${validation.n} samples` : "not enough walk-forward samples to judge");
  add("validation_sample", validation.status === "sufficient", "downgrade", validation.status === "sufficient" ? "sufficient sample" : validation.note);
  add("liquidity_spread", !of || of.spreadBps <= 25, "downgrade", of ? `spread ${of.spreadBps.toFixed(1)} bps` : "no order-book sample");
  add("derivatives_crowding", ctx.scoreAdjustment === 0, "downgrade", ctx.notes.join("; "));
  const blocked = filters.filter((f) => !f.pass && f.severity === "block");
  // Confidence: evidence quality, then caps from what has actually been validated. It is not a probability of profit.
  let evidence = 40 * fusion.agreement + 20 * (fusion.groupsTotal ? fusion.groupsAgree / fusion.groupsTotal : 0) + 20 * (alignment ?? 0.5) + 20 * (1 - Math.min(1, 2 * (1 - fusion.agreement)));
  const oiAdj = dir === 0 ? 0 : oi.supportsDirection === dir ? 3 : (dir === 1 && oi.regime === "short_covering") || (dir === -1 && oi.regime === "long_liquidation") ? -3 : 0;
  evidence += ctx.scoreAdjustment + oiAdj;
  const cap = validation.status !== "sufficient" ? 60 : (validation.ci95?.low ?? 0) > validation.breakevenWinRate ? 90 : 72;
  const confidence = dir === 0 ? 0 : Math.round(clamp(evidence, 0, cap));
  const action: "BUY" | "SELL" | "WAIT" = dir !== 0 && blocked.length === 0 ? (dir === 1 ? "BUY" : "SELL") : "WAIT";
  if (plan) {
    plan.actionable = action !== "WAIT";
    plan.suggestedRiskPct = Number(clamp(0.5 * regime.profile.exposureScale * (confidence / 70), 0, 1).toFixed(2));
    plan.sizingNote = "Suggested fraction of equity to risk on the stop distance. ETI's risk engine and its approvals decide whether any order is allowed; this endpoint never places one.";
  }
  const status = action !== "WAIT" ? "SIGNAL" : fusion.conflicted ? "CONFLICTED" : dir !== 0 ? "REJECTED" : "NEUTRAL";
  const sorted = [...votes].sort((a, b) => Math.abs(b.weight * b.strength) - Math.abs(a.weight * a.strength));
  const headline = action !== "WAIT" ? `${action}: ${fusion.votesAgree} of ${fusion.votesTotal} signals agree across ${fusion.groupsAgree} of ${fusion.groupsTotal} evidence groups in a ${regime.regime.replace(/_/g, " ")} regime.`
    : status === "REJECTED" ? `Candidate ${dir === 1 ? "BUY" : "SELL"} rejected: ${blocked.map((b) => b.id.replace(/_/g, " ")).join(", ")}.` : status === "CONFLICTED" ? "Indicators disagree materially; no trade." : "Evidence is not strong enough in either direction.";
  const fib = swingFib(rows), W = 300, from = Math.max(0, n - W), step = tfMs, lastT = rows[i][0];
  const slice = (a: number[]) => a.slice(from).map((x, k) => [rows[from + k][0], r6(x)] as [number, number | null]);
  return {
    ...base, status, action, direction: dir, score: fusion.score, confidence, confidenceType: "evidence_quality_capped_by_walk_forward_validation_not_a_probability_of_profit" as const, headline,
    regime: { named: regime.regime, mode, adx: r6(regime.adx), confidence: regime.confidence, preferred: regime.profile.preferred, exposureScale: regime.profile.exposureScale, reasons: regime.reasons },
    fusion: { agreement: Number(fusion.agreement.toFixed(3)), conflicted: fusion.conflicted, groups: fusion.groups, groupsAgree: fusion.groupsAgree, groupsTotal: fusion.groupsTotal, votesAgree: fusion.votesAgree, votesTotal: fusion.votesTotal, threshold: SIGNAL_THRESHOLD },
    votes: sorted.map((v) => ({ ...v, contribution: Number((v.weight * v.direction * v.strength).toFixed(3)) })), filters, blockedBy: blocked.map((b) => b.id),
    mtf: { alignment: alignment === null ? null : Number(alignment.toFixed(3)), higherTimeframeScore: htfScore === null ? null : Number(htfScore.toFixed(1)), timeframes: tfs },
    plan, validation, price, atr: r6(atr),
    indicators: { rsi: r6(s.rsi[i]), macdHist: r6(s.macd.hist[i]), adx: r6(s.adx.adx[i]), cci: r6(s.cci[i]), mfi: r6(s.mfi[i]), obv: r6(s.obv[i]), vwap: r6(s.vwap.vwap[i]), supertrend: r6(s.st.line[i]), supertrendDir: s.st.dir[i],
      tenkan: r6(s.ich.tenkan[i]), kijun: r6(s.ich.kijun[i]), cloudA: r6(s.ich.cloudA[i]), cloudB: r6(s.ich.cloudB[i]), bbUpper: r6(s.bb.upper[i]), bbLower: r6(s.bb.lower[i]), bbPctB: r6(s.bb.pctB[i]), ema20: r6(s.ema20[i]), ema50: r6(s.ema50[i]), ema200: i >= 199 ? r6(s.ema200[i]) : null },
    smc: { status: smc.status, trend: smc.trend, notes: smcNotes, note: "BOS, CHoCH, FVG, order blocks and sweeps are drawn by the existing SMC layer from /api/analysis/smc; they feed this fusion as the structure group." },
    orderflow: of ? { ...of, source: "exchange_recent_trades_and_top_of_book", note: "Short recent-trade sample and resting orders: indicative, not a full event stream." } : { available: false },
    derivatives: { context: ctx, openInterest: oi, funding, liquidationZones: liquidation, liquidationNote: inp.market === "futures" ? "ESTIMATED from swing entries at 10-100x leverage that price has not traded through; Bybit publishes no liquidation history over REST, so this is a model, not observed liquidations." : "Spot market: no open interest, funding or liquidations." },
    chart: {
      window: n - from, ichimoku: { tenkan: slice(s.ich.tenkan), kijun: slice(s.ich.kijun), cloud: rows.slice(from).map((r, k) => ({ t: r[0], a: r6(s.ich.cloudA[from + k]), b: r6(s.ich.cloudB[from + k]) })),
        future: s.ich.futureA.map((a, k) => ({ t: lastT + (k + 1) * step, a: r6(a), b: r6(s.ich.futureB[k]) })) },
      supertrend: rows.slice(from).map((r, k) => ({ t: r[0], v: r6(s.st.line[from + k]), dir: s.st.dir[from + k] })), vwap: slice(s.vwap.vwap),
      bollinger: { upper: slice(s.bb.upper), mid: slice(s.bb.mid), lower: slice(s.bb.lower) }, fibonacci: fib ? { ...fib, levels: fib.levels.map((l) => ({ ratio: l.ratio, price: r6(l.price) })), extensions: fib.extensions.map((l) => ({ ratio: l.ratio, price: r6(l.price) })) } : null,
      markers: signalMarkers(rows, s).filter((m) => m.t >= rows[from][0]).map((m) => ({ ...m, price: r6(m.price), score: Number(m.score.toFixed(1)) })),
    },
    explanation: [headline, ...sorted.slice(0, 8).map((v) => `${v.direction > 0 ? "▲" : v.direction < 0 ? "▼" : "•"} ${v.label}: ${v.detail}`), ...filters.filter((f) => !f.pass).map((f) => `⚠ ${f.id.replace(/_/g, " ")}: ${f.detail}`)],
  };
}
export type SignalIntel = ReturnType<typeof buildSignalIntel>;

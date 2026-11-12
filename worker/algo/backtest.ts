// ETI parametric strategy SCREEN: causal, cost-aware backtesting, 144-combination optimisation,
// chronological train/test split, walk-forward validation, parameter stability and cross-market checks.
//
// Scope: this lab uses a SIMPLIFIED rule set (EMA + adaptive bands + volume flow + optional ADX gate) to find parameter
// regions that are not fragile. It is NOT the live Swift/Gainz/fusion chain, so it can never validate that chain.
// Authoritative end-to-end validation is worker/algo/replay.ts (real engines -> fusion -> validator -> paper engine) and
// live paper outcomes. Trade management here is the SAME manageStop() the paper engine runs, and metrics are the SAME
// computeReport() the paper/replay layers use, so numbers are comparable across layers.
// Results are HISTORICAL SIMULATIONS. They are never a forecast and never a guaranteed win rate.
import type { Kline } from "../market.ts";
import { adaptiveBandsSeries, adxSeries, atrSeries, ema, volFlowSeries } from "./indicators.ts";
import { PARTIALS, walkPosition } from "./trade-walk.ts";
import { MIN_SAMPLE, computeReport, type ClosedTrade, type PerformanceReport } from "./performance.ts";

export interface BtParams { fast: number; slow: number; atrMult: number; minFlow: number; regimeFilter: boolean }
export interface Costs { feeBps: number; slippageBps: number }           // charged per side
export const DEFAULT_COSTS: Costs = { feeBps: 10, slippageBps: 5 };
export const R_MULTIPLES = [1.2, 2.2, 3.5] as const;
export { PARTIALS };
export const WARMUP = 60, MAX_HOLD = 100, COOLDOWN = 3, MIN_TRADES = 20, RISK_FRACTION = 0.01;

export const GRID = { fast: [8, 12, 16], slow: [26, 50], atrMult: [1.2, 1.5, 2, 2.5], minFlow: [5, 15, 30], regimeFilter: [false, true] } as const;
export function buildGrid(g: { fast: readonly number[]; slow: readonly number[]; atrMult: readonly number[]; minFlow: readonly number[]; regimeFilter: readonly boolean[] } = GRID): BtParams[] {
  const out: BtParams[] = [];
  for (const fast of g.fast) for (const slow of g.slow) for (const atrMult of g.atrMult) for (const minFlow of g.minFlow) for (const regimeFilter of g.regimeFilter) if (fast < slow) out.push({ fast, slow, atrMult, minFlow, regimeFilter });
  return out;
}
export const paramKey = (p: BtParams) => `${p.fast}/${p.slow}/${p.atrMult}/${p.minFlow}/${p.regimeFilter ? "R" : "-"}`;

export interface Prepared { rows: Kline[]; atr: number[]; adx: number[]; plusDI: number[]; minusDI: number[]; flow: number[]; bands: ReturnType<typeof adaptiveBandsSeries>; ema: Map<number, number[]> }
export function prepare(rows: Kline[]): Prepared {
  const a = adxSeries(rows);
  return { rows, atr: atrSeries(rows), adx: a.adx, plusDI: a.plusDI, minusDI: a.minusDI, flow: volFlowSeries(rows), bands: adaptiveBandsSeries(rows), ema: new Map() };
}
const emaOf = (p: Prepared, n: number) => { let e = p.ema.get(n); if (!e) { e = ema(p.rows.map(r => r[4]), n); p.ema.set(n, e); } return e; };

export interface Trade { entryIdx: number; exitIdx: number; dir: 1 | -1; entry: number; stop0: number; exit: number; grossR: number; costR: number; r: number; targetsHit: number; reason: "stop" | "breakeven" | "trail" | "tp3" | "time" | "end" }

/** Simulate over bars [from, to). Signals use data up to bar t; entry is the OPEN of bar t+1 (no look-ahead). */
export function simulate(p: Prepared, prm: BtParams, from: number, to: number, costs: Costs = DEFAULT_COSTS): Trade[] {
  const rows = p.rows, ef = emaOf(p, prm.fast), es = emaOf(p, prm.slow), trades: Trade[] = [];
  const rt = 2 * (costs.feeBps + costs.slippageBps) / 1e4;
  let t = Math.max(from, WARMUP);
  while (t < to - 2) {
    const atr = p.atr[t], adx = p.adx[t], fl = p.flow[t], bt = p.bands.trend[t];
    if (!(atr > 0) || !Number.isFinite(adx) || !Number.isFinite(fl) || !bt) { t++; continue; }
    const sep = ef[t] - es[t], dir: 1 | -1 = sep > 0 ? 1 : -1;
    const bandsAgree = (bt === "bull" ? 1 : -1) === dir, flowOk = fl * dir >= prm.minFlow, emaOk = Math.abs(sep) > 0.1 * atr;
    let regimeOk = true;
    if (prm.regimeFilter) regimeOk = adx >= 20 && (rows[t][2] - rows[t][3]) <= 6 * atr && (dir > 0 ? p.plusDI[t] > p.minusDI[t] : p.minusDI[t] > p.plusDI[t]);
    if (!(bandsAgree && flowOk && emaOk && regimeOk)) { t++; continue; }
    const entry = rows[t + 1][1], dist = Math.max(atr * prm.atrMult, entry * 0.001);
    const feeBuffer = entry * costs.feeBps * 2 / 1e4, last = Math.min(to - 1, t + 1 + MAX_HOLD);
    // The single shared trade walk (stop-first, break-even covering fees after TP1, trailing after TP2): identical to PaperEngine.
    const w = walkPosition(rows, t + 1, last, dir, entry, entry - dir * dist, [entry + dir * dist * R_MULTIPLES[0], entry + dir * dist * R_MULTIPLES[1], entry + dir * dist * R_MULTIPLES[2]], feeBuffer, to - 1);
    if (!w) { t++; continue; }
    const { exitIdx, realizedR: realized, targetsHit: hit, reason } = w;
    const costR = entry * rt / dist;
    trades.push({ entryIdx: t + 1, exitIdx, dir, entry, stop0: entry - dir * dist, exit: w.exit, grossR: realized, costR, r: realized - costR, targetsHit: hit, reason });
    t = exitIdx + COOLDOWN;
  }
  return trades;
}

export interface Metrics {
  trades: number; winRate: number | null; profitFactor: number | null; expectancyR: number | null; netR: number; avgWinR: number | null; avgLossR: number | null; avgRewardRisk: number | null;
  netReturnPct: number; maxDrawdownPct: number; maxConsecutiveLosses: number; sharpe: number | null; sortino: number | null; tradesPer100Bars: number; exposurePct: number; costsIncluded: true; label: "backtested";
  /** The same performance report the paper and replay layers produce (Wilson interval, withheld below MIN_SAMPLE trades). Prefer this for display. */
  report: PerformanceReport;
}
/** Express screen trades as ClosedTrade rows (1% risk on 10,000 = 100 per R) so the shared performance code can score them. */
export function toClosedTrades(trades: Trade[], costs: Costs = DEFAULT_COSTS): ClosedTrade[] {
  const tot = costs.feeBps + costs.slippageBps, feeShare = tot > 0 ? costs.feeBps / tot : 1;
  return trades.map((t, i) => ({ id: `screen-${i}`, engine: "swift" as const, symbol: "screen", openedAt: t.entryIdx, closedAt: t.exitIdx, pnl: t.r * 100, riskAmount: 100, fees: t.costR * 100 * feeShare, slippage: t.costR * 100 * (1 - feeShare) }));
}
export function metrics(trades: Trade[], bars: number, years: number, riskFraction = RISK_FRACTION, costs: Costs = DEFAULT_COSTS): Metrics {
  const n = trades.length, rs = trades.map(t => t.r), wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  let eq = 1, peak = 1, mdd = 0, streak = 0, maxStreak = 0;
  for (const r of rs) { eq *= 1 + riskFraction * r; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); if (r <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  const mean = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const rets = rs.map(r => r * riskFraction), mr = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mr) ** 2, 0) / (n - 1)) : 0;
  const dd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / n) : 0;
  const ann = years > 0 && n ? Math.sqrt(n / years) : NaN;
  const inTrade = trades.reduce((a, t) => a + (t.exitIdx - t.entryIdx + 1), 0);
  return { trades: n, winRate: n ? wins.length / n : null, profitFactor: n && gl > 0 ? gp / gl : null, expectancyR: n ? mean : null, netR: rs.reduce((a, b) => a + b, 0),
    avgWinR: wins.length ? gp / wins.length : null, avgLossR: losses.length ? -gl / losses.length : null, avgRewardRisk: wins.length && losses.length && gl > 0 ? (gp / wins.length) / (gl / losses.length) : null,
    netReturnPct: (eq - 1) * 100, maxDrawdownPct: mdd * 100, maxConsecutiveLosses: maxStreak, sharpe: sd > 0 && Number.isFinite(ann) ? mr / sd * ann : null, sortino: dd > 0 && Number.isFinite(ann) ? mr / dd * ann : null,
    tradesPer100Bars: bars > 0 ? n / bars * 100 : 0, exposurePct: bars > 0 ? inTrade / bars * 100 : 0, costsIncluded: true, label: "backtested", report: computeReport(toClosedTrades(trades, costs)) };
}
const yearsBetween = (rows: Kline[], a: number, b: number) => Math.max(0, (rows[Math.min(b, rows.length) - 1][0] - rows[a][0]) / (365.25 * 86400e3));
function evaluate(p: Prepared, prm: BtParams, from: number, to: number, costs: Costs) {
  const trades = simulate(p, prm, from, to, costs);
  return { trades, metrics: metrics(trades, to - from, yearsBetween(p.rows, from, to), RISK_FRACTION, costs) };
}
/** Robust selection objective: rewards expectancy and sample size, penalises drawdown; undersized samples are disqualified. */
export function objective(m: Metrics): number {
  if (m.trades < MIN_TRADES || m.expectancyR === null) return -Infinity;
  return m.expectancyR * Math.sqrt(m.trades) - 0.05 * m.maxDrawdownPct;
}

export interface ComboResult { params: BtParams; key: string; train: Metrics; test: Metrics; objective: number }
export interface FoldResult { fold: number; trainRange: [number, number]; testRange: [number, number]; chosen: BtParams | null; test: Metrics | null }
export interface OptimizationReport {
  status: "ok" | "insufficient_data"; label: "backtested"; combinationsEvaluated: number; bars: number; split: { trainEnd: number; chronological: true };
  costs: Costs; ranking: ComboResult[]; selected: ComboResult | null; walkForward: { folds: FoldResult[]; aggregate: Metrics | null; paramConsistency: number | null };
  stability: { neighbours: number; neighbourPositiveShare: number | null; neighbourMeanExpectancyR: number | null };
  crossMarket: { symbol: string; metrics: Metrics }[]; robust: boolean; reasons: string[]; disclaimer: string;
}
const DISCLAIMER = "Historical simulation including fees and slippage. Not a forecast; a backtested win rate is not a guaranteed or verified live win rate. Paper and live performance must be measured separately.";

function neighbours(all: ComboResult[], sel: BtParams): ComboResult[] {
  const keys: (keyof BtParams)[] = ["fast", "slow", "atrMult", "minFlow", "regimeFilter"];
  return all.filter(c => keys.filter(k => c.params[k] !== sel[k]).length === 1);
}
export interface OptimizeOptions { primary?: string; costs?: Costs; grid?: BtParams[]; trainFraction?: number; minBars?: number }

export function optimize(markets: Record<string, Kline[]>, o: OptimizeOptions = {}): OptimizationReport {
  const symbols = Object.keys(markets), primary = o.primary ?? symbols[0], rows = markets[primary] ?? [];
  const costs = o.costs ?? DEFAULT_COSTS, grid = o.grid ?? buildGrid(), minBars = o.minBars ?? 400;
  const empty = (reasons: string[]): OptimizationReport => ({ status: "insufficient_data", label: "backtested", combinationsEvaluated: 0, bars: rows.length, split: { trainEnd: 0, chronological: true }, costs, ranking: [], selected: null,
    walkForward: { folds: [], aggregate: null, paramConsistency: null }, stability: { neighbours: 0, neighbourPositiveShare: null, neighbourMeanExpectancyR: null }, crossMarket: [], robust: false, reasons, disclaimer: DISCLAIMER });
  if (rows.length < minBars) return empty([`Need at least ${minBars} candles for a train/test split; received ${rows.length}`]);
  const prep = prepare(rows), n = rows.length, trainEnd = Math.floor(n * (o.trainFraction ?? 0.6));
  // 1) Chronological split: parameters are chosen on TRAIN only; TEST is strictly later and never used for selection.
  const all: ComboResult[] = grid.map(params => { const train = evaluate(prep, params, 0, trainEnd, costs).metrics, test = evaluate(prep, params, trainEnd, n, costs).metrics; return { params, key: paramKey(params), train, test, objective: objective(train) }; });
  const ranking = [...all].sort((a, b) => b.objective - a.objective);
  const selected = ranking[0] && ranking[0].objective > -Infinity ? ranking[0] : null;
  // 2) Walk-forward: re-select on each rolling train window, trade only the following unseen window, stitch the out-of-sample trades.
  const trainLen = Math.floor(n * 0.4), testLen = Math.floor(n * 0.15), folds: FoldResult[] = [], oosTrades: Trade[] = [];
  let k = 0, oosBars = 0;
  for (let s = 0; s + trainLen + testLen <= n; s += testLen, k++) {
    const tr: [number, number] = [s, s + trainLen], te: [number, number] = [s + trainLen, s + trainLen + testLen];
    let best: BtParams | null = null, bo = -Infinity;
    for (const g of grid) { const ob = objective(evaluate(prep, g, tr[0], tr[1], costs).metrics); if (ob > bo) { bo = ob; best = g; } }
    if (!best) { folds.push({ fold: k, trainRange: tr, testRange: te, chosen: null, test: null }); continue; }
    const ev = evaluate(prep, best, te[0], te[1], costs); oosTrades.push(...ev.trades); oosBars += te[1] - te[0];
    folds.push({ fold: k, trainRange: tr, testRange: te, chosen: best, test: ev.metrics });
  }
  const chosen = folds.filter(f => f.chosen).map(f => paramKey(f.chosen!)), top = chosen.length ? Math.max(...[...new Set(chosen)].map(x => chosen.filter(y => y === x).length)) : 0;
  const wfAgg = folds.some(f => f.chosen) ? metrics(oosTrades, oosBars, yearsBetween(rows, Math.floor(n * 0.4), n), RISK_FRACTION, costs) : null;
  // 3) Parameter stability: do neighbouring parameter sets also work on TRAIN?
  const nb = selected ? neighbours(all, selected.params) : [];
  const nbExp = nb.map(c => c.train.expectancyR).filter((x): x is number => x !== null);
  const stability = { neighbours: nb.length, neighbourPositiveShare: nbExp.length ? nbExp.filter(x => x > 0).length / nbExp.length : null, neighbourMeanExpectancyR: nbExp.length ? nbExp.reduce((a, b) => a + b, 0) / nbExp.length : null };
  // 4) Cross-market: the selected parameters, unchanged, on other markets.
  const crossMarket = selected ? symbols.filter(s => s !== primary && markets[s].length >= minBars).map(s => { const pp = prepare(markets[s]); return { symbol: s, metrics: evaluate(pp, selected.params, 0, markets[s].length, costs).metrics }; }) : [];
  // 5) Verdict. Every criterion must pass; reasons list what failed.
  const reasons: string[] = [];
  if (!selected) reasons.push(`No parameter set produced at least ${MIN_TRADES} training trades with a measurable expectancy`);
  else {
    if ((selected.train.expectancyR ?? 0) <= 0) reasons.push("Selected parameters have non-positive training expectancy");
    if (selected.test.trades < 10) reasons.push(`Out-of-sample sample too small (${selected.test.trades} trades, need 10)`);
    else if ((selected.test.expectancyR ?? 0) <= 0) reasons.push("Out-of-sample expectancy is not positive");
    if (!wfAgg || wfAgg.trades < MIN_SAMPLE) reasons.push(`Walk-forward sample too small (${wfAgg?.trades ?? 0} trades, need ${MIN_SAMPLE}, the same minimum the performance layer uses)`);
    else if ((wfAgg.expectancyR ?? 0) <= 0) reasons.push("Walk-forward expectancy is not positive");
    if (stability.neighbourPositiveShare !== null && stability.neighbourPositiveShare < 0.5) reasons.push("Parameter set is unstable: fewer than half of its neighbours are profitable in training");
    if (crossMarket.length && crossMarket.filter(c => (c.metrics.expectancyR ?? 0) > 0).length < crossMarket.length / 2) reasons.push("Selected parameters do not generalise: fewer than half of other markets are profitable");
  }
  return { status: "ok", label: "backtested", combinationsEvaluated: grid.length, bars: n, split: { trainEnd, chronological: true }, costs, ranking: ranking.slice(0, 10), selected,
    walkForward: { folds, aggregate: wfAgg, paramConsistency: chosen.length ? top / chosen.length : null }, stability, crossMarket, robust: reasons.length === 0, reasons, disclaimer: DISCLAIMER };
}

/**
 * Expectancy of the PARAMETRIC SCREEN. Only a robust report yields a number. This describes the simplified screen rules, so it must
 * not be passed to the live validator as the engines' expectancy; that has to come from replay.ts or paper outcomes.
 */
export function expectancyFromReport(r: OptimizationReport): { expectancyR: number; samples: number } | null {
  if (!r.robust || !r.selected || !r.walkForward.aggregate) return null;
  const oos = r.selected.test, wf = r.walkForward.aggregate;
  return { expectancyR: Math.min(oos.expectancyR ?? 0, wf.expectancyR ?? 0), samples: wf.trades };
}

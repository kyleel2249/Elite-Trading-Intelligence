/**
 * Elite Strategy Competition Laboratory + Strategy Compatibility Engine.
 *
 * Every strategy is evaluated separately under the SAME risk envelope (1.5 ATR stop, 2R target, 24-bar time stop,
 * entry at the next bar open, transaction costs charged), long-only because ETI executes spot instruments.
 * Parameters are fixed a priori (no optimisation), so the walk-forward folds measure stability over consecutive
 * out-of-sample windows. Promotion requires out-of-sample significance corrected for the number of strategies compared.
 * Strategies that need data candles do not carry (fundamentals, macro) are listed as not_testable, never simulated.
 */
import { INTERVAL_SECONDS, type Kline } from "../market.ts";
import { MIN_CANDLES, indicators } from "../signals.ts";
import { MODULE_META, runModules, type ModuleResult } from "../strategies.ts";
import type { AssetClass } from "./types.ts";
import { adxSeries, atrAt, emaSeries, mean, normInv, prng, round, sum, stdev, smaAt } from "./indicators.ts";

export type Horizon = "scalp" | "intraday" | "swing" | "position";
export type Regime = "trend" | "range" | "transition";
export type LabStatus = "promoted" | "candidate" | "insufficient_sample" | "rejected" | "not_testable";

export interface LabStrategy {
  id: string; name: string; traders: string; principle: string; kind: "engine_module" | "lab_rule" | "control";
  assetClasses: AssetClass[]; horizons: Horizon[]; preferredRegimes: Regime[]; testable: boolean; requires?: string; note: string;
}
export const ENVELOPE = { atrMult: 1.5, rewardRisk: 2, horizonBars: 24, direction: "long_only", entry: "next bar open", costBpsPerSide: { crypto: 10, equity: 5 } } as const;

const ALL_H: Horizon[] = ["scalp", "intraday", "swing", "position"], SW: Horizon[] = ["intraday", "swing", "position"];
const PREFS: Record<string, { assetClasses: AssetClass[]; horizons: Horizon[]; regimes: Regime[]; note: string }> = {
  turtle_trend: { assetClasses: ["crypto", "equity"], horizons: SW, regimes: ["trend", "transition"], note: "20-bar channel breakout; the original Turtle systems used 20/55-day channels on daily futures" },
  seykota_mechanical: { assetClasses: ["crypto", "equity"], horizons: ["swing", "position"], regimes: ["trend"], note: "EMA alignment trend follower; Seykota's own parameters are not public" },
  minervini_vcp: { assetClasses: ["equity", "crypto"], horizons: ["swing", "position"], regimes: ["trend"], note: "candle-adapted trend template; omits the earnings and relative-strength-rank criteria" },
  darvas_box: { assetClasses: ["equity", "crypto"], horizons: ["intraday", "swing"], regimes: ["trend", "transition"], note: "10-bar box breakout with volume; the original used daily boxes" },
  wyckoff_supply_demand: { assetClasses: ["crypto", "equity"], horizons: SW, regimes: ["range", "transition"], note: "spring/upthrust reversals; counter-trend, so the engine suppresses it in trends" },
  ptj_structure_preservation: { assetClasses: ["crypto", "equity"], horizons: ["swing", "position"], regimes: ["trend", "transition"], note: "200-bar average structure filter (a documented PTJ risk idea), not his full process" },
};
const LAB_RULES: LabStrategy[] = [
  { id: "turtle_system2", name: "Donchian 55-bar breakout", traders: "Richard Dennis / William Eckhardt (Turtle System 2)", principle: "Enter long on a close above the prior 55-bar high", kind: "lab_rule", assetClasses: ["crypto", "equity"], horizons: ["swing", "position"], preferredRegimes: ["trend"], testable: true, note: "Published Turtle System 2 entry; ETI's common exit envelope replaces the 20-bar channel exit" },
  { id: "raschke_holy_grail", name: "ADX pullback to the 20 EMA", traders: "Linda Bradford Raschke ('Holy Grail' setup)", principle: "In a strong trend (ADX>30), buy the pullback to the 20 EMA when price resumes", kind: "lab_rule", assetClasses: ["crypto", "equity"], horizons: SW, preferredRegimes: ["trend"], testable: true, note: "Setup as published in Street Smarts; ETI's exit envelope replaces her trailing exit" },
  { id: "williams_r_trend", name: "Williams %R recovery in an uptrend", traders: "Larry Williams (%R indicator)", principle: "Buy when %R(14) recovers up through -80 while the 50 EMA is rising", kind: "lab_rule", assetClasses: ["crypto", "equity"], horizons: ["intraday", "swing"], preferredRegimes: ["trend", "transition"], testable: true, note: "Uses the indicator Williams popularised; the filter and thresholds are ETI's, not his published system" },
  { id: "stat_zscore_reversion", name: "Statistical mean reversion (generic baseline)", traders: "Not attributed (generic statistical baseline)", principle: "Buy a 2-sigma dip below the 20-bar mean in a low-ADX market", kind: "lab_rule", assetClasses: ["crypto", "equity"], horizons: ["scalp", "intraday", "swing"], preferredRegimes: ["range"], testable: true, note: "Generic z-score rule; deliberately not attributed to any investor" },
  { id: "control_random", name: "Control: seeded random entries", traders: "Control", principle: "Enter long on a seeded coin flip every 12 bars under the same envelope", kind: "control", assetClasses: ["crypto", "equity"], horizons: ALL_H, preferredRegimes: ["trend", "range", "transition"], testable: true, note: "Calibrates what chance-level entries earn under the same costs and exits" },
];
export const LAB_STRATEGIES: LabStrategy[] = [
  ...MODULE_META.map((m): LabStrategy => {
    const p = PREFS[m.id];
    return { id: m.id, name: m.name, traders: m.trader, principle: m.principle, kind: "engine_module", assetClasses: p?.assetClasses ?? ["crypto", "equity"], horizons: p?.horizons ?? ["position"], preferredRegimes: p?.regimes ?? ["trend", "range", "transition"], testable: !m.requires && m.family !== "validation", requires: m.requires, note: p?.note ?? (m.requires ? "needs " + m.requires : "validation module, not an entry rule") };
  }),
  ...LAB_RULES,
];

export function horizonOf(interval: string): Horizon {
  const s = INTERVAL_SECONDS[interval] ?? 3600; return s <= 300 ? "scalp" : s <= 14400 ? "intraday" : s < 259200 ? "swing" : "position";
}

export interface Compatibility { strategyId: string; compatible: boolean; score: number; reasons: string[] }
/** Structural and regime compatibility. Structural mismatches (asset class, horizon, data) are hard; regime mismatch only lowers the score. */
export function compatibility(strategyId: string, ctx: { assetClass: AssetClass; interval: string; regime?: Regime }): Compatibility {
  const s = LAB_STRATEGIES.find(x => x.id === strategyId); if (!s) return { strategyId, compatible: false, score: 0, reasons: ["unknown strategy"] };
  const reasons: string[] = []; let compatible = true, score = 1;
  if (!s.testable) { compatible = false; score = 0; reasons.push(s.requires ? "requires " + s.requires + ", which candle data does not carry" : "not an entry rule") }
  if (!s.assetClasses.includes(ctx.assetClass)) { compatible = false; score = 0; reasons.push("documented for " + s.assetClasses.join("/") + ", not " + ctx.assetClass); }
  const h = horizonOf(ctx.interval);
  if (!s.horizons.includes(h)) { compatible = false; score = 0; reasons.push(h + " timeframe (" + ctx.interval + ") is outside this strategy's horizon (" + s.horizons.join(", ") + ")"); }
  if (ctx.regime && !s.preferredRegimes.includes(ctx.regime)) { score = Math.min(score, 0.3); reasons.push(ctx.regime + " regime is not a preferred regime (" + s.preferredRegimes.join(", ") + ")"); }
  if (compatible && !reasons.length) reasons.push("asset class, timeframe and regime are all within the documented fit");
  return { strategyId, compatible, score: round(score, 2), reasons };
}

// ------------------------------------------------------------------- simulation
export interface LabTrade { entryIndex: number; time: number; exitTime: number; entry: number; stop: number; target: number; r: number; outcome: "win" | "loss" | "time"; regime: Regime }
export interface Metrics { n: number; wins: number; winRate: number | null; avgR: number | null; profitFactor: number | null; maxDrawdownR: number; t: number | null }

export function metricsOf(trades: { r: number }[]): Metrics {
  const n = trades.length; if (!n) return { n: 0, wins: 0, winRate: null, avgR: null, profitFactor: null, maxDrawdownR: 0, t: null };
  const rs = trades.map(t => t.r), pos = sum(rs.filter(r => r > 0)), neg = -sum(rs.filter(r => r < 0));
  let eq = 0, peak = 0, dd = 0; for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const sd = stdev(rs), avg = mean(rs);
  return { n, wins: rs.filter(r => r > 0).length, winRate: round(100 * rs.filter(r => r > 0).length / n, 1), avgR: round(avg, 3), profitFactor: neg > 0 ? round(pos / neg, 2) : pos > 0 ? null : 0, maxDrawdownR: round(dd, 2), t: n >= 3 && sd > 0 ? round(avg / (sd / Math.sqrt(n)), 2) : null };
}

function simulate(rows: Kline[], entries: Set<number>, regimes: Regime[], cls: AssetClass, last: number): LabTrade[] {
  const out: LabTrade[] = []; let free = -1; const cost = ENVELOPE.costBpsPerSide[cls] / 1e4;
  for (const b of [...entries].sort((a, c) => a - c)) {
    if (b <= free || b + 1 >= rows.length) continue;
    const entry = rows[b + 1][1], atr = atrAt(rows, 14, b + 1); if (!(entry > 0) || !(atr > 0)) continue;
    const dist = Math.max(atr * ENVELOPE.atrMult, entry * 0.002), stop = entry - dist, target = entry + ENVELOPE.rewardRisk * dist;
    const end = b + ENVELOPE.horizonBars; if (end > last) continue; // unresolved at the data edge: excluded, not guessed
    let r: number | null = null, outcome: LabTrade["outcome"] = "time", exitIdx = end;
    for (let j = b + 1; j <= end; j++) {
      const bar = rows[j];
      if (bar[1] <= stop || bar[3] <= stop) { r = (Math.min(bar[1], stop) - entry) / dist; outcome = "loss"; exitIdx = j; break; }
      if (bar[2] >= target) { r = ENVELOPE.rewardRisk; outcome = "win"; exitIdx = j; break; }
    }
    if (r === null) r = (rows[end][4] - entry) / dist;
    r -= 2 * cost * entry / dist;
    out.push({ entryIndex: b, time: rows[b + 1][0], exitTime: rows[exitIdx][0], entry, stop, target, r: round(r, 3), outcome, regime: regimes[b] }); free = exitIdx;
  }
  return out;
}

interface Series { votes: Record<string, (-1 | 0 | 1)[]>; regimes: Regime[]; first: number }
function precompute(rows: Kline[]): Series {
  const n = rows.length, votes: Record<string, (-1 | 0 | 1)[]> = {}, regimes: Regime[] = new Array(n).fill("transition"), closes = rows.map(r => r[4]);
  const ids = LAB_STRATEGIES.filter(s => s.testable).map(s => s.id); for (const id of ids) votes[id] = new Array(n).fill(0);
  for (let b = MIN_CANDLES - 1; b < n; b++) {
    const slice = rows.slice(0, b + 1), ind = indicators(slice); if (!ind) continue;
    const { regime, results } = runModules(slice, ind); regimes[b] = regime.state;
    results.forEach((r: ModuleResult) => { if (votes[r.moduleId]) votes[r.moduleId][b] = r.status === "active" ? r.vote : 0; });
  }
  const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50), { adx, plusDI, minusDI } = adxSeries(rows), rnd = prng(20240607);
  for (let b = 60; b < n; b++) {
    const c = closes[b];
    if (c > Math.max(...rows.slice(b - 55, b).map(r => r[2]))) votes.turtle_system2[b] = 1;
    const touched = rows.slice(b - 3, b + 1).some((r, i) => r[3] <= e20[b - 3 + i]);
    if (adx[b] > 30 && plusDI[b] > minusDI[b] && touched && c > e20[b] && c > rows[b - 1][2]) votes.raschke_holy_grail[b] = 1;
    const wr = (i: number) => { const w = rows.slice(i - 13, i + 1), hh = Math.max(...w.map(r => r[2])), ll = Math.min(...w.map(r => r[3])); return hh > ll ? -100 * (hh - closes[i]) / (hh - ll) : -50; };
    if (wr(b - 1) < -80 && wr(b) >= -80 && c > e50[b] && e50[b] > e50[b - 5]) votes.williams_r_trend[b] = 1;
    const m = smaAt(closes, 20, b + 1), sd = stdev(closes.slice(b - 19, b + 1));
    if (sd > 0 && (c - m) / sd <= -2 && adx[b] < 25) votes.stat_zscore_reversion[b] = 1;
    if (b % 12 === 0 && rnd() < 0.5) votes.control_random[b] = 1;
  }
  return { votes, regimes, first: MIN_CANDLES - 1 };
}

const flips = (v: (-1 | 0 | 1)[], from: number) => { const s = new Set<number>(); for (let b = from; b < v.length; b++) if (v[b] === 1 && v[b - 1] !== 1) s.add(b); return s; };

export interface StrategyResult {
  id: string; name: string; traders: string; kind: LabStrategy["kind"] | "combination"; status: LabStatus; statusReason: string;
  overall: Metrics; inSample: Metrics; outOfSample: Metrics; folds: Metrics[]; positiveFolds: number; byRegime: Record<string, Metrics>;
  criticalT: number; compat: Compatibility; members?: string[];
}
export interface LabResult {
  symbol: string; interval: string; assetClass: AssetClass; barsTested: number; testedFrom: number | null; testedTo: number | null; splitTime: number | null;
  envelope: typeof ENVELOPE; strategiesCompared: number; criticalT: number; results: StrategyResult[]; trades: Record<string, LabTrade[]>;
  caveats: string[]; latestVotes: Record<string, number>;
}

function judge(id: string, tr: LabTrade[], splitIdx: number, foldEdges: number[], crit: number, compat: Compatibility) {
  const isT = tr.filter(t => t.entryIndex < splitIdx), oos = tr.filter(t => t.entryIndex >= splitIdx);
  const folds = foldEdges.slice(0, -1).map((lo, i) => metricsOf(tr.filter(t => t.entryIndex >= lo && t.entryIndex < foldEdges[i + 1])));
  const posFolds = folds.filter(f => f.n >= 3 && (f.avgR ?? -1) > 0).length;
  const byRegime: Record<string, Metrics> = {}; for (const rg of ["trend", "range", "transition"]) byRegime[rg] = metricsOf(tr.filter(t => t.regime === rg));
  const o = metricsOf(oos), i = metricsOf(isT);
  let status: LabStatus, reason: string;
  if (o.n < 15) { status = "insufficient_sample"; reason = "only " + o.n + " out-of-sample trades (need 15 for candidate, 30 for promotion)"; }
  else if ((o.avgR ?? -1) <= 0 || (i.avgR ?? -1) <= 0) { status = "rejected"; reason = "expectancy not positive both in-sample (" + i.avgR + "R) and out-of-sample (" + o.avgR + "R)"; }
  else if (o.n >= 30 && (o.t ?? 0) >= crit && posFolds >= 3) { status = "promoted"; reason = "OOS t=" + o.t + " >= " + crit + " (multiple-testing corrected), " + posFolds + "/4 folds positive, n=" + o.n; }
  else { status = "candidate"; reason = "positive in- and out-of-sample but not significant after correction (OOS t=" + o.t + " vs " + crit + ", n=" + o.n + ", " + posFolds + "/4 folds positive)"; }
  void id; return { overall: metricsOf(tr), inSample: i, outOfSample: o, folds, positiveFolds: posFolds, byRegime, status, statusReason: reason };
}

export function runLab(rows: Kline[], ctx: { symbol: string; interval: string; assetClass: AssetClass }): LabResult | null {
  const n = rows.length; if (n < MIN_CANDLES + 60) return null;
  const S = precompute(rows), from = S.first + 1, last = n - 1, split = from + Math.floor((last - from) * 0.6);
  const edges = [0, 1, 2, 3, 4].map(k => from + Math.floor((last - from) * k / 4));
  const testable = LAB_STRATEGIES.filter(s => s.testable);
  const trades: Record<string, LabTrade[]> = {}; for (const s of testable) trades[s.id] = simulate(rows, flips(S.votes[s.id], from), S.regimes, ctx.assetClass, last);
  // combinations: chosen from in-sample performance only (no look-ahead into the out-of-sample window)
  const isRank = testable.filter(s => s.kind !== "control").map(s => ({ s, m: metricsOf(trades[s.id].filter(t => t.entryIndex < split)) })).filter(x => x.m.n >= 8 && (x.m.avgR ?? -1) > 0).sort((a, b) => (b.m.avgR ?? 0) - (a.m.avgR ?? 0)).slice(0, 4);
  const smooth = (v: (-1 | 0 | 1)[]) => v.map((_, b) => v.slice(Math.max(0, b - 4), b + 1).includes(1) ? 1 : 0) as (-1 | 0 | 1)[];
  const combos: { id: string; members: string[] }[] = [];
  for (let i = 0; i < isRank.length; i++) for (let j = i + 1; j < isRank.length; j++) {
    const a = isRank[i].s.id, b = isRank[j].s.id, sa = smooth(S.votes[a]), sb = smooth(S.votes[b]), fa = flips(S.votes[a], from), fb = flips(S.votes[b], from);
    const e = new Set<number>(); for (let k = from; k <= last; k++) if (sa[k] === 1 && sb[k] === 1 && (fa.has(k) || fb.has(k))) e.add(k);
    const id = "combo:" + a + "+" + b; trades[id] = simulate(rows, e, S.regimes, ctx.assetClass, last); combos.push({ id, members: [a, b] });
  }
  const m = testable.length + combos.length, crit = round(normInv(1 - 0.05 / m), 2);
  const regimeNow = S.regimes[last];
  const results: StrategyResult[] = [];
  for (const s of LAB_STRATEGIES) {
    const compat = compatibility(s.id, { ...ctx, regime: regimeNow });
    if (!s.testable) { const z: Metrics = metricsOf([]); results.push({ id: s.id, name: s.name, traders: s.traders, kind: s.kind, status: "not_testable", statusReason: s.requires ? "needs " + s.requires + "; not simulated" : "validation module, not an entry rule", overall: z, inSample: z, outOfSample: z, folds: [], positiveFolds: 0, byRegime: {}, criticalT: crit, compat }); continue; }
    const j = judge(s.id, trades[s.id], split, edges, crit, compat); results.push({ id: s.id, name: s.name, traders: s.traders, kind: s.kind, criticalT: crit, compat, ...j });
  }
  for (const c of combos) {
    const j = judge(c.id, trades[c.id], split, edges, crit, compatibility(c.members[0], { ...ctx, regime: regimeNow }));
    results.push({ id: c.id, name: "Combination: " + c.members.join(" AND "), traders: c.members.map(id => LAB_STRATEGIES.find(x => x.id === id)!.traders).join(" + "), kind: "combination", members: c.members, criticalT: crit, compat: { strategyId: c.id, compatible: c.members.every(id => compatibility(id, { ...ctx }).compatible), score: 0.5, reasons: ["both members must agree within 5 bars; selected on in-sample results only"] }, ...j });
  }
  const latestVotes: Record<string, number> = {}; for (const s of testable) latestVotes[s.id] = S.votes[s.id][last];
  return { symbol: ctx.symbol, interval: ctx.interval, assetClass: ctx.assetClass, barsTested: last - from + 1, testedFrom: rows[from][0], testedTo: rows[last][0], splitTime: rows[split][0], envelope: ENVELOPE, strategiesCompared: m, criticalT: crit, results, trades, latestVotes,
    caveats: ["Costs charged: " + ENVELOPE.costBpsPerSide[ctx.assetClass] + " bps per side; slippage, funding and market impact are not modelled", "Single symbol and timeframe: promotion here is evidence for this market only; pool several symbols before trusting a strategy", "Strategies were not optimised; the out-of-sample split is chronological (first 60% in-sample, last 40% out-of-sample)", "Signals at the same time across strategies are correlated; counts are not independent"] };
}

/** Pools trades of several single-market lab runs into one comparison (same significance correction). */
export function poolLabs(labs: LabResult[]): { markets: number; rows: { id: string; name: string; metrics: Metrics; oos: Metrics; status: LabStatus; criticalT: number }[] } {
  const ids = [...new Set(labs.flatMap(l => l.results.filter(r => r.status !== "not_testable" && r.kind !== "combination").map(r => r.id)))];
  const crit = round(normInv(1 - 0.05 / Math.max(1, ids.length)), 2);
  const rows = ids.map(id => {
    const all: LabTrade[] = [], oos: LabTrade[] = [];
    for (const l of labs) { const t = l.trades[id] ?? []; all.push(...t); if (l.splitTime !== null) oos.push(...t.filter(x => x.time >= l.splitTime!)); }
    const o = metricsOf(oos), a = metricsOf(all);
    const status: LabStatus = o.n < 30 ? "insufficient_sample" : (o.avgR ?? -1) <= 0 ? "rejected" : (o.t ?? 0) >= crit && (a.avgR ?? 0) > 0 ? "promoted" : "candidate";
    return { id, name: LAB_STRATEGIES.find(s => s.id === id)?.name ?? id, metrics: a, oos: o, status, criticalT: crit };
  });
  return { markets: labs.length, rows };
}

// ---- per-market summaries (small, replace-on-rerun) so pooled statistics never double-count a market
export interface Agg { n: number; wins: number; sumR: number; sumR2: number }
export interface LabSummary { symbol: string; interval: string; assetClass: AssetClass; at: number; strategies: Record<string, { all: Agg; oos: Agg }>; latestVotes: Record<string, number>; criticalT: number; results: { id: string; name: string; traders: string; kind: string; status: LabStatus; statusReason: string; oosN: number; oosAvgR: number | null; compat: Compatibility }[] }
const agg = (t: { r: number }[]): Agg => ({ n: t.length, wins: t.filter(x => x.r > 0).length, sumR: round(sum(t.map(x => x.r)), 4), sumR2: round(sum(t.map(x => x.r * x.r)), 4) });
export function summariseLab(lab: LabResult, at: number): LabSummary {
  const strategies: LabSummary["strategies"] = {};
  for (const [id, tr] of Object.entries(lab.trades)) { if (id.startsWith("combo:")) continue; strategies[id] = { all: agg(tr), oos: agg(tr.filter(t => lab.splitTime !== null && t.time >= lab.splitTime)) }; }
  return { symbol: lab.symbol, interval: lab.interval, assetClass: lab.assetClass, at, strategies, latestVotes: lab.latestVotes, criticalT: lab.criticalT, results: lab.results.map(r => ({ id: r.id, name: r.name, traders: r.traders, kind: r.kind, status: r.status, statusReason: r.statusReason, oosN: r.outOfSample.n, oosAvgR: r.outOfSample.avgR, compat: r.compat })) };
}
const tOf = (a: Agg) => { if (a.n < 3) return null; const m = a.sumR / a.n, v = (a.sumR2 - a.n * m * m) / (a.n - 1); return v > 0 ? round(m / Math.sqrt(v / a.n), 2) : null; };
export function poolSummaries(list: LabSummary[]): { markets: number; criticalT: number; rows: { id: string; name: string; traders: string; trades: number; avgR: number | null; oosTrades: number; oosAvgR: number | null; oosT: number | null; winRate: number | null; status: LabStatus }[] } {
  const ids = [...new Set(list.flatMap(l => Object.keys(l.strategies)))], crit = round(normInv(1 - 0.05 / Math.max(1, ids.length)), 2);
  const rows = ids.map(id => {
    const all: Agg = { n: 0, wins: 0, sumR: 0, sumR2: 0 }, oos: Agg = { n: 0, wins: 0, sumR: 0, sumR2: 0 };
    for (const l of list) { const s = l.strategies[id]; if (!s) continue; for (const k of ["n", "wins", "sumR", "sumR2"] as const) { all[k] += s.all[k]; oos[k] += s.oos[k]; } }
    const t = tOf(oos), avgOos = oos.n ? round(oos.sumR / oos.n, 3) : null;
    const status: LabStatus = oos.n < 30 ? "insufficient_sample" : (avgOos ?? -1) <= 0 ? "rejected" : (t ?? 0) >= crit ? "promoted" : "candidate";
    const meta = LAB_STRATEGIES.find(s => s.id === id);
    return { id, name: meta?.name ?? id, traders: meta?.traders ?? "", trades: all.n, avgR: all.n ? round(all.sumR / all.n, 3) : null, oosTrades: oos.n, oosAvgR: avgOos, oosT: t, winRate: all.n ? round(100 * all.wins / all.n, 1) : null, status };
  });
  return { markets: list.length, criticalT: crit, rows };
}

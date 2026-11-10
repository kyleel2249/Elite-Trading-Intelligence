// Confidence calibration from recorded outcomes. The engines emit a heuristic 0-100 evidence score. This module fits a monotone
// reliability map (score -> observed frequency of a net-positive trade) from CLOSED trades with provenance, and applies it only when
// (1) enough outcomes exist, and (2) the map beats the plain base rate on a chronologically later held-out slice (Brier score).
// Otherwise the score stays "uncalibrated". The result is an observed frequency with a Wilson interval, never a promise, and it is
// not an expectancy: a high win rate with poor payoff can still lose money, so mean R per bin is reported beside it.
import type { ClosedTrade } from "./performance.ts";
import { wilson } from "./performance.ts";

export const CALIBRATION_KEY = "algo:calibration:v1";
export const MIN_TOTAL = 100, MIN_BIN = 20, MIN_HOLDOUT = 25, EDGES = [0, 50, 55, 60, 65, 70, 75, 80, 85, 101];
type KV = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
export interface CalBin { lo: number; hi: number; n: number; wins: number; rate: number; low95: number; high95: number; meanR: number | null; calibratedRate: number }
export interface CalibrationTable {
  version: 1; fittedAt: string; sources: string[]; samples: number; trainSamples: number; holdoutSamples: number;
  status: "calibrated" | "insufficient_data" | "no_skill"; baseRate: number | null;
  brier: { model: number; baseline: number } | null; bins: CalBin[]; note: string; definition: string;
}
export interface Outcome { confidence: number; win: boolean; r: number | null; closedAt: number; source: string }
export const DEFINITION = "Observed fraction of closed trades with net profit above zero after fees and slippage, for trades that showed a similar evidence score.";
export const outcomesFrom = (trades: ClosedTrade[], source: string): Outcome[] => trades.filter(t => typeof t.confidence === "number" && Number.isFinite(t.confidence) && Number.isFinite(t.pnl))
  .map(t => ({ confidence: t.confidence!, win: t.pnl > 0, r: t.riskAmount > 0 ? t.pnl / t.riskAmount : null, closedAt: t.closedAt, source }));

/** Pool-adjacent-violators: the smallest monotone non-decreasing fit to weighted values. */
export function pav(values: number[], weights: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  values.forEach((v, i) => { blocks.push({ v, w: weights[i], n: 1 }); while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) { const b = blocks.pop()!, a = blocks.pop()!; const w = a.w + b.w; blocks.push({ v: w ? (a.v * a.w + b.v * b.w) / w : a.v, w, n: a.n + b.n }); } });
  return blocks.flatMap(b => Array(b.n).fill(b.v));
}
const binOf = (c: number) => EDGES.findIndex((lo, i) => c >= lo && c < EDGES[i + 1]);
const brier = (ps: number[], ys: number[]) => ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / Math.max(1, ps.length);

function fitBins(train: Outcome[]): CalBin[] {
  const raw = EDGES.slice(0, -1).map((lo, i) => { const hi = EDGES[i + 1], inb = train.filter(o => binOf(o.confidence) === i), w = inb.filter(o => o.win).length, rs = inb.map(o => o.r).filter((x): x is number => x !== null);
    const ci = wilson(w, inb.length) ?? { low: 0, high: 1 }; return { lo, hi, n: inb.length, wins: w, rate: inb.length ? w / inb.length : 0, low95: ci.low, high95: ci.high, meanR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, calibratedRate: 0 }; });
  // Bins with too few trades are merged into the neighbouring evidence by pooling inside PAV (weight = n); empty bins get weight 0 and inherit the monotone fit.
  const used = raw.filter(b => b.n > 0), fit = pav(used.map(b => b.rate), used.map(b => b.n));
  used.forEach((b, i) => { b.calibratedRate = fit[i]; });
  return raw.filter(b => b.n > 0);
}

export function fitCalibration(outcomes: Outcome[], now: number): CalibrationTable {
  const sorted = [...outcomes].sort((a, b) => a.closedAt - b.closedAt), n = sorted.length, sources = [...new Set(sorted.map(o => o.source))];
  const meta = { version: 1 as const, fittedAt: new Date(now).toISOString(), sources, samples: n, definition: DEFINITION };
  if (n < MIN_TOTAL) return { ...meta, trainSamples: n, holdoutSamples: 0, status: "insufficient_data", baseRate: n ? sorted.filter(o => o.win).length / n : null, brier: null, bins: fitBins(sorted), note: `${n} recorded outcomes; at least ${MIN_TOTAL} are required. The score stays uncalibrated.` };
  const cut = Math.floor(n * 0.7), train = sorted.slice(0, cut), hold = sorted.slice(cut), base = train.filter(o => o.win).length / train.length;
  const bins = fitBins(train), pred = (c: number) => { const b = bins.find(x => c >= x.lo && c < x.hi); return b && b.n >= MIN_BIN ? b.calibratedRate : base; };
  const ys = hold.map(o => (o.win ? 1 : 0)), model = brier(hold.map(o => pred(o.confidence)), ys), baseline = brier(hold.map(() => base), ys);
  // Final table uses all data for the bins once the held-out check has passed; the check itself used only earlier data.
  const ok = hold.length >= MIN_HOLDOUT && model < baseline;
  const finalBins = fitBins(sorted), allBase = sorted.filter(o => o.win).length / n;
  return { ...meta, trainSamples: train.length, holdoutSamples: hold.length, status: ok ? "calibrated" : "no_skill", baseRate: allBase, brier: { model, baseline }, bins: finalBins,
    note: ok ? "The reliability map beat the base rate on later, unseen trades. It describes past frequencies and is not a guarantee." : "The score did not predict outcomes better than the base rate on later, unseen trades, so it is not used as a probability." };
}

export interface AppliedCalibration { status: "uncalibrated" | "calibrated" | "no_skill"; note: string; observedWinRate?: number; interval95?: { low: number; high: number }; basedOn?: number; meanR?: number | null; fittedAt?: string; sources?: string[]; definition?: string }
export const UNCAL_NOTE = "Confidence is an analytical evidence score. It has not been calibrated against recorded outcomes and must not be read as a probability of profit.";
export function applyCalibration(t: CalibrationTable | null | undefined, confidence: number): AppliedCalibration {
  if (!t) return { status: "uncalibrated", note: UNCAL_NOTE };
  if (t.status === "insufficient_data") return { status: "uncalibrated", note: t.note, basedOn: t.samples };
  if (t.status === "no_skill") return { status: "no_skill", note: t.note, basedOn: t.samples, fittedAt: t.fittedAt, sources: t.sources };
  const b = t.bins.find(x => confidence >= x.lo && confidence < x.hi);
  if (!b || b.n < MIN_BIN) return { status: "uncalibrated", note: `Only ${b?.n ?? 0} recorded outcomes at this score (need ${MIN_BIN}); not calibrated here.`, basedOn: b?.n ?? 0 };
  return { status: "calibrated", note: `${b.wins} of ${b.n} past trades with a similar score closed net-positive. ${t.note}`, observedWinRate: b.calibratedRate, interval95: { low: b.low95, high: b.high95 }, basedOn: b.n, meanR: b.meanR, fittedAt: t.fittedAt, sources: t.sources, definition: t.definition };
}

export async function loadCalibration(kv: KV | undefined): Promise<CalibrationTable | null> {
  if (!kv) return null; const raw = await kv.get(CALIBRATION_KEY); if (!raw) return null;
  try { const t = JSON.parse(raw) as CalibrationTable; return t?.version === 1 && Array.isArray(t.bins) ? t : null; } catch { return null; }
}
export const saveCalibration = (kv: KV, t: CalibrationTable) => kv.put(CALIBRATION_KEY, JSON.stringify(t));

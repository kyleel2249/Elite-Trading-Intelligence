import type { Kline } from "../market.ts";
import { evaluateV3Alpha, type V3AlphaResult } from "./v3-alpha.ts";
import { EXECUTION_TF, TF_SECONDS, TIMEFRAMES, type Strategy, type Timeframe } from "./timeframes.ts";

export interface OutcomeSample {
  strategy: string; regime: string; score: number; outcome: "win" | "loss";
  outcome_r: number; signal_time: number; entry?: number; stop_loss?: number;
}
const validRows = (rows: Kline[]) => Array.isArray(rows) && rows.length <= 1000 &&
  rows.every((r, i) => r.slice(0, 6).every(Number.isFinite) && r[0] > 0 &&
    r[1] > 0 && r[2] >= Math.max(r[1], r[4]) && r[3] <= Math.min(r[1], r[4]) &&
    r[3] > 0 && r[5] >= 0 && (i === 0 || r[0] > rows[i - 1][0]));

export function evaluateSynchronizedV3Alpha(input: {
  symbol: string; strategy: Strategy; candles: Partial<Record<Timeframe, Kline[]>>; now?: number;
}): { signal: V3AlphaResult; synchronizedAt: number | null; coverage: Record<string, number>; warnings: string[] } {
  const now = input.now ?? Date.now(), execution = EXECUTION_TF[input.strategy];
  const raw = input.candles[execution] ?? [];
  if (!validRows(raw)) return { signal: evaluateV3Alpha({ ...input, now }), synchronizedAt: null, coverage: {}, warnings: ["Execution timeframe candles failed chronological OHLCV validation."] };
  const ms = TF_SECONDS[execution] * 1000;
  const closedExecution = raw.filter(c => c[0] + ms <= now);
  const last = closedExecution.at(-1);
  if (!last) return { signal: evaluateV3Alpha({ ...input, now }), synchronizedAt: null, coverage: {}, warnings: ["No fully closed execution candle is available."] };
  const synchronizedAt = last[0] + ms;
  const aligned: Partial<Record<Timeframe, Kline[]>> = {};
  const coverage: Record<string, number> = {};
  const warnings: string[] = [];
  for (const tf of TIMEFRAMES) {
    const source = input.candles[tf];
    if (!source) continue;
    if (!validRows(source)) { warnings.push(tf + " candles failed validation and were excluded."); continue; }
    const tfMs = TF_SECONDS[tf] * 1000;
    const rows = source.filter(c => c[0] + tfMs <= synchronizedAt);
    if (rows.length) aligned[tf] = rows;
    coverage[tf] = rows.length;
    if (source.some(c => c[0] + tfMs > synchronizedAt)) warnings.push(tf + " incomplete or future candles were excluded from the synchronized snapshot.");
  }
  const signal = evaluateV3Alpha({ symbol: input.symbol, strategy: input.strategy, candles: aligned, now: synchronizedAt });
  return { signal, synchronizedAt, coverage, warnings };
}

function metrics(rows: OutcomeSample[]) {
  const rs = rows.map(x => Number(x.outcome_r)).filter(Number.isFinite);
  const wins = rs.filter(x => x > 0), losses = rs.filter(x => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
  let equity = 1, peak = 1, maxDrawdownPct = 0;
  for (const r of rs) { equity *= Math.max(0, 1 + r * 0.01); peak = Math.max(peak, equity); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100); }
  return { sampleSize: rs.length, wins: wins.length, losses: losses.length,
    winRate: rs.length ? wins.length / rs.length : null,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
    netR: rs.reduce((a, b) => a + b, 0), maxDrawdownPct };
}

export function evaluateAgentGates(samples: OutcomeSample[], minimumSample = 30) {
  const groups = new Map<string, OutcomeSample[]>();
  for (const row of samples) {
    if (!Number.isFinite(row.outcome_r) || !Number.isFinite(row.signal_time)) continue;
    const key = row.strategy + "|" + row.regime;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    rows.sort((a, b) => a.signal_time - b.signal_time);
    const m = metrics(rows), eligible = m.sampleSize >= minimumSample;
    const approvedForPaperEvaluation = eligible && (m.expectancyR ?? -Infinity) > 0 && m.maxDrawdownPct <= 20;
    return { strategy: key.split("|")[0], regime: key.split("|")[1], ...m,
      minimumSample, status: !eligible ? "insufficient_sample" : approvedForPaperEvaluation ? "paper_evaluation_eligible" : "blocked_by_performance",
      approvedForPaperEvaluation, liveExecutionAllowed: false };
  });
}

export function thresholdSensitivity(samples: OutcomeSample[], thresholds = [55, 60, 65, 70, 75, 80]) {
  const chronological = samples.filter(x => Number.isFinite(x.score) && Number.isFinite(x.outcome_r)).sort((a, b) => a.signal_time - b.signal_time);
  const split = Math.floor(chronological.length * 0.7);
  return { totalSamples: chronological.length, split: "chronological_70_30",
    candidates: thresholds.map(threshold => {
      const selected = chronological.filter(x => x.score >= threshold);
      const train = selected.filter(x => x.signal_time < (chronological[split]?.signal_time ?? Infinity));
      const test = selected.filter(x => x.signal_time >= (chronological[split]?.signal_time ?? Infinity));
      return { threshold, train: metrics(train), test: metrics(test),
        status: test.length >= 30 ? "out_of_sample_sample_available" : "insufficient_out_of_sample_sample" };
    }),
    note: "Threshold sensitivity only. Parameters are not auto-selected or deployed; repeated tuning against this dataset can overfit." };
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
export function monteCarloRisk(input: { rMultiples: number[]; simulations?: number; tradesPerPath?: number; riskPct?: number; seed?: number }) {
  const values = input.rMultiples.filter(Number.isFinite);
  const simulations = Math.max(100, Math.min(10000, Math.floor(input.simulations ?? 3000)));
  const tradesPerPath = Math.max(10, Math.min(500, Math.floor(input.tradesPerPath ?? 100)));
  const riskPct = Math.max(0.1, Math.min(2, input.riskPct ?? 1));
  if (values.length < 30) return { status: "insufficient_sample", sampleSize: values.length, minimumSample: 30, simulations: 0, riskPct };
  let seed = (input.seed ?? 0x6d2b79f5) >>> 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const returns: number[] = [], drawdowns: number[] = [];
  let ruin = 0;
  for (let s = 0; s < simulations; s++) {
    let equity = 1, peak = 1, dd = 0;
    for (let t = 0; t < tradesPerPath; t++) {
      const r = values[Math.floor(random() * values.length)];
      equity *= Math.max(0, 1 + r * riskPct / 100);
      peak = Math.max(peak, equity);
      dd = Math.max(dd, (peak - equity) / peak);
      if (dd >= 0.5) { ruin++; break; }
    }
    returns.push((equity - 1) * 100); drawdowns.push(dd * 100);
  }
  returns.sort((a, b) => a - b); drawdowns.sort((a, b) => a - b);
  return { status: "simulated", sampleSize: values.length, simulations, tradesPerPath, riskPct,
    endingReturnPct: { p05: percentile(returns, .05), median: percentile(returns, .5), p95: percentile(returns, .95) },
    maxDrawdownPct: { p50: percentile(drawdowns, .5), p95: percentile(drawdowns, .95) },
    probabilityOf50PctDrawdown: ruin / simulations,
    method: "Bootstrap resampling of recorded net R-multiples with fixed fractional risk; not a forecast." };
}

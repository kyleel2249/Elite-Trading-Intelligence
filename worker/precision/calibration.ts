// Score calibration. The engine only prints a probability when a model fitted on recorded outcomes has been validated on
// later, held-out data and still matches the scoring configuration it was fitted for. Otherwise confidence is qualitative.
//
// Method: isotonic regression (pool-adjacent-violators) of win/loss against the opportunity score on a chronological
// training split, Laplace-smoothed, then Brier score, Brier skill and expected calibration error on the held-out tail.
import { wilson, type ClosedTrade } from "../algo/performance.ts";
import { ENGINE_VERSION, type CalibrationConfig } from "./config.ts";
import type { Confidence } from "./types.ts";
import { DAY_MS, cleanText, isFiniteNumber, isRecord, round } from "./util.ts";

export interface CalibrationSample { score: number; win: boolean; time?: number }
export interface CalibrationBlock { lo: number; hi: number; n: number; wins: number; /** Laplace-smoothed win probability. */ p: number }
export interface CalibrationModel {
  version: 1;
  strategy: string;
  engineVersion: string;
  scoreConfigHash: string;
  outcomeDefinition: string;
  trainedAt: string;
  samples: number; trainSamples: number; testSamples: number;
  blocks: CalibrationBlock[];
  metrics: { brier: number; baselineBrier: number; skill: number; ece: number };
  /** Metrics are always measured on data the blocks were not fitted on. */
  outOfSample: true;
}

export const DEFAULT_OUTCOME_DEFINITION = "Trade closed with a positive realised result after fees and slippage";
const smooth = (wins: number, n: number) => (wins + 1) / (n + 2);

interface RawBlock { lo: number; hi: number; n: number; wins: number }

/** Weighted pool-adjacent-violators over ordered blocks: merge neighbours until the win rate never decreases with score. */
function pool(blocks: RawBlock[]): RawBlock[] {
  const out: RawBlock[] = [];
  for (const b of blocks) {
    out.push({ ...b });
    while (out.length > 1) {
      const y = out[out.length - 1], x = out[out.length - 2];
      if (x.wins / x.n > y.wins / y.n) out.splice(-2, 2, { lo: x.lo, hi: y.hi, n: x.n + y.n, wins: x.wins + y.wins });
      else break;
    }
  }
  return out;
}

function mergeSmall(blocks: RawBlock[], minN: number): RawBlock[] {
  let cur = pool(blocks);
  for (let guard = 0; guard < 10_000 && cur.length > 1; guard++) {
    const i = cur.findIndex(b => b.n < minN);
    if (i < 0) break;
    const j = i === 0 ? 1 : i === cur.length - 1 ? i - 1 : (cur[i - 1].n <= cur[i + 1].n ? i - 1 : i + 1);
    const [a, b] = i < j ? [cur[i], cur[j]] : [cur[j], cur[i]];
    cur.splice(Math.min(i, j), 2, { lo: a.lo, hi: b.hi, n: a.n + b.n, wins: a.wins + b.wins });
    cur = pool(cur);
  }
  return cur;
}

/** Nearest block for a score. Scores in a gap between two blocks take the lower block's probability (the conservative choice). */
export function findBlock(blocks: CalibrationBlock[], score: number): CalibrationBlock {
  if (score <= blocks[0].hi) return blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (score >= b.lo && score <= b.hi) return b;
    if (score < b.lo) { const prev = blocks[i - 1]; return score - prev.hi <= b.lo - score ? prev : b; }
  }
  return blocks[blocks.length - 1];
}

export interface FitOptions { strategy: string; scoreConfigHash: string; outcomeDefinition?: string; now: number; trainFraction?: number; minBlockSamples?: number }

export function fitCalibration(input: CalibrationSample[], o: FitOptions): { model: CalibrationModel | null; reasons: string[] } {
  const minBlock = o.minBlockSamples ?? 30;
  const frac = o.trainFraction ?? 0.7;
  const reasons: string[] = [];
  let samples = input.filter(s => isFiniteNumber(s.score) && s.score >= 0 && s.score <= 100 && typeof s.win === "boolean");
  if (samples.length < input.length) reasons.push(`${input.length - samples.length} invalid sample(s) ignored`);
  if (samples.every(s => isFiniteNumber(s.time))) samples = [...samples].sort((a, b) => a.time! - b.time!);
  else reasons.push("samples carry no timestamps; they are assumed to be in chronological order");
  const cut = Math.floor(samples.length * frac);
  const train = samples.slice(0, cut), test = samples.slice(cut);
  if (train.length < minBlock * 2 || test.length < 1) { reasons.push(`not enough samples to fit and hold out data (need at least ${minBlock * 2} training samples; got ${train.length} train / ${test.length} test)`); return { model: null, reasons }; }

  const sorted = [...train].sort((a, b) => a.score - b.score);
  const seeds: RawBlock[] = sorted.map(s => ({ lo: s.score, hi: s.score, n: 1, wins: s.win ? 1 : 0 }));
  // Identical scores are one point on the curve: never split them across blocks.
  const grouped: RawBlock[] = [];
  for (const b of seeds) { const g = grouped[grouped.length - 1]; if (g && g.hi === b.lo) { g.n += 1; g.wins += b.wins; } else grouped.push({ ...b }); }
  const raw = mergeSmall(grouped, minBlock);
  const blocks: CalibrationBlock[] = raw.map(b => ({ lo: b.lo, hi: b.hi, n: b.n, wins: b.wins, p: smooth(b.wins, b.n) }));
  // Smoothing pulls small blocks harder toward 0.5, which can reverse the order of two blocks with equal raw rates.
  // Restore monotonicity (a higher score never maps to a lower probability) with a running maximum.
  let floor = 0;
  for (const b of blocks) { b.p = Math.max(b.p, floor); floor = b.p; }

  const baseP = smooth(train.filter(s => s.win).length, train.length);
  let brier = 0, base = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (const s of test) {
    const p = findBlock(blocks, s.score).p, y = s.win ? 1 : 0;
    brier += (p - y) ** 2; base += (baseP - y) ** 2;
    const k = Math.min(9, Math.floor(p * 10));
    bins[k].n++; bins[k].sumP += p; bins[k].sumY += y;
  }
  brier /= test.length; base /= test.length;
  const ece = bins.reduce((acc, b) => acc + (b.n ? (b.n / test.length) * Math.abs(b.sumY / b.n - b.sumP / b.n) : 0), 0);
  const model: CalibrationModel = {
    version: 1, strategy: o.strategy, engineVersion: ENGINE_VERSION, scoreConfigHash: o.scoreConfigHash,
    outcomeDefinition: o.outcomeDefinition ?? DEFAULT_OUTCOME_DEFINITION, trainedAt: new Date(o.now).toISOString(),
    samples: samples.length, trainSamples: train.length, testSamples: test.length, blocks,
    metrics: { brier: round(brier, 4), baselineBrier: round(base, 4), skill: base > 0 ? round(1 - brier / base, 4) : 0, ece: round(ece, 4) },
    outOfSample: true,
  };
  return { model, reasons };
}

/** Recorded paper/live outcomes whose entry score was stored in `confidence` become calibration samples. */
export function tradesToSamples(trades: ClosedTrade[]): CalibrationSample[] {
  return trades.filter(t => isFiniteNumber(t.confidence) && isFiniteNumber(t.pnl)).map(t => ({ score: t.confidence!, win: t.pnl > 0, time: t.closedAt }));
}

export interface AssessContext { strategy: string; hash: string; now: number; cfg: CalibrationConfig }

/** A model is usable only if every check passes. All failures are reported so an operator can see why confidence stayed qualitative. */
export function assessCalibration(model: CalibrationModel | null, c: AssessContext): { valid: boolean; reasons: string[] } {
  if (!model) return { valid: false, reasons: ["no calibration model is available"] };
  const r: string[] = [];
  if (model.engineVersion !== ENGINE_VERSION) r.push(`model was fitted on engine ${model.engineVersion}, current engine is ${ENGINE_VERSION}`);
  if (model.scoreConfigHash !== c.hash) r.push("scoring configuration changed since the model was fitted");
  if (model.strategy !== c.strategy) r.push(`model is for strategy '${model.strategy}', not '${c.strategy}'`);
  if (model.samples < c.cfg.minSamples) r.push(`only ${model.samples} samples (minimum ${c.cfg.minSamples})`);
  if (model.testSamples < c.cfg.minTestSamples) r.push(`only ${model.testSamples} held-out samples (minimum ${c.cfg.minTestSamples})`);
  if (model.blocks.some(b => b.n < c.cfg.minBlockSamples)) r.push(`a score block has fewer than ${c.cfg.minBlockSamples} samples`);
  if (!(model.metrics.ece <= c.cfg.maxEce)) r.push(`held-out calibration error ${model.metrics.ece} exceeds ${c.cfg.maxEce}`);
  if (!(model.metrics.skill >= c.cfg.minSkill)) r.push(`held-out Brier skill ${model.metrics.skill} does not beat the base-rate baseline by ${c.cfg.minSkill}`);
  const trained = Date.parse(model.trainedAt);
  if (!Number.isFinite(trained) || c.now - trained > c.cfg.maxAgeDays * DAY_MS || trained - c.now > DAY_MS) r.push(`model is older than ${c.cfg.maxAgeDays} days or has an invalid date`);
  return { valid: r.length === 0, reasons: r };
}

/** Calibrated confidence for a score, or null with reasons when the model may not be used. */
export function calibratedConfidence(model: CalibrationModel | null, score: number, c: AssessContext): { confidence: Confidence | null; reasons: string[] } {
  const a = assessCalibration(model, c);
  if (!a.valid || !model) return { confidence: null, reasons: a.reasons };
  const b = findBlock(model.blocks, score), w = wilson(b.wins, b.n)!;
  return {
    reasons: [],
    confidence: {
      type: "calibrated_probability", probability: round(b.p, 3), interval95: { low: round(w.low, 3), high: round(w.high, 3) }, outcomeDefinition: model.outcomeDefinition,
      basis: { samplesInScoreBlock: b.n, modelSamples: model.samples, testSamples: model.testSamples, brierScore: model.metrics.brier, brierSkill: model.metrics.skill, expectedCalibrationError: model.metrics.ece, trainedAt: model.trainedAt },
      note: "Estimated from this engine's own recorded outcomes with a model validated on held-out later data. It describes the past; it is not a guarantee, and it degrades if market conditions or execution change.",
    },
  };
}

/** Strict parser for a stored model: anything malformed or internally inconsistent is rejected. */
export function parseCalibrationModel(raw: unknown): CalibrationModel | null {
  if (!isRecord(raw) || raw.version !== 1 || raw.outOfSample !== true) return null;
  const strategy = cleanText(raw.strategy, 20), engineVersion = cleanText(raw.engineVersion, 20), hash = cleanText(raw.scoreConfigHash, 40), outcome = cleanText(raw.outcomeDefinition, 200), trainedAt = cleanText(raw.trainedAt, 40);
  if (!strategy || !engineVersion || !hash || !outcome || !trainedAt || !Number.isFinite(Date.parse(trainedAt))) return null;
  const { samples, trainSamples, testSamples } = raw;
  if (![samples, trainSamples, testSamples].every(v => isFiniteNumber(v) && Number.isInteger(v) && v >= 0)) return null;
  if (!Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 200) return null;
  const blocks: CalibrationBlock[] = [];
  for (const b of raw.blocks) {
    if (!isRecord(b) || !isFiniteNumber(b.lo) || !isFiniteNumber(b.hi) || !isFiniteNumber(b.n) || !isFiniteNumber(b.wins) || !isFiniteNumber(b.p)) return null;
    if (b.lo < 0 || b.hi > 100 || b.lo > b.hi || b.n < 1 || !Number.isInteger(b.n) || b.wins < 0 || b.wins > b.n || b.p <= 0 || b.p >= 1) return null;
    const prev = blocks[blocks.length - 1];
    if (prev && (b.lo <= prev.hi || b.p < prev.p)) return null; // blocks must be ordered, disjoint and monotone
    blocks.push({ lo: b.lo, hi: b.hi, n: b.n, wins: b.wins, p: b.p });
  }
  const m = raw.metrics;
  if (!isRecord(m) || ![m.brier, m.baselineBrier, m.skill, m.ece].every(isFiniteNumber)) return null;
  return { version: 1, strategy, engineVersion, scoreConfigHash: hash, outcomeDefinition: outcome, trainedAt, samples: samples as number, trainSamples: trainSamples as number, testSamples: testSamples as number, blocks,
    metrics: { brier: m.brier as number, baselineBrier: m.baselineBrier as number, skill: m.skill as number, ece: m.ece as number }, outOfSample: true };
}

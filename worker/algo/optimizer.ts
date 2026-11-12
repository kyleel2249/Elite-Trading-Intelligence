// Walk-forward optimizer, champion/challenger promotion and rollback (offline analytical tooling).
// Safety: the search space is a whitelist of bounded validator-weight profiles. It cannot touch risk limits, kill switch, permissions,
// environments or live trading. A recommendation is never applied automatically: promotion needs a named human approver.
// Rollback only ever returns to a previously approved configuration, so the automatic direction is the conservative one.
import { DEFAULT_MAX_COST_R, DEFAULT_THRESHOLDS, DEFAULT_VALIDATION_WEIGHTS, type Weights } from "./validation.ts";
import { EXECUTION_TF, TF_SECONDS } from "./timeframes.ts";
import { MIN_SAMPLE, computeReport, type ClosedTrade, type PerformanceReport } from "./performance.ts";
import { bootstrapMeanR, replay, type Bootstrap, type History, type ReplayConfig } from "./replay.ts";

const KEYS = Object.keys(DEFAULT_VALIDATION_WEIGHTS) as (keyof Weights)[];
const PINNED: Partial<Weights> = { dataIntegrity: DEFAULT_VALIDATION_WEIGHTS.dataIntegrity };
const BOUNDS = { min: 3, max: 40, riskRewardMin: 10 };

/** Scale selected components, pin data integrity, clamp to bounds and renormalise to the same total as the defaults. */
export function makeWeights(scale: Partial<Weights>): Weights {
  const total = KEYS.reduce((a, k) => a + DEFAULT_VALIDATION_WEIGHTS[k], 0), w = {} as Weights;
  for (const k of KEYS) w[k] = DEFAULT_VALIDATION_WEIGHTS[k] * (scale[k] ?? 1);
  const free = KEYS.filter(k => PINNED[k] === undefined), lo = (k: keyof Weights) => (k === "riskReward" ? BOUNDS.riskRewardMin : BOUNDS.min), pinned = KEYS.filter(k => PINNED[k] !== undefined).reduce((a, k) => a + PINNED[k]!, 0), target = total - pinned;
  const raw = Object.fromEntries(free.map(k => [k, Math.max(w[k], 1e-9)])) as Record<string, number>, clampSum = (f: number) => free.reduce((a, k) => a + Math.min(BOUNDS.max, Math.max(lo(k), raw[k] * f)), 0);
  let fl = 0, fh = 1e9; // the clamped total is monotone in the scale factor, so bisect for the factor that hits the target total
  for (let i = 0; i < 200; i++) { const m = (fl + fh) / 2; if (clampSum(m) < target) fl = m; else fh = m; }
  for (const k of free) w[k] = Math.min(BOUNDS.max, Math.max(lo(k), raw[k] * fh));
  for (const k of KEYS) if (PINNED[k] !== undefined) w[k] = PINNED[k]!;
  for (const k of KEYS) w[k] = Math.round(w[k] * 100) / 100;
  return w;
}
export function weightsAllowed(w: Weights): string | null {
  for (const k of KEYS) if (!Number.isFinite(w[k])) return `${k} is not finite`;
  if (Object.keys(w).some(k => !(KEYS as string[]).includes(k))) return "unknown weight key";
  for (const k of KEYS) { if (PINNED[k] !== undefined) { if (w[k] !== PINNED[k]) return `${k} is pinned`; } else if (w[k] < BOUNDS.min - 1e-6 || w[k] > BOUNDS.max + 1e-6) return `${k} outside bounds`; }
  if (w.riskReward < BOUNDS.riskRewardMin - 1e-6) return "riskReward below minimum";
  const t = KEYS.reduce((a, k) => a + w[k], 0), d = KEYS.reduce((a, k) => a + DEFAULT_VALIDATION_WEIGHTS[k], 0);
  return Math.abs(t - d) > 0.5 ? "weights do not keep the default total" : null;
}
export const CANDIDATES: Record<string, Weights> = {
  default: { ...DEFAULT_VALIDATION_WEIGHTS },
  trend_heavy: makeWeights({ technical: 1.5, consensus: 1.5 }),
  flow_heavy: makeWeights({ volume: 1.6, liquidity: 1.4 }),
  structure_heavy: makeWeights({ structure: 1.8, regime: 1.4 }),
  risk_averse: makeWeights({ riskReward: 1.4, regime: 1.5, liquidity: 1.2 }),
};

/** Tighten-only gate adjustments. Each can only make the validator stricter than the defaults, never looser. */
export interface Tighten { minRiskReward?: number; confirmed?: number; maxCostR?: number }
export interface Candidate { weights: Weights; tighten?: Tighten }
export function tightenAllowed(t: Tighten | undefined): string | null {
  if (!t) return null;
  const bad = (v: unknown) => v !== undefined && (typeof v !== "number" || !Number.isFinite(v));
  if (Object.keys(t).some(k => !["minRiskReward", "confirmed", "maxCostR"].includes(k))) return "unknown tighten key";
  if (bad(t.minRiskReward) || bad(t.confirmed) || bad(t.maxCostR)) return "tighten values must be finite numbers";
  if (t.minRiskReward !== undefined && (t.minRiskReward < DEFAULT_THRESHOLDS.minRiskReward || t.minRiskReward > 4)) return `minRiskReward must be within ${DEFAULT_THRESHOLDS.minRiskReward}..4 (tighten-only)`;
  if (t.confirmed !== undefined && (t.confirmed < DEFAULT_THRESHOLDS.confirmed || t.confirmed > 90)) return `confirmed must be within ${DEFAULT_THRESHOLDS.confirmed}..90 (tighten-only)`;
  if (t.maxCostR !== undefined && (t.maxCostR > DEFAULT_MAX_COST_R || t.maxCostR < 0.05)) return `maxCostR must be within 0.05..${DEFAULT_MAX_COST_R} (tighten-only)`;
  return null;
}
export function candidateAllowed(c: Candidate): string | null { return weightsAllowed(c.weights) ?? tightenAllowed(c.tighten); }
/** Search space that actually changes which trades fire (re-weighting alone did not, on real data). All entries are tighten-only. */
export const TIGHTENINGS: Record<string, Tighten> = { rr2: { minRiskReward: 2 }, rr2_5: { minRiskReward: 2.5 }, conf72: { confirmed: 72 }, conf80: { confirmed: 80 }, cost15: { maxCostR: 0.15 }, strict: { minRiskReward: 2, confirmed: 72, maxCostR: 0.15 } };
/** Default search set: the default plus tightenings. The weight-only profiles stay exported in CANDIDATES but are left out because real-data runs showed they leave the trade set unchanged and only add multiple-comparison noise. */
export const CANDIDATE_SET: Record<string, Candidate> = { default: { weights: CANDIDATES.default }, ...Object.fromEntries(Object.entries(TIGHTENINGS).map(([k, t]) => [`tight_${k}`, { weights: CANDIDATES.default, tighten: t }])) };
const replayCfg = (c: Candidate): Pick<ReplayConfig, "weights" | "thresholds" | "maxCostR"> => ({ weights: c.weights, thresholds: { ...(c.tighten?.minRiskReward !== undefined ? { minRiskReward: c.tighten.minRiskReward } : {}), ...(c.tighten?.confirmed !== undefined ? { confirmed: c.tighten.confirmed } : {}) }, maxCostR: c.tighten?.maxCostR });
const asCandidate = (x: Candidate | Weights): Candidate => ("weights" in x ? x as Candidate : { weights: x as Weights });

export interface OptimizerConfig { folds?: number; minTrainTrades?: number; minOosTrades?: number; marginR?: number; replay: Omit<ReplayConfig, "weights">; candidates?: Record<string, Candidate | Weights> }
export interface FoldResult { fold: number; trainBars: number; testBars: number; chosen: string | null; trainMeanR: Record<string, number | null>; trainTrades: Record<string, number>; oosChosenTrades: number; oosChampionTrades: number }
export interface Pooled { trades: number; meanR: number | null; bootstrap: Bootstrap | null; report: PerformanceReport }
export interface PromotionDecision { decision: "RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL" | "KEEP_CHAMPION"; reasons: string[]; autoApplied: false }
export interface OptimizerResult { symbol: string; strategy: string; folds: FoldResult[]; challenger: { name: string; weights: Weights; tighten?: Tighten; selectionStability: number } | null; oosChallenger: Pooled; oosChampion: Pooled; candidatesTried: number; promotion: PromotionDecision; caveats: string[] }

const rOf = (t: ClosedTrade) => (t.riskAmount > 0 ? t.pnl / t.riskAmount : null);
export function meanR(trades: ClosedTrade[]): number | null { const rs = trades.map(rOf).filter((x): x is number => x !== null); return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null; }
const pool = (trades: ClosedTrade[], start: number): Pooled => ({ trades: trades.length, meanR: meanR(trades), bootstrap: bootstrapMeanR(trades), report: computeReport(trades, start) });

/** Keep every timeframe but cut the execution series to bars [from, to). Higher timeframes are filtered by the replay's own closed-candle rule. */
export function sliceHistory(h: History, strategy: ReplayConfig["strategy"], from: number, to: number): History {
  const tf = EXECUTION_TF[strategy], exec = h[tf]!, out: History = { ...h }; out[tf] = exec.slice(from, to);
  const cutoff = exec[Math.min(to, exec.length) - 1][0] + TF_SECONDS[tf] * 1000;
  for (const k of Object.keys(out) as (keyof History)[]) if (k !== tf && out[k]) out[k] = out[k]!.filter(c => c[0] <= cutoff);
  return out;
}

export function decidePromotion(chal: Pooled, champ: Pooled, stability: number, c: { minOosTrades: number; marginR: number; candidatesTried: number }): PromotionDecision {
  const why: string[] = [];
  if (chal.trades < c.minOosTrades) why.push(`Challenger has ${chal.trades} out-of-sample trades (< ${c.minOosTrades})`);
  if (champ.trades < c.minOosTrades) why.push(`Champion has ${champ.trades} out-of-sample trades (< ${c.minOosTrades}), so the comparison is not reliable`);
  if (chal.meanR === null || champ.meanR === null || chal.meanR - champ.meanR < c.marginR) why.push(`Out-of-sample expectancy improvement is below the ${c.marginR}R margin (${chal.meanR === null ? "n/a" : chal.meanR.toFixed(3)}R vs ${champ.meanR === null ? "n/a" : champ.meanR.toFixed(3)}R)`);
  if (!chal.bootstrap || chal.bootstrap.low95 <= 0) why.push("Challenger's bootstrap 95% interval for mean R does not exclude zero");
  if (chal.report.maxDrawdownPct > champ.report.maxDrawdownPct * 1.25 + 1e-9) why.push("Challenger's out-of-sample drawdown is more than 25% worse than the champion's");
  if (stability < 0.5) why.push(`Selection is unstable: the challenger won only ${(stability * 100).toFixed(0)}% of folds`);
  return why.length ? { decision: "KEEP_CHAMPION", reasons: why, autoApplied: false }
    : { decision: "RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL", reasons: [`Cleared every gate out of sample (selected from ${c.candidatesTried} candidates, so some optimism from selection remains). A named human must approve before use; nothing is applied automatically.`], autoApplied: false };
}

export async function walkForward(history: History, cfg: OptimizerConfig): Promise<OptimizerResult> {
  const cands: Record<string, Candidate> = Object.fromEntries(Object.entries(cfg.candidates ?? CANDIDATE_SET).map(([k, v]) => [k, asCandidate(v)])), names = Object.keys(cands), strategy = cfg.replay.strategy, exec = history[EXECUTION_TF[strategy]];
  for (const n of names) { const bad = candidateAllowed(cands[n]); if (bad) throw new Error(`Candidate ${n} rejected: ${bad}`); }
  if (!names.includes("default")) throw new Error("The champion candidate 'default' is required");
  const K = Math.max(2, cfg.folds ?? 4), warm = cfg.replay.warmupBars ?? 120;
  if (!exec || exec.length < (K + 1) * 150) throw new Error(`Walk-forward needs at least ${(K + 1) * 150} execution candles for ${K} folds; received ${exec?.length ?? 0}`);
  const part = Math.floor(exec.length / (K + 1)), start = cfg.replay.startingEquity ?? 10_000, folds: FoldResult[] = [], chalTrades: ClosedTrade[] = [], champTrades: ClosedTrade[] = [], wins: Record<string, number> = {};
  for (let j = 1; j <= K; j++) {
    const trainEnd = part * j, testEnd = j === K ? exec.length : part * (j + 1), trainH = sliceHistory(history, strategy, 0, trainEnd), testH = sliceHistory(history, strategy, trainEnd - warm, testEnd);
    const trainMean: Record<string, number | null> = {}, trainN: Record<string, number> = {};
    for (const n of names) { const r = await replay(trainH, { ...cfg.replay, ...replayCfg(cands[n]) }); trainMean[n] = meanR(r.trades); trainN[n] = r.trades.length; }
    const eligible = names.filter(n => trainN[n] >= (cfg.minTrainTrades ?? 10) && trainMean[n] !== null).sort((a, b) => trainMean[b]! - trainMean[a]! || (a === "default" ? -1 : 1));
    const chosen = eligible[0] ?? null; if (chosen) wins[chosen] = (wins[chosen] ?? 0) + 1;
    // Out-of-sample: only trades that opened after the training boundary count.
    const oos = async (n: string) => (await replay(testH, { ...cfg.replay, ...replayCfg(cands[n]) })).trades.filter(t => t.openedAt >= exec[trainEnd][0]);
    const cT = await oos(chosen ?? "default"), dT = chosen === "default" || !chosen ? cT : await oos("default");
    chalTrades.push(...cT); champTrades.push(...dT);
    folds.push({ fold: j, trainBars: trainEnd, testBars: testEnd - trainEnd, chosen, trainMeanR: trainMean, trainTrades: trainN, oosChosenTrades: cT.length, oosChampionTrades: dT.length });
  }
  const last = folds.at(-1)!.chosen, challenger = last ? { name: last, weights: cands[last].weights, tighten: cands[last].tighten, selectionStability: (wins[last] ?? 0) / K } : null;
  const oosChallenger = pool(chalTrades, start), oosChampion = pool(champTrades, start), minOos = cfg.minOosTrades ?? MIN_SAMPLE;
  const promotion: PromotionDecision = !challenger ? { decision: "KEEP_CHAMPION", reasons: ["No candidate reached the minimum number of training trades in the latest fold"], autoApplied: false }
    : challenger.name === "default" ? { decision: "KEEP_CHAMPION", reasons: ["The default configuration remained the best candidate in the latest fold"], autoApplied: false }
    : decidePromotion(oosChallenger, oosChampion, challenger.selectionStability, { minOosTrades: minOos, marginR: cfg.marginR ?? 0.1, candidatesTried: names.length });
  return { symbol: cfg.replay.symbol, strategy, folds, challenger, oosChallenger, oosChampion, candidatesTried: names.length, promotion, caveats: [
    "Anchored walk-forward: each fold trains on all earlier data and is scored only on the next unseen block; the pooled out-of-sample trades are what count.",
    "Picking the best of several candidates inflates results; the promotion gates (margin, interval above zero, drawdown, stability) are the guard against this, not a guarantee.",
    "Same replay limits apply: no historical order book, flat fees/slippage, in-process paper safeguards only. Results are not a forecast.",
    "The search space is limited to bounded validator weights and tighten-only gate adjustments (minimum reward/risk, confirmation threshold, cost limit); none can loosen a default. Risk limits, permissions and live-trading settings are not tunable here." ] };
}

// ---------- champion/challenger registry with rollback ----------
export interface ParamVersion { id: number; name: string; weights: Weights; tighten?: Tighten; createdAt: number; status: "champion" | "challenger" | "retired" | "rolled_back"; evidence: string; approvedBy: string | null; baselineMeanR: number | null; baselineMaxDrawdownPct: number | null }
export interface RegistryState { versions: ParamVersion[]; audit: { ts: number; action: string; id: number | null; detail: string }[] }
export interface ParamStore { load(): Promise<RegistryState | null>; save(s: RegistryState): Promise<void> }
export class MemoryParamStore implements ParamStore { s: RegistryState | null = null; async load() { return this.s ? structuredClone(this.s) : null; } async save(s: RegistryState) { this.s = structuredClone(s); } }
export class KVParamStore implements ParamStore {
  kv: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }; key: string;
  constructor(kv: KVParamStore["kv"], key = "algo:params:v1") { this.kv = kv; this.key = key; }
  async load() { const t = await this.kv.get(this.key); return t ? JSON.parse(t) as RegistryState : null; }
  async save(s: RegistryState) { await this.kv.put(this.key, JSON.stringify(s)); }
}
export class ParamRegistry {
  store: ParamStore; st: RegistryState; now: () => number;
  constructor(store: ParamStore, st: RegistryState, now: () => number) { this.store = store; this.st = st; this.now = now; }
  static async open(store: ParamStore, now: () => number = Date.now): Promise<ParamRegistry> {
    const st = (await store.load()) ?? { versions: [{ id: 1, name: "default", weights: { ...DEFAULT_VALIDATION_WEIGHTS }, createdAt: now(), status: "champion", evidence: "built-in defaults", approvedBy: "system-default", baselineMeanR: null, baselineMaxDrawdownPct: null }], audit: [] };
    return new ParamRegistry(store, st, now);
  }
  champion(): ParamVersion { return this.st.versions.find(v => v.status === "champion")!; }
  private log(action: string, id: number | null, detail: string) { this.st.audit.push({ ts: this.now(), action, id, detail }); }
  async propose(name: string, weights: Weights, result: OptimizerResult, tighten?: Tighten): Promise<ParamVersion> {
    const bad = candidateAllowed({ weights, tighten }); if (bad) throw new Error(`Rejected: ${bad}`);
    if (result.promotion.decision !== "RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL" || result.challenger?.name !== name) throw new Error("Rejected: the optimizer did not recommend this challenger");
    const v: ParamVersion = { id: Math.max(...this.st.versions.map(x => x.id)) + 1, name, weights: { ...weights }, ...(tighten ? { tighten: { ...tighten } } : {}), createdAt: this.now(), status: "challenger", evidence: `OOS meanR ${result.oosChallenger.meanR?.toFixed(3)} over ${result.oosChallenger.trades} trades`, approvedBy: null, baselineMeanR: result.oosChallenger.meanR, baselineMaxDrawdownPct: result.oosChallenger.report.maxDrawdownPct };
    this.st.versions.push(v); this.log("propose", v.id, v.evidence); await this.store.save(this.st); return v;
  }
  /** Only a named human approver can promote, and only a proposed challenger. The AI cannot approve its own change. */
  async promote(id: number, approver: string): Promise<ParamVersion> {
    if (!approver.trim() || approver.trim().toLowerCase() === "system-default" || /^(ai|claude|auto|optimizer|bot)$/i.test(approver.trim())) throw new Error("Promotion requires a named human approver");
    const v = this.st.versions.find(x => x.id === id && x.status === "challenger"); if (!v) throw new Error("No such challenger");
    const old = this.champion(); old.status = "retired"; v.status = "champion"; v.approvedBy = approver.trim(); this.log("promote", id, `approved by ${approver.trim()}, replaces ${old.id}`); await this.store.save(this.st); return v;
  }
  async rollback(reason: string): Promise<ParamVersion> {
    const cur = this.champion(), prev = [...this.st.versions].reverse().find(v => v.status === "retired" && v.approvedBy);
    if (!prev) throw new Error("No previously approved configuration to roll back to");
    cur.status = "rolled_back"; prev.status = "champion"; this.log("rollback", prev.id, `${reason}; reverted from ${cur.id}`); await this.store.save(this.st); return prev;
  }
}
export interface RollbackVerdict { rollback: boolean; reasons: string[] }
/** Compare recent live-paper trades against the evidence the champion was approved on. */
export function rollbackCheck(v: Pick<ParamVersion, "baselineMeanR" | "baselineMaxDrawdownPct">, recent: ClosedTrade[], start = 10_000, o: { minTrades?: number; toleranceR?: number } = {}): RollbackVerdict {
  const min = o.minTrades ?? 30; if (recent.length < min) return { rollback: false, reasons: [`Only ${recent.length} recent trades (< ${min}); not enough to judge degradation`] };
  const why: string[] = [], m = meanR(recent), rep = computeReport(recent, start);
  if (v.baselineMeanR !== null && m !== null && m < v.baselineMeanR - (o.toleranceR ?? 0.3)) why.push(`Recent mean R ${m.toFixed(3)} is more than ${o.toleranceR ?? 0.3}R below the approved baseline ${v.baselineMeanR.toFixed(3)}`);
  if (m !== null && m < 0) why.push(`Recent mean R is negative (${m.toFixed(3)})`);
  if (v.baselineMaxDrawdownPct !== null && v.baselineMaxDrawdownPct > 0 && rep.maxDrawdownPct > v.baselineMaxDrawdownPct * 1.5) why.push("Recent drawdown exceeds 1.5x the approved baseline");
  return { rollback: why.length > 0, reasons: why.length ? why : ["Within tolerance of the approved baseline"] };
}
export async function autoRollbackIfDegraded(reg: ParamRegistry, recent: ClosedTrade[], start?: number): Promise<RollbackVerdict & { applied: boolean }> {
  const c = reg.champion(), v = rollbackCheck(c, recent, start); if (!v.rollback || c.name === "default" && !reg.st.versions.some(x => x.status === "retired" && x.approvedBy)) return { ...v, applied: false };
  try { await reg.rollback(v.reasons.join("; ")); return { ...v, applied: true }; } catch { return { ...v, applied: false }; }
}

/** When the current champion took over (the last promote or rollback that made it champion); 0 if it has always been champion. */
export function championSince(reg: ParamRegistry): number {
  const c = reg.champion(); let ts = 0;
  for (const a of reg.st.audit) if ((a.action === "promote" || a.action === "rollback") && a.id === c.id) ts = Math.max(ts, a.ts);
  return ts;
}
export interface DegradationStep { checked: number; since: number; verdict: RollbackVerdict; applied: boolean; from: string; to: string | null; autoEnabled: boolean }
/** Phase 11: judge the champion only on trades closed since it took over (so a restored version is not blamed for its predecessor's losses),
 * and restore the last human-approved version when the predefined degradation thresholds are breached. Rollback only ever returns to a
 * previously approved version; it can never promote anything new. */
export async function degradationStep(reg: ParamRegistry, closed: ClosedTrade[], start: number, autoEnabled = true): Promise<DegradationStep> {
  const since = championSince(reg), recent = closed.filter(t => t.closedAt >= since).slice(-60), from = reg.champion().name;
  if (!autoEnabled) { const verdict = rollbackCheck(reg.champion(), recent, start); return { checked: recent.length, since, verdict, applied: false, from, to: null, autoEnabled }; }
  const r = await autoRollbackIfDegraded(reg, recent, start);
  return { checked: recent.length, since, verdict: { rollback: r.rollback, reasons: r.reasons }, applied: r.applied, from, to: r.applied ? reg.champion().name : null, autoEnabled };
}

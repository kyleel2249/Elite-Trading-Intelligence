// Scheduled outcome cycle: record tradeable signals, resolve them from closed candles, refit calibration and expectancy.
// Off unless ETI_PRECISION_SYMBOLS is set (and a KV namespace is bound). It records and measures; it never places an order.
//
// Workers Free allows 50 subrequests per invocation, so one tick does a bounded amount of work: it evaluates at most
// ETI_PRECISION_BATCH (default 1) symbol/strategy pairs (about 8 fetches each) and resolves at most MAX_RESOLVE_FETCHES
// distinct symbol/timeframe candle sets. Pairs rotate across ticks.
import { getMarketData, providerOrder, type Kline } from "../market.ts";
import type { Strategy } from "../algo/timeframes.ts";
import { wilson } from "../algo/performance.ts";
import { assessCalibration, fitCalibration } from "./calibration.ts";
import { resolveConfig, scoreConfigHash, type PrecisionConfig } from "./config.ts";
import { MAX_OPEN, MAX_OUTCOMES, entryFromSignal, expectancyOf, parseEntries, parseOutcomes, resolveEntry, resolved, type LedgerEntry, type LedgerOutcome } from "./ledger.ts";
import { STRATEGIES, buildSignal, isStrategy } from "./service.ts";
import { SYMBOL_RE, keys as baseKeys, precisionStore, type KvLike, type PrecisionEnv } from "./stores.ts";
import { parseInstrument } from "./engine.ts";
import { DAY_MS, isRecord, round } from "./util.ts";

export const MAX_RESOLVE_FETCHES = 4;
export const MIN_FIT_OUTCOMES = 100;
export const REFIT_EVERY_NEW = 25;
export const ledgerKeys = {
  open: () => "precision:ledger:open",
  outcomes: (s: Strategy) => `precision:ledger:outcomes:${s}`,
  meta: (s: Strategy) => `precision:ledger:meta:${s}`,
};

export interface LedgerMeta { lastFitAt: number; lastFitCount: number }
export interface CycleReport {
  status: "disabled" | "ok";
  reason?: string;
  evaluated: { symbol: string; strategy: Strategy; result: string }[];
  recorded: string[];
  resolved: { id: string; status: string; netR: number | null }[];
  refit: { strategy: Strategy; calibration: string; expectancy: string }[];
  notes: string[];
}

async function readJson(kv: KvLike, key: string): Promise<unknown> { try { const t = await kv.get(key); return t ? JSON.parse(t) : null; } catch { return null; } }
const write = (kv: KvLike, key: string, v: unknown) => kv.put(key, JSON.stringify(v));

export function configuredPairs(env: PrecisionEnv & Record<string, unknown>): { symbol: string; strategy: Strategy }[] {
  const symbols = String(env.ETI_PRECISION_SYMBOLS ?? "").split(",").map(s => s.trim().toUpperCase()).filter(s => SYMBOL_RE.test(s) && parseInstrument(s)).slice(0, 10);
  const strategies = String(env.ETI_PRECISION_STRATEGIES ?? "intraday").split(",").map(s => s.trim()).filter(isStrategy);
  const uniq = [...new Set(strategies)];
  return symbols.flatMap(symbol => (uniq.length ? uniq : ["intraday" as Strategy]).map(strategy => ({ symbol, strategy })));
}

export async function runPrecisionCycle(env: PrecisionEnv & Record<string, unknown>, now: number, opts: { only?: { symbol: string; strategy: Strategy } } = {}): Promise<CycleReport> {
  const report: CycleReport = { status: "ok", evaluated: [], recorded: [], resolved: [], refit: [], notes: [] };
  const kv = precisionStore(env);
  if (!kv) return { ...report, status: "disabled", reason: "No KV namespace is bound (ETI_PRECISION_DATA or ETI_EXECUTION_LOG)" };
  const pairs = opts.only ? [opts.only] : configuredPairs(env);
  const openBefore = parseEntries(await readJson(kv, ledgerKeys.open()));
  if (!pairs.length && !openBefore.length) return { ...report, status: "disabled", reason: "ETI_PRECISION_SYMBOLS is not set" };
  const resolvedCfg = resolveConfig(env.ETI_PRECISION_CONFIG);
  const cfg = resolvedCfg.config, hash = scoreConfigHash(cfg);
  const order = providerOrder(env as any, null);

  // 1. Resolve open signals from closed candles.
  let open = openBefore;
  const touched = new Set<Strategy>();
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of [...open].sort((a, b) => a.createdAt - b.createdAt)) { const k = `${e.symbol}|${e.timeframe}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
  const doneIds = new Set<string>(), newOutcomes: LedgerOutcome[] = [];
  for (const [k, entries] of [...groups].slice(0, MAX_RESOLVE_FETCHES)) {
    const [symbol, timeframe] = k.split("|");
    let rows: Kline[];
    try { rows = (await getMarketData("klines", { symbol, interval: timeframe, limit: 300 }, order)).data as Kline[]; }
    catch (e) { report.notes.push(`Could not fetch ${symbol} ${timeframe} candles to resolve ${entries.length} signal(s): ${e instanceof Error ? e.message : "unknown"}`); continue; }
    for (const e of entries) {
      const r = resolveEntry(e, rows, now);
      if (r.state === "done") { doneIds.add(e.id); newOutcomes.push(r.outcome); touched.add(e.strategy); report.resolved.push({ id: e.id, status: r.outcome.status, netR: r.outcome.netR }); }
    }
  }
  open = open.filter(e => !doneIds.has(e.id));
  const byStrategy = new Map<Strategy, LedgerOutcome[]>();
  for (const o of newOutcomes) byStrategy.set(o.strategy, [...(byStrategy.get(o.strategy) ?? []), o]);
  const outcomesFor = new Map<Strategy, LedgerOutcome[]>();
  for (const s of STRATEGIES) {
    const prior = parseOutcomes(await readJson(kv, ledgerKeys.outcomes(s)));
    const add = byStrategy.get(s) ?? [];
    const all = [...prior, ...add].slice(-MAX_OUTCOMES);
    outcomesFor.set(s, all);
    if (add.length) await write(kv, ledgerKeys.outcomes(s), all);
  }

  // 2. Record new tradeable signals for this tick's batch.
  const batch = Math.max(1, Math.min(4, Math.floor(Number(env.ETI_PRECISION_BATCH ?? 1)) || 1));
  const picked = opts.only ? pairs : pairs.length ? Array.from({ length: Math.min(batch, pairs.length) }, (_, i) => pairs[(Math.floor(now / 300_000) * batch + i) % pairs.length]) : [];
  for (const p of picked) {
    if (open.some(e => e.symbol === p.symbol && e.strategy === p.strategy)) { report.evaluated.push({ ...p, result: "skipped: an earlier signal for this pair is still open" }); continue; }
    if (open.length >= MAX_OPEN) { report.evaluated.push({ ...p, result: "skipped: open-signal limit reached" }); continue; }
    const built = await buildSignal(env, p.symbol, p.strategy, null);
    if (!built.signal) { report.evaluated.push({ ...p, result: `no signal (HTTP ${built.status})` }); continue; }
    const entry = entryFromSignal(built.signal);
    if (!entry) { report.evaluated.push({ ...p, result: `${built.signal.direction}: not recorded` }); continue; }
    if (entry.configHash !== hash) { report.evaluated.push({ ...p, result: "not recorded: configuration changed during the run" }); continue; }
    open.push(entry); report.recorded.push(entry.id);
    report.evaluated.push({ ...p, result: `${built.signal.direction} recorded` });
  }
  if (open.length !== openBefore.length || doneIds.size) await write(kv, ledgerKeys.open(), open);

  // 3. Refit calibration and expectancy when enough new outcomes exist.
  const strategies = opts.only ? [opts.only.strategy] : [...touched];
  for (const s of new Set(strategies)) {
    const r = await refit(kv, s, outcomesFor.get(s) ?? [], cfg, hash, now, !!opts.only);
    if (r) report.refit.push({ strategy: s, ...r });
  }
  if (resolvedCfg.status === "override_rejected") report.notes.push("ETI_PRECISION_CONFIG was rejected; defaults are in use");
  return report;
}

async function refit(kv: KvLike, strategy: Strategy, all: LedgerOutcome[], cfg: PrecisionConfig, hash: string, now: number, force: boolean) {
  const done = resolved(all);
  const meta = ((): LedgerMeta => { return { lastFitAt: 0, lastFitCount: 0 }; })();
  const stored = await readJson(kv, ledgerKeys.meta(strategy));
  if (isRecord(stored) && typeof stored.lastFitAt === "number" && typeof stored.lastFitCount === "number") { meta.lastFitAt = stored.lastFitAt; meta.lastFitCount = stored.lastFitCount; }
  const due = done.length >= MIN_FIT_OUTCOMES && (force || done.length - meta.lastFitCount >= REFIT_EVERY_NEW || now - meta.lastFitAt > 7 * DAY_MS);
  if (!due && !force) return null;
  const out = { calibration: "not fitted", expectancy: "not updated" };

  // Calibration: only outcomes scored under the CURRENT scoring configuration describe what today's scores mean.
  const mine = done.filter(o => o.configHash === hash);
  const fit = fitCalibration(mine.map(o => ({ score: o.score, win: o.win as boolean, time: o.closedAt })), { strategy, scoreConfigHash: hash, now, minBlockSamples: cfg.calibration.minBlockSamples });
  if (fit.model) {
    const a = assessCalibration(fit.model, { strategy, hash, now, cfg: cfg.calibration });
    await write(kv, baseKeys.calibration(strategy), fit.model);
    out.calibration = a.valid ? `fitted and usable (${fit.model.samples} outcomes, Brier skill ${fit.model.metrics.skill})` : `fitted but not usable: ${a.reasons.join("; ")}`;
  } else out.calibration = `not fitted: ${fit.reasons.join("; ")}`;

  // Expectancy: all resolved outcomes of this strategy. A positive claim needs a bootstrap interval entirely above zero;
  // otherwise it is stored as "unproven" (samples 0), which the engine treats as not evaluated and never as a pass.
  const ex = expectancyOf(done.map(o => o.netR as number), cfg.minExpectancySamples);
  if (ex) {
    const proven = ex.meanR <= 0 || ex.low95 > 0;
    await write(kv, baseKeys.expectancy(strategy), {
      strategy, expectancyR: round(ex.meanR, 3), samples: proven ? ex.samples : 0, asOf: new Date(now).toISOString(),
      source: proven ? `precision outcome ledger (${ex.samples} outcomes, 95% interval ${round(ex.low95, 2)} to ${round(ex.high95, 2)} R)` : `precision outcome ledger: unproven, 95% interval ${round(ex.low95, 2)} to ${round(ex.high95, 2)} R includes zero`,
    });
    out.expectancy = proven ? `${round(ex.meanR, 3)} R over ${ex.samples} outcomes` : "stored as unproven (interval includes zero)";
  } else out.expectancy = `not updated: fewer than ${cfg.minExpectancySamples} resolved outcomes`;
  await write(kv, ledgerKeys.meta(strategy), { lastFitAt: now, lastFitCount: done.length });
  return out;
}

/** Read-only ledger summary for GET /api/precision/ledger. */
export async function ledgerSummary(env: PrecisionEnv, strategy: Strategy, now: number) {
  const kv = precisionStore(env);
  if (!kv) return { storeConfigured: false as const };
  const open = parseEntries(await readJson(kv, ledgerKeys.open())).filter(e => e.strategy === strategy);
  const all = parseOutcomes(await readJson(kv, ledgerKeys.outcomes(strategy)));
  const done = resolved(all);
  const wins = done.filter(o => o.win).length;
  const net = done.map(o => o.netR as number);
  const meta = await readJson(kv, ledgerKeys.meta(strategy));
  const w = done.length ? wilson(wins, done.length) : null;
  return {
    storeConfigured: true as const, strategy, now: new Date(now).toISOString(),
    open: open.length, resolved: done.length, notFilled: all.filter(o => o.status === "not_filled").length, void: all.filter(o => o.status === "void").length,
    winRate: done.length ? round(wins / done.length, 3) : null, winRateInterval95: w ? { low: round(w.low, 3), high: round(w.high, 3) } : null,
    meanNetR: net.length ? round(net.reduce((a, b) => a + b, 0) / net.length, 3) : null,
    lastFit: isRecord(meta) ? meta : null,
    recent: all.slice(-20).reverse(),
    definition: "Win = net result above zero after the signal's own round-trip costs. Not-filled and void signals are excluded from win rate and calibration.",
    caveat: "Only tradeable signals are recorded, so calibration describes the score range the engine actually signals. Small samples are wide-interval estimates, not forecasts.",
  };
}

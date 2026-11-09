// Historical replay lab. Feeds candles bar by bar through the real chain (engines -> fusion -> independent
// validation -> paper engine with fees, slippage and partial exits) and measures the outcome.
// No lookahead: at decision time t only candles that have CLOSED by t are visible, and fills happen at the NEXT bar's open.
// This module never fetches data and never trades; the data source is supplied by the caller.
import type { Kline } from "../market.ts";
import { TF_SECONDS, TIMEFRAMES, type Strategy, type Timeframe } from "./timeframes.ts";
import { EXECUTION_TF } from "./timeframes.ts";
import { runOmnisignal } from "./omnisignal.ts";
import { DEFAULT_PAPER_CONFIG, MemoryPaperStore, PaperEngine, type PaperConfig } from "./paper.ts";
import { MIN_SAMPLE, computeReport, reportsByEngine, type ClosedTrade, type PerformanceReport } from "./performance.ts";
import type { Thresholds, Weights } from "./validation.ts";

export type History = Partial<Record<Timeframe, Kline[]>>;
export interface ReplayConfig {
  symbol: string; strategy: Strategy; startingEquity?: number; stepBars?: number; windowCandles?: number; warmupBars?: number;
  enabledEngines?: { swift: boolean; gainz: boolean }; weights?: Weights; thresholds?: Partial<Thresholds>; maxCostR?: number; /** Round-trip cost assumption in bps for the validator gate. Default: derived from the paper fee and slippage. */ roundTripCostBps?: number; paper?: Partial<PaperConfig>; outOfSampleFraction?: number; bootstrapSamples?: number; seed?: number;
}
export interface Bootstrap { meanR: number; low95: number; high95: number; samples: number }
export interface ReplayResult {
  symbol: string; strategy: Strategy; execTimeframe: Timeframe; bars: number; evaluations: number; periodStart: number; periodEnd: number;
  decisions: Record<string, number>; agreements: Record<string, number>; paperRejections: Record<string, number>; openAtEnd: number;
  /** Every accepted entry: the bar open time and the market price the paper engine was offered (the NEXT bar's open). */
  fills: { ts: number; marketPrice: number; signalBarClose: number }[]; trades: ClosedTrade[]; report: PerformanceReport; inSample: PerformanceReport; outOfSample: PerformanceReport; byEngine: Record<string, PerformanceReport>;
  bootstrapExpectancyR: Bootstrap | null; strategyReturnPct: number; buyAndHoldReturnPct: number; maxDrawdownPct: number;
  /** Expectancy in R measured on this replay, in the form the validator accepts. Null until MIN_SAMPLE trades exist. */
  expectancyForValidator: { expectancyR: number; samples: number } | null; caveats: string[];
}

/** Aggregate a lower-timeframe series into buckets aligned to the epoch. Only fully populated buckets are returned. */
export function aggregate(rows: Kline[], bucketMs: number, baseMs: number): Kline[] {
  const per = Math.round(bucketMs / baseMs), out: Kline[] = [];
  let cur: Kline | null = null, count = 0, bucket = -1;
  for (const r of rows) {
    const b = Math.floor(r[0] / bucketMs) * bucketMs;
    if (b !== bucket) { if (cur && count === per) out.push(cur); bucket = b; cur = [b, r[1], r[2], r[3], r[4], r[5]]; count = 1; }
    else if (cur) { cur[2] = Math.max(cur[2], r[2]); cur[3] = Math.min(cur[3], r[3]); cur[4] = r[4]; cur[5] += r[5]; count++; }
  }
  if (cur && count === per) out.push(cur);
  return out;
}
/** Candles of a timeframe that have fully closed by `now`. Binary search on the open time; input must be ascending. */
export function closedWindow(rows: Kline[], tf: Timeframe, now: number, max: number): Kline[] {
  const ms = TF_SECONDS[tf] * 1000; let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] + ms <= now) lo = mid + 1; else hi = mid; }
  return rows.slice(Math.max(0, lo - max), lo);
}
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function bootstrapMeanR(trades: ClosedTrade[], samples = 2000, seed = 11): Bootstrap | null {
  const rs = trades.filter(t => t.riskAmount > 0).map(t => t.pnl / t.riskAmount);
  if (rs.length < MIN_SAMPLE) return null;
  const r = rng(seed), means: number[] = [];
  for (let i = 0; i < samples; i++) { let s = 0; for (let j = 0; j < rs.length; j++) s += rs[(r() * rs.length) | 0]; means.push(s / rs.length); }
  means.sort((a, b) => a - b);
  return { meanR: rs.reduce((a, b) => a + b, 0) / rs.length, low95: means[Math.floor(0.025 * samples)], high95: means[Math.floor(0.975 * samples) - 1], samples: rs.length };
}

export async function replay(history: History, cfg: ReplayConfig): Promise<ReplayResult> {
  const execTf = EXECUTION_TF[cfg.strategy], exec = history[execTf];
  if (!exec || exec.length < 200) throw new Error(`Replay needs at least 200 ${execTf} candles; received ${exec?.length ?? 0}`);
  for (const tf of TIMEFRAMES) { const r = history[tf]; if (r) for (let i = 1; i < r.length; i++) if (!(r[i][0] > r[i - 1][0])) throw new Error(`${tf} candles are not strictly ascending at index ${i}`); }
  const step = Math.max(1, cfg.stepBars ?? 4), win = cfg.windowCandles ?? 300, execMs = TF_SECONDS[execTf] * 1000, warm = cfg.warmupBars ?? 120;
  const store = new MemoryPaperStore();
  // Replay-local stand-in for the risk gateway: it approves, because the paper engine's own limits (position cap, daily loss,
  // loss streak, cooldown, sizing) still apply. The real gateway is NOT exercised here.
  const eng = await PaperEngine.create(store, async () => ({ approved: true, reasons: ["replay: simulated gateway approval"] }), { startingEquity: cfg.startingEquity ?? 10_000, ...cfg.paper }, exec[warm][0]);
  const decisions: Record<string, number> = {}, agreements: Record<string, number> = {}, rejections: Record<string, number> = {};
  let evaluations = 0; const fills: ReplayResult["fills"] = [];
  const tally = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  for (let i = warm; i < exec.length - 1; i++) {
    const bar = exec[i], now = bar[0] + execMs; // decision at the close of bar i
    // Manage any open position with bar i (the fill bar is processed below, so this only sees later bars).
    if (eng.state.positions.length) { await eng.onBar(cfg.symbol, { ts: now, high: bar[2], low: bar[3], close: bar[4] }); continue; }
    if ((i - warm) % step !== 0) continue;
    const candles: History = {};
    for (const tf of TIMEFRAMES) { const rows = history[tf]; if (rows) { const w = closedWindow(rows, tf, now, win); if (w.length) candles[tf] = w; } }
    evaluations++;
    const plan = runOmnisignal({ symbol: cfg.symbol, strategy: cfg.strategy, candles, now }, { enabledEngines: cfg.enabledEngines, weights: cfg.weights, thresholds: cfg.thresholds, maxCostR: cfg.maxCostR, roundTripCostBps: cfg.roundTripCostBps ?? ((cfg.paper?.feeRate ?? DEFAULT_PAPER_CONFIG.feeRate) * 2 * 1e4 + (cfg.paper?.slippageBps ?? DEFAULT_PAPER_CONFIG.slippageBps) * 2) });
    tally(decisions, plan.decision); tally(agreements, plan.fusion.agreement);
    if (plan.decision !== "BUY" && plan.decision !== "SELL") continue;
    const next = exec[i + 1], ev = await eng.open(plan, next[1], next[0]); // fill at the NEXT bar's open
    if (ev.type === "REJECTED") tally(rejections, (ev.reasons?.[0] ?? "unknown").replace(/[0-9.]+/g, "#"));
    else if (ev.type === "OPENED") { fills.push({ ts: next[0], marketPrice: next[1], signalBarClose: bar[4] }); await eng.onBar(cfg.symbol, { ts: next[0] + execMs, high: next[2], low: next[3], close: next[4] }); i++; } // the fill bar is processed now, stop-first
  }
  const openAtEnd = eng.state.positions.length;
  const trades = eng.state.closed, cut = exec[Math.floor(exec.length * (1 - (cfg.outOfSampleFraction ?? 0.3)))][0];
  const sIn = trades.filter(t => t.closedAt < cut), sOut = trades.filter(t => t.closedAt >= cut), start = cfg.startingEquity ?? 10_000;
  const report = computeReport(trades, start), eq = [start]; for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) eq.push(eq.at(-1)! + t.pnl);
  const valid = report.status === "ok" && report.expectancyR !== null;
  return {
    symbol: cfg.symbol, strategy: cfg.strategy, execTimeframe: execTf, bars: exec.length, evaluations, periodStart: exec[warm][0], periodEnd: exec.at(-1)![0] + execMs, decisions, agreements, paperRejections: rejections, openAtEnd, fills,
    trades, report, inSample: computeReport(sIn, start), outOfSample: computeReport(sOut, start), byEngine: reportsByEngine(trades, start),
    bootstrapExpectancyR: bootstrapMeanR(trades, cfg.bootstrapSamples, cfg.seed), strategyReturnPct: (eng.state.equity - start) / start * 100,
    buyAndHoldReturnPct: (exec.at(-1)![4] / exec[warm][4] - 1) * 100, maxDrawdownPct: report.maxDrawdownPct * 100,
    expectancyForValidator: valid ? { expectancyR: report.expectancyR!, samples: report.trades } : null,
    caveats: [
      "Historical replay is not a forecast and not evidence of future profit; results can overfit and depend on the period tested.",
      "No historical order-book data: liquidity checks are unavailable, so spread, depth and slippage beyond the configured flat bps are not modelled.",
      "Fills occur at the next bar's open with flat fee and slippage assumptions; funding, market impact and partial fills are not modelled.",
      "The risk gateway is replaced by a local approval stub; only the paper engine's own limits applied.",
      "Parameters are fixed defaults and were not optimised on this data; in-sample and out-of-sample splits are reported separately.",
      ...(report.status === "insufficient_sample" ? [`Only ${report.trades} closed trades (< ${MIN_SAMPLE}): rates, ratios and expectancy are withheld.`] : []),
    ],
  };
}

/** Strategy Competition Laboratory (first version): the same data and costs, each engine configuration side by side. */
export async function compareEngines(history: History, cfg: ReplayConfig) {
  const variants: Record<string, { swift: boolean; gainz: boolean }> = { swift_only: { swift: true, gainz: false }, gainz_only: { swift: false, gainz: true }, combined: { swift: true, gainz: true } };
  const out: Record<string, ReplayResult> = {};
  for (const [name, enabledEngines] of Object.entries(variants)) out[name] = await replay(history, { ...cfg, enabledEngines });
  return out;
}

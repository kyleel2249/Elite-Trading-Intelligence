// Performance intelligence: pure, deterministic metrics computed only from recorded trade outcomes.
// Nothing here estimates or invents results; with too few samples it reports "insufficient_sample" instead of a number.

export interface ClosedTrade {
  id: string; engine: "swift" | "gainz" | "combined" | "elite" | "validator"; symbol: string; timeframe?: string; regime?: string;
  openedAt: number; closedAt: number;
  /** Realised result after fees and slippage, in account currency. */
  pnl: number;
  /** Initial risk in account currency (entry-to-stop distance x size). Needed for R multiples. */
  riskAmount: number;
  fees: number; slippage: number;
  /** Heuristic score (0-100) the system showed at entry, used for calibration. */
  confidence?: number;
}

export const MIN_SAMPLE = 30;
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : NaN);
const std = (a: number[]) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)); };

/** Wilson score interval for a win rate; honest about uncertainty at small n. */
export function wilson(wins: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

export function maxDrawdown(equity: number[]): { maxDrawdown: number; maxDrawdownPct: number } {
  let peak = -Infinity, dd = 0, ddPct = 0;
  for (const e of equity) { peak = Math.max(peak, e); const d = peak - e; if (d > dd) dd = d; if (peak > 0 && d / peak > ddPct) ddPct = d / peak; }
  return { maxDrawdown: dd, maxDrawdownPct: ddPct };
}

export interface PerformanceReport {
  status: "ok" | "insufficient_sample"; trades: number; wins: number; losses: number; breakeven: number;
  winRate: number | null; winRateInterval95: { low: number; high: number } | null;
  netPnl: number; grossProfit: number; grossLoss: number; profitFactor: number | null;
  expectancy: number | null; expectancyR: number | null; avgWin: number | null; avgLoss: number | null; avgRewardRisk: number | null;
  maxDrawdown: number; maxDrawdownPct: number; recoveryFactor: number | null; sharpe: number | null; sortino: number | null;
  maxConsecutiveLosses: number; currentConsecutiveLosses: number; totalFees: number; totalSlippage: number; note: string;
}

export function computeReport(trades: ClosedTrade[], startingEquity = 10_000): PerformanceReport {
  const t = [...trades].sort((a, b) => a.closedAt - b.closedAt), n = t.length;
  const wins = t.filter(x => x.pnl > 0), losses = t.filter(x => x.pnl < 0);
  const gp = sum(wins.map(x => x.pnl)), gl = Math.abs(sum(losses.map(x => x.pnl)));
  const equity = [startingEquity]; for (const x of t) equity.push(equity.at(-1)! + x.pnl);
  const dd = maxDrawdown(equity), net = sum(t.map(x => x.pnl));
  const rs = t.filter(x => x.riskAmount > 0).map(x => x.pnl / x.riskAmount);
  // Per-trade returns on running equity, for Sharpe/Sortino (per-trade, not annualised: no assumption about trade frequency).
  const rets = t.map((x, i) => x.pnl / equity[i]);
  const dsd = Math.sqrt(sum(rets.map(r => Math.min(r, 0) ** 2)) / (rets.length || 1));
  let streak = 0, maxStreak = 0; for (const x of t) { streak = x.pnl < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const enough = n >= MIN_SAMPLE;
  return {
    status: enough ? "ok" : "insufficient_sample", trades: n, wins: wins.length, losses: losses.length, breakeven: n - wins.length - losses.length,
    winRate: enough ? wins.length / n : null, winRateInterval95: n ? wilson(wins.length, n) : null,
    netPnl: net, grossProfit: gp, grossLoss: gl, profitFactor: enough ? (gl > 0 ? gp / gl : gp > 0 ? Infinity : null) : null,
    expectancy: enough ? net / n : null, expectancyR: enough && rs.length ? mean(rs) : null,
    avgWin: wins.length ? gp / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    avgRewardRisk: wins.length && losses.length ? (gp / wins.length) / (gl / losses.length) : null,
    maxDrawdown: dd.maxDrawdown, maxDrawdownPct: dd.maxDrawdownPct, recoveryFactor: dd.maxDrawdown > 0 ? net / dd.maxDrawdown : null,
    sharpe: enough && std(rets) > 0 ? mean(rets) / std(rets) : null, sortino: enough && dsd > 0 ? mean(rets) / dsd : null,
    maxConsecutiveLosses: maxStreak, currentConsecutiveLosses: streak, totalFees: sum(t.map(x => x.fees)), totalSlippage: sum(t.map(x => x.slippage)),
    note: enough ? "Per-trade (non-annualised) ratios. Past results do not guarantee future results; intervals show sampling uncertainty." : `Fewer than ${MIN_SAMPLE} closed trades: rates and ratios are withheld rather than shown as reliable.`,
  };
}

export const WINDOWS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000, all: Infinity } as const;
export type WindowKey = keyof typeof WINDOWS;
export function windowedReports(trades: ClosedTrade[], now: number, startingEquity?: number): Record<WindowKey, PerformanceReport> {
  const out = {} as Record<WindowKey, PerformanceReport>;
  for (const k of Object.keys(WINDOWS) as WindowKey[]) out[k] = computeReport(trades.filter(x => now - x.closedAt <= WINDOWS[k]), startingEquity);
  return out;
}
export function reportsByEngine(trades: ClosedTrade[], startingEquity?: number) {
  const out: Record<string, PerformanceReport> = {};
  for (const e of new Set(trades.map(x => x.engine))) out[e] = computeReport(trades.filter(x => x.engine === e), startingEquity);
  return out;
}
export function reportsBy(trades: ClosedTrade[], key: "symbol" | "timeframe" | "regime", startingEquity?: number) {
  const out: Record<string, PerformanceReport> = {};
  for (const v of new Set(trades.map(x => x[key] ?? "unknown"))) out[String(v)] = computeReport(trades.filter(x => (x[key] ?? "unknown") === v), startingEquity);
  return out;
}

/** Calibration: does a shown confidence bucket match the realised win frequency? Buckets under 10 samples are not scored. */
export interface CalibrationBucket { range: [number, number]; trades: number; winRate: number | null; interval95: { low: number; high: number } | null; meanConfidence: number | null; gap: number | null }
export function calibration(trades: ClosedTrade[], edges = [0, 50, 60, 70, 80, 101]): { buckets: CalibrationBucket[]; calibrated: boolean; note: string } {
  const withC = trades.filter(x => typeof x.confidence === "number");
  const buckets = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1], inb = withC.filter(x => x.confidence! >= lo && x.confidence! < hi), w = inb.filter(x => x.pnl > 0).length, ok = inb.length >= 10;
    const wr = ok ? w / inb.length : null, mc = ok ? mean(inb.map(x => x.confidence!)) / 100 : null;
    return { range: [lo, hi] as [number, number], trades: inb.length, winRate: wr, interval95: inb.length ? wilson(w, inb.length) : null, meanConfidence: mc, gap: wr !== null && mc !== null ? wr - mc : null };
  });
  const scored = buckets.filter(b => b.gap !== null);
  const calibrated = scored.length >= 2 && scored.every(b => Math.abs(b.gap!) <= 0.1);
  return { buckets, calibrated, note: scored.length < 2 ? "Not enough outcomes per bucket to assess calibration. Confidence remains an uncalibrated evidence score." : calibrated ? "Bucket win rates are within 10 points of mean confidence on the recorded sample." : "Confidence does not match realised win rates; do not read it as a probability." };
}

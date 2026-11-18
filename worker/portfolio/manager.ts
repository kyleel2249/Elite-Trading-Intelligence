/**
 * ETI Portfolio Manager — deterministic, risk-first capital allocation advisory.
 *
 * This module is deliberately read-only: it never creates orders, changes leverage,
 * transfers funds, or contacts an exchange. Allocation weights are recommendations
 * derived from verified closed trades and the selected portfolio ledger.
 */
import type { ClosedTrade, Ledger } from "./ledger.ts";

export const MANAGED_STRATEGIES = ["scalp", "intraday", "swing", "position"] as const;
export type ManagedStrategy = typeof MANAGED_STRATEGIES[number];
export interface StrategyAllocation {
  strategy: ManagedStrategy; trades: number; wins: number; losses: number;
  winRate: number | null; profitFactor: number | null; expectancyUsd: number | null;
  netPnlUsd: number; maxDrawdownUsd: number; eligible: boolean; score: number;
  targetWeightPct: number; targetCapitalUsd: number; reasons: string[];
}
export interface PortfolioManagerConfig {
  minTrades: number; maxStrategyWeightPct: number; maxDeploymentPct: number;
  reservePct: number; maxPortfolioRiskPct: number; riskPerTradePct: number;
}
const DEFAULTS: PortfolioManagerConfig = {
  minTrades: 20, maxStrategyWeightPct: 35, maxDeploymentPct: 50,
  reservePct: 50, maxPortfolioRiskPct: 2, riskPerTradePct: 0.5,
};
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const strategyOf = (v: unknown): ManagedStrategy | null => MANAGED_STRATEGIES.includes(String(v).toLowerCase() as ManagedStrategy) ? String(v).toLowerCase() as ManagedStrategy : null;

function metrics(trades: ClosedTrade[], strategy: ManagedStrategy) {
  const allRows = trades.filter(t => strategyOf(t.strategy) === strategy).sort((a, b) => a.exitAt - b.exitAt).slice(-60);
  // Unknown exchange fees can make net expectancy look better than it was; exclude those trades from allocation qualification.
  const rows = allRows.filter(t => t.unknownFees === 0 && Number.isFinite(t.net));
  const wins = rows.filter(t => t.net > 0), losses = rows.filter(t => t.net < 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.net, 0);
  let equity = 0, peak = 0, maxDrawdownUsd = 0;
  for (const t of rows) { equity += t.net; peak = Math.max(peak, equity); maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity); }
  const netPnlUsd = rows.reduce((s, t) => s + t.net, 0);
  const expectancyUsd = rows.length ? netPnlUsd / rows.length : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 5 : null;
  const winRate = rows.length ? wins.length / rows.length : null;
  const eligible = rows.length >= 20 && expectancyUsd !== null && expectancyUsd > 0 && profitFactor !== null && profitFactor >= 1.15;
  const drawdownPenalty = netPnlUsd > 0 ? clamp(1 - maxDrawdownUsd / (netPnlUsd + maxDrawdownUsd || 1), 0.15, 1) : 0;
  const reliability = clamp(rows.length / 40, 0, 1);
  const score = eligible ? clamp((expectancyUsd! / Math.max(1, Math.abs(netPnlUsd) / rows.length)) * Math.log1p(profitFactor!) * reliability * drawdownPenalty, 0, 10) : 0;
  const reasons: string[] = [];
  if (rows.length < 20) reasons.push("insufficient_verified_trade_history");
  if (expectancyUsd !== null && expectancyUsd <= 0) reasons.push("non_positive_net_expectancy");
  if (profitFactor !== null && profitFactor < 1.15) reasons.push("profit_factor_below_1_15");
  if (allRows.some(t => t.unknownFees > 0)) reasons.push("trades_with_unknown_fees_excluded_from_sample");
  if (eligible) reasons.push("eligible_for_advisory_allocation_only");
  return { strategy, trades: rows.length, wins: wins.length, losses: losses.length, winRate, profitFactor, expectancyUsd, netPnlUsd, maxDrawdownUsd, eligible, score, reasons };
}

/** Capped proportional allocation. Unused capital remains in cash reserve; no leverage. */
function cappedWeights(scores: number[], cap: number, total: number): number[] {
  const out = scores.map(() => 0), active = scores.map((s, i) => s > 0 ? i : -1).filter(i => i >= 0);
  let remaining = Math.min(total, cap * active.length), pool = active.slice();
  while (pool.length && remaining > 1e-9) {
    const sum = pool.reduce((s, i) => s + scores[i], 0);
    if (!(sum > 0)) break;
    let capped = false;
    for (const i of pool.slice()) {
      const share = remaining * scores[i] / sum;
      if (share >= cap - out[i] - 1e-9) {
        const amount = cap - out[i]; out[i] += amount; remaining -= amount;
        pool = pool.filter(x => x !== i); capped = true; break;
      }
    }
    if (!capped) { for (const i of pool) out[i] += remaining * scores[i] / sum; remaining = 0; }
  }
  return out;
}

export function buildPortfolioManager(ledger: Ledger, now: number, overrides: Partial<PortfolioManagerConfig> = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const starting = finite(ledger.startingBalance), cash = finite(ledger.cash);
  const positions = Object.values(ledger.positions ?? {});
  let positionValue = 0, markStaleSymbols: string[] = [], openRiskUsd = 0, unknownStopSymbols: string[] = [];
  const venueExposure: Record<string, number> = {};
  for (const p of positions) {
    const mark = finite(ledger.marks?.[p.symbol]);
    if (mark === null || mark <= 0) markStaleSymbols.push(p.symbol);
    const value = p.qty * (mark && mark > 0 ? mark : p.avgEntry);
    positionValue += value;
    const venue = String(p.venue || "unattributed").toLowerCase();
    venueExposure[venue] = (venueExposure[venue] || 0) + value;
    const stop = finite(p.levels?.stop);
    if (stop === null || stop <= 0 || stop >= p.avgEntry) unknownStopSymbols.push(p.symbol);
    else openRiskUsd += Math.max(0, (p.avgEntry - stop) * p.qty);
  }
  const equity = cash !== null && starting !== null ? cash + positionValue : null;
  const riskPct = equity && equity > 0 ? openRiskUsd / equity * 100 : null;
  const exposurePct = equity && equity > 0 ? positionValue / equity * 100 : null;
  const strategyRows = MANAGED_STRATEGIES.map(s => metrics(ledger.closed ?? [], s));
  const weights = cappedWeights(strategyRows.map(s => s.score), cfg.maxStrategyWeightPct / 100, cfg.maxDeploymentPct / 100);
  const strategies: StrategyAllocation[] = strategyRows.map((s, i) => ({
    ...s, targetWeightPct: weights[i] * 100,
    targetCapitalUsd: equity === null ? 0 : equity * weights[i],
  }));
  const warnings: string[] = [];
  if (equity === null || !(equity > 0)) warnings.push("portfolio_equity_unavailable");
  if (markStaleSymbols.length) warnings.push("stale_or_missing_position_marks");
  if (unknownStopSymbols.length) warnings.push("open_positions_missing_valid_protective_stops");
  if (riskPct !== null && riskPct >= cfg.maxPortfolioRiskPct) warnings.push("portfolio_open_risk_limit_reached");
  if (exposurePct !== null && exposurePct >= cfg.maxDeploymentPct) warnings.push("portfolio_exposure_limit_reached");
  if (ledger.anomalies?.length) warnings.push("portfolio_ledger_contains_anomalies");
  const executionReady = equity !== null && equity > 0 && markStaleSymbols.length === 0 &&
    unknownStopSymbols.length === 0 && (riskPct ?? Infinity) < cfg.maxPortfolioRiskPct &&
    (exposurePct ?? Infinity) < cfg.maxDeploymentPct && !(ledger.anomalies?.length);
  const allocatedPct = strategies.reduce((s, x) => s + x.targetWeightPct, 0);
  return {
    schema: "eti.portfolio-manager/1", generatedAt: now, environment: ledger.environment,
    mode: "advisory_read_only", executionEnabled: false,
    config: cfg, account: {
      currency: ledger.currency, startingCapitalUsd: starting, cashUsd: cash,
      positionValueUsd: positionValue, equityUsd: equity, exposurePct,
      openRiskUsd, openRiskPct: riskPct, maxDeploymentPct: cfg.maxDeploymentPct,
      recommendedReservePct: Math.max(cfg.reservePct, 100 - allocatedPct),
      allocatedPct, unallocatedPct: Math.max(0, 100 - allocatedPct),
      openPositions: positions.length, closedTrades: ledger.closed.length,
    },
    strategies, venues: Object.entries(venueExposure).map(([venue, exposureUsd]) => ({
      venue, ledgerExposureUsd: exposureUsd,
      exposurePct: equity && equity > 0 ? exposureUsd / equity * 100 : null,
      scope: "selected_ledger_only",
    })).sort((a, b) => b.ledgerExposureUsd - a.ledgerExposureUsd),
    controls: { executionReady, liveOrdersAllowed: false, leverageAllowed: false, automaticReallocation: false, warnings, staleMarkSymbols: markStaleSymbols, missingStopSymbols: [...new Set(unknownStopSymbols)] },
    limitations: [
      "Allocations are recommendations only; this endpoint never submits, modifies or cancels orders.",
      "Venue exposure is derived only from fills recorded in the selected ETI ledger. External Bybit or Bitget balances and positions are not inferred.",
      "Exchange-specific account reconciliation must complete before a venue can be treated as a source of available capital.",
      "Strategies with fewer than 20 verified closed trades receive zero recommended allocation.",
    ],
  };
}

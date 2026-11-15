/**
 * Risk-policy gate for the KV paper engine (Step 6a of the autonomous-trading build).
 *
 * Pure function. Builds the risk engine's account state from the paper engine's own state and runs worker/risk/policy.ts:
 * 0.5% risk sizing, 50% notional cap, 50% cash reserve, net reward-to-risk of at least 1.5 after costs, daily-loss, drawdown
 * and consecutive-loss limits. The paper engine uses the returned quantity only if it is smaller than its legacy size.
 *
 * Limits of the paper state, stated plainly: it holds realized equity only (no mark-to-market of open positions), so the daily
 * loss and drawdown figures are realized-only, and peak equity is rebuilt from the closed-trade series.
 */
import { sizeTrade } from "./policy.ts";
import type { RiskPolicy } from "./policy.ts";

export interface PaperGateInput {
  policy: RiskPolicy;
  equity: number;
  dayStartEquity: number;
  startingEquity: number;
  positions: Array<{ remainingQty: number; entry: number }>;
  closed: Array<{ pnl: number }>;
  direction: 1 | -1;
  fill: number;
  stop: number;
  targets: Array<{ price: number; fraction: number }>;
  feeRate: number;
  /** Per-side slippage as a rate of price (bps / 10000). */
  slippageRate: number;
}

export type PaperGateResult = { ok: true; quantity: number; riskAmount: number; netRewardToRisk: number; binding: string } | { ok: false; reasons: string[] };

export function paperPolicyGate(i: PaperGateInput): PaperGateResult {
  const committed = i.positions.reduce((a, p) => a + p.remainingQty * p.entry, 0);
  let running = i.startingEquity, peak = running, streak = 0;
  for (const t of i.closed) { running += t.pnl; if (running > peak) peak = running; }
  for (let k = i.closed.length - 1; k >= 0 && i.closed[k].pnl < 0; k--) streak++;
  if (i.equity > peak) peak = i.equity;

  const weight = i.targets.reduce((a, t) => a + t.fraction, 0);
  const takeProfit = weight > 0 ? i.targets.reduce((a, t) => a + t.price * t.fraction, 0) / weight : NaN;

  const d = sizeTrade(
    {
      equity: i.equity, availableCash: Math.max(0, i.equity - committed), pendingCommitments: 0, dayBaselineEquity: i.dayStartEquity, dayPnl: i.equity - i.dayStartEquity,
      peakEquity: peak, consecutiveLosses: streak, openPositions: i.positions.length, walletReconciled: true, marketDataFresh: Number.isFinite(i.fill) && i.fill > 0, killSwitch: false, haltedForReview: false,
    },
    { side: i.direction > 0 ? "long" : "short", entry: i.fill, stop: i.stop, takeProfit, feeRate: i.feeRate, slippageRate: i.slippageRate, qtyStep: 1e-8, minQty: 0, minNotional: 0 },
    i.policy,
  );
  if (!d.approved) return { ok: false, reasons: d.rejections.map((r) => `Risk policy (${r.code}): ${r.detail}`) };
  return { ok: true, quantity: d.quantity, riskAmount: d.riskAmount, netRewardToRisk: d.netRewardToRisk, binding: d.bindingConstraint };
}

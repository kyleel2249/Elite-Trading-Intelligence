/**
 * ETI autonomous trading: wallet capital discovery and ledger/wallet reconciliation (pure functions, no I/O).
 *
 * Step 4 of the autonomous-trading build. Turns raw ledger figures into one capital snapshot and a reconciliation verdict.
 * Not wired into the cycle yet. Rules: fail closed (any missing or non-finite figure, any unpriced position, any
 * unresolved discrepancy means no new entries), and one snapshot never mixes environments or accounts.
 */
import { DEFAULT_POLICY, availableTradingCapital } from "./policy.ts";
import type { AccountState, RiskPolicy } from "./policy.ts";

export type Environment = "paper" | "testnet" | "live";

export interface PositionInput {
  symbol: string;
  /** Signed quantity: positive long, negative short. */
  qty: number;
  avgPrice: number;
  /** Latest verified mark price; null when no fresh price exists. */
  markPrice: number | null;
}

export interface LedgerInput {
  environment: Environment;
  accountId: string;
  /** Total cash in the ledger, including cash reserved for open orders. */
  cash: number;
  /** Cash reserved for resting orders. */
  reservedFunds: number;
  /** Cash promised to pending withdrawals or transfers. */
  pendingTransfers: number;
  positions: PositionInput[];
  realizedPnl: number;
  fees: number;
}

export interface CapitalSnapshot {
  /** False when the figures cannot be trusted; every dependent decision must then refuse new entries. */
  ok: boolean;
  reasons: string[];
  environment: Environment;
  accountId: string;
  equity: number;
  cash: number;
  /** Cash minus funds reserved for resting orders. */
  availableCash: number;
  reservedFunds: number;
  pendingTransfers: number;
  openExposure: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  minimumReserve: number;
  /** Available cash - mandatory reserve - pending commitments, never negative. */
  availableTradingCapital: number;
  /** Largest new position allowed by capital and the notional cap. */
  maxDeployment: number;
}

const fin = (...v: number[]) => v.every((x) => Number.isFinite(x));

export function buildCapitalSnapshot(l: LedgerInput, policy: RiskPolicy = DEFAULT_POLICY): CapitalSnapshot {
  const reasons: string[] = [];
  const blank = (): CapitalSnapshot => ({
    ok: false, reasons, environment: l.environment, accountId: l.accountId, equity: 0, cash: 0, availableCash: 0, reservedFunds: 0, pendingTransfers: 0,
    openExposure: 0, unrealizedPnl: 0, realizedPnl: 0, fees: 0, minimumReserve: 0, availableTradingCapital: 0, maxDeployment: 0,
  });
  if (!l || !/^[A-Za-z0-9_.\-]{1,64}$/.test(String(l.accountId ?? "")) || !(["paper", "testnet", "live"] as string[]).includes(l.environment)) {
    reasons.push("invalid_account_or_environment");
    return blank();
  }
  if (!fin(l.cash, l.reservedFunds, l.pendingTransfers, l.realizedPnl, l.fees)) { reasons.push("non_finite_ledger_figure"); return blank(); }
  if (l.cash < 0 || l.reservedFunds < 0 || l.pendingTransfers < 0) reasons.push("negative_cash_figure");
  if (l.reservedFunds > l.cash + 1e-9) reasons.push("reserved_exceeds_cash");

  let positionValue = 0, exposure = 0, unrealized = 0;
  for (const p of l.positions ?? []) {
    if (!fin(p.qty, p.avgPrice) || p.avgPrice < 0) { reasons.push(`bad_position:${p.symbol}`); continue; }
    if (p.qty === 0) continue;
    if (p.markPrice === null || !Number.isFinite(p.markPrice) || p.markPrice <= 0) { reasons.push(`unpriced_position:${p.symbol}`); continue; }
    positionValue += p.qty * p.markPrice;
    exposure += Math.abs(p.qty * p.markPrice);
    unrealized += p.qty * (p.markPrice - p.avgPrice);
  }
  const equity = l.cash + positionValue;
  if (!(equity > 0)) reasons.push("non_positive_equity");
  if (reasons.length) {
    const s = blank();
    return { ...s, cash: l.cash, equity: Number.isFinite(equity) ? equity : 0, reservedFunds: l.reservedFunds, pendingTransfers: l.pendingTransfers, realizedPnl: l.realizedPnl, fees: l.fees };
  }
  const availableCash = l.cash - l.reservedFunds;
  const atc = availableTradingCapital({ equity, availableCash, pendingCommitments: l.pendingTransfers }, policy);
  return {
    ok: true, reasons: [], environment: l.environment, accountId: l.accountId, equity, cash: l.cash, availableCash, reservedFunds: l.reservedFunds,
    pendingTransfers: l.pendingTransfers, openExposure: exposure, unrealizedPnl: unrealized, realizedPnl: l.realizedPnl, fees: l.fees,
    minimumReserve: equity * policy.minCashReserve, availableTradingCapital: atc, maxDeployment: Math.min(atc, equity * policy.maxPositionNotional),
  };
}

// ------------------------------------------------------------------ reconciliation

export interface WalletView {
  cash: number;
  /** Signed quantity by symbol as reported by the authoritative wallet or venue. */
  positions: Record<string, number>;
}

export type DiscrepancyCode = "cash_mismatch" | "quantity_mismatch" | "position_missing_in_wallet" | "position_missing_in_ledger" | "invalid_wallet_view";
export interface Discrepancy { code: DiscrepancyCode; symbol?: string; ledger?: number; wallet?: number }

/** Compare the wallet/venue view with the ledger. An empty list is the only successful outcome. */
export function reconcileLedger(l: Pick<LedgerInput, "cash" | "positions">, w: WalletView, cashTolerance = 0.01, qtyTolerance = 1e-9): Discrepancy[] {
  if (!w || !Number.isFinite(w.cash) || !w.positions || typeof w.positions !== "object" || Object.values(w.positions).some((q) => !Number.isFinite(q))) return [{ code: "invalid_wallet_view" }];
  const out: Discrepancy[] = [];
  if (!Number.isFinite(l.cash) || Math.abs(l.cash - w.cash) > cashTolerance) out.push({ code: "cash_mismatch", ledger: l.cash, wallet: w.cash });
  const ledgerQty = new Map<string, number>();
  for (const p of l.positions) if (p.qty !== 0) ledgerQty.set(p.symbol, (ledgerQty.get(p.symbol) ?? 0) + p.qty);
  const walletQty = new Map<string, number>(Object.entries(w.positions).filter(([, q]) => q !== 0));
  for (const [symbol, q] of ledgerQty) {
    const wq = walletQty.get(symbol);
    if (wq === undefined) out.push({ code: "position_missing_in_wallet", symbol, ledger: q, wallet: 0 });
    else if (Math.abs(q - wq) > qtyTolerance * Math.max(1, Math.abs(q))) out.push({ code: "quantity_mismatch", symbol, ledger: q, wallet: wq });
  }
  for (const [symbol, wq] of walletQty) if (!ledgerQty.has(symbol)) out.push({ code: "position_missing_in_ledger", symbol, ledger: 0, wallet: wq });
  return out;
}

/** Environments and accounts must never be mixed inside one calculation. Throws on a mix. */
export function assertSameScope(items: Array<{ environment: string; accountId: string }>): void {
  const first = items[0];
  if (!first) return;
  for (const i of items) {
    if (i.environment !== first.environment) throw new Error(`environment mix: ${first.environment} vs ${i.environment}`);
    if (i.accountId !== first.accountId) throw new Error(`account mix: ${first.accountId} vs ${i.accountId}`);
  }
}

export interface CycleContext {
  dayBaselineEquity: number;
  dayPnl: number;
  peakEquity: number;
  consecutiveLosses: number;
  marketDataFresh: boolean;
  killSwitch: boolean;
  haltedForReview: boolean;
  /** Result of reconcileLedger for this cycle (empty list = reconciled). */
  discrepancies: Discrepancy[];
}

/** Build the risk engine's account state. An untrusted snapshot or any discrepancy makes walletReconciled false. */
export function toAccountState(s: CapitalSnapshot, c: CycleContext, openPositions: number): AccountState {
  return {
    equity: s.equity, availableCash: s.availableCash, pendingCommitments: s.pendingTransfers, dayBaselineEquity: c.dayBaselineEquity, dayPnl: c.dayPnl,
    peakEquity: c.peakEquity, consecutiveLosses: c.consecutiveLosses, openPositions, walletReconciled: s.ok && c.discrepancies.length === 0,
    marketDataFresh: c.marketDataFresh, killSwitch: c.killSwitch, haltedForReview: c.haltedForReview,
  };
}

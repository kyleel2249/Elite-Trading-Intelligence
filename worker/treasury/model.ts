/**
 * Corporate treasury rules. Pure functions, no I/O.
 *
 * Two environments, never mixed: "actual" (real funds) and "simulated" (paper/test). Every account balance, ledger entry, hash chain,
 * policy and profit batch belongs to exactly one environment, and no operation takes both.
 *
 * Chart of accounts (balances in cents):
 *   1100 Trading capital            1200 Realized profits (reconciled net profit awaiting allocation)
 *   1300 Operating funds            1400 Emergency reserve          1500 Long-term investments
 *   1600 Department budgets (one balance per department)
 *   2100 Outstanding liabilities    3100 Owner capital              4100 Trading revenue
 *   5100 Operating expenses         5200 Trading losses
 * Realized profits (1200) can only be credited by recognising a profit batch that is recorded, settled and reconciled by three different
 * people. Allocations to operating funds, reserve, long-term investments and trading capital can only be drawn from 1200.
 * Operating funds (1300) are funded ONLY by profit allocation: owner contributions may fund trading capital, the emergency reserve and
 * long-term investments, but never operating funds, so operating expenses are only ever paid out of reconciled net profit.
 */
import { isGlobal, seesAll, type Actor } from "../company/model.ts";

export type Environment = "actual" | "simulated";
export const ENVIRONMENTS: readonly Environment[] = ["actual", "simulated"];
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export interface Account { code: string; key: string; name: string; type: AccountType; dimension: boolean }
export const ACCOUNTS: Account[] = [
  { code: "1100", key: "TRADING_CAPITAL", name: "Trading capital", type: "asset", dimension: false },
  { code: "1200", key: "REALIZED_PROFITS", name: "Realized profits", type: "asset", dimension: false },
  { code: "1300", key: "OPERATING_FUNDS", name: "Operating funds", type: "asset", dimension: false },
  { code: "1400", key: "EMERGENCY_RESERVE", name: "Emergency reserve", type: "asset", dimension: false },
  { code: "1500", key: "LONG_TERM_INVESTMENTS", name: "Long-term investments", type: "asset", dimension: false },
  { code: "1600", key: "DEPARTMENT_BUDGETS", name: "Department budgets", type: "asset", dimension: true },
  { code: "2100", key: "OUTSTANDING_LIABILITIES", name: "Outstanding liabilities", type: "liability", dimension: false },
  { code: "3100", key: "OWNER_CAPITAL", name: "Owner capital", type: "equity", dimension: false },
  { code: "4100", key: "TRADING_REVENUE", name: "Trading revenue", type: "income", dimension: false },
  { code: "5100", key: "OPERATING_EXPENSES", name: "Operating expenses", type: "expense", dimension: false },
  { code: "5200", key: "TRADING_LOSSES", name: "Trading losses", type: "expense", dimension: false },
];
export const accountOf = (code: string) => ACCOUNTS.find(a => a.code === code);
export const isDebitNormal = (t: AccountType) => t === "asset" || t === "expense";
/** Assets and liabilities may never go below zero; equity, income and expense accumulate. */
export const nonNegative = (t: AccountType) => t === "asset" || t === "liability";
export const signedDelta = (t: AccountType, debit: number, credit: number) => (isDebitNormal(t) ? debit - credit : credit - debit);

export interface Line { account: string; department: string; debit: number; credit: number }
const L = (account: string, debit: number, credit: number, department = "*"): Line => ({ account, department, debit, credit });
const MAX = 1_000_000_000_000;

export function validateLines(lines: Line[]): string | null {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 20) return "entry_needs_2_to_20_lines";
  let debit = 0, credit = 0;
  for (const l of lines) {
    const a = accountOf(l.account);
    if (!a) return "unknown_account";
    if (![l.debit, l.credit].every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX)) return "invalid_amount";
    if ((l.debit > 0) === (l.credit > 0)) return "line_needs_exactly_one_side";
    if (a.dimension ? !l.department || l.department === "*" : l.department !== "*") return "invalid_department_dimension";
    debit += l.debit; credit += l.credit;
  }
  if (debit !== credit) return "entry_not_balanced";
  return null;
}

// ---- entry builders (each returns balanced lines) ----
/** Owner contributions may fund these accounts. Operating funds (1300) are deliberately absent: they are funded only by profit allocation. */
export const CONTRIBUTION_ACCOUNTS = ["1100", "1400", "1500"] as const;
export const contributionLines = (account: string, cents: number): Line[] => [L(account, cents, 0), L("3100", 0, cents)];
export const profitRecognitionLines = (net: number): Line[] => [L("1200", net, 0), L("4100", 0, net)];
export const lossRecognitionLines = (loss: number): Line[] => [L("5200", loss, 0), L("1100", 0, loss)];
export const fundDepartmentLines = (dept: string, cents: number): Line[] => [L("1600", cents, 0, dept), L("1300", 0, cents)];
export const expensePaymentLines = (dept: string, cents: number): Line[] => [L("5100", cents, 0), L("1600", 0, cents, dept)];
export const liabilityIncurLines = (cents: number): Line[] => [L("5100", cents, 0), L("2100", 0, cents)];
export const liabilitySettleLines = (cents: number): Line[] => [L("2100", cents, 0), L("1300", 0, cents)];
export const allocationLines = (allocs: Allocation[]): Line[] => { const total = allocs.reduce((s, a) => s + a.cents, 0); return [...allocs.map(a => L(a.account, a.cents, 0)), L("1200", 0, total)]; };

/** Canonical text hashed into the chain. JSON keeps every field unambiguous. */
export function canonicalEntry(e: { prev: string; seq: number; environment: Environment; kind: string; at: number; actor: string; reference: string | null; period: string | null; memo: string; lines: Line[] }): string {
  return JSON.stringify([e.prev, e.seq, e.environment, e.kind, e.at, e.actor, e.reference ?? "", e.period ?? "", e.memo, e.lines.map(l => [l.account, l.department, l.debit, l.credit])]);
}

// ---- allocation policy ----
export interface Policy { minTradingCapitalCents: number; lossRecoveryBps: number; reserveTargetCents: number; reserveBps: number; liquidityMinCents: number; operatingBps: number; longTermBps: number; reinvestBps: number }
export interface Balances { tradingCapital: number; realizedProfits: number; operatingFunds: number; emergencyReserve: number; longTermInvestments: number; departmentBudgets: number; liabilities: number }
export interface Allocation { account: string; cents: number; reason: string }
export const POLICY_FIELDS: Array<keyof Policy> = ["minTradingCapitalCents", "lossRecoveryBps", "reserveTargetCents", "reserveBps", "liquidityMinCents", "operatingBps", "longTermBps", "reinvestBps"];

export function policyError(p: any): string | null {
  if (!p || typeof p !== "object") return "policy_required";
  for (const f of POLICY_FIELDS) { const v = p[f]; if (!Number.isSafeInteger(v) || v < 0 || v > MAX) return "invalid_" + f; }
  for (const f of ["lossRecoveryBps", "reserveBps", "operatingBps", "longTermBps", "reinvestBps"] as const) if (p[f] > 10000) return "invalid_" + f;
  if (p.operatingBps + p.longTermBps + p.reinvestBps !== 10000) return "split_must_total_10000_bps";
  return null;
}
const pct = (x: number, bps: number) => Number((BigInt(x) * BigInt(bps)) / 10000n);
/** Liquid funds: operating funds + emergency reserve + department budgets, less outstanding liabilities. */
export const liquidFunds = (b: Balances, reserveOverride?: number) => b.operatingFunds + (reserveOverride ?? b.emergencyReserve) + b.departmentBudgets - b.liabilities;

/**
 * Waterfall for a pool of reconciled net profit (default: the whole realized-profits balance). Everything is allocated; nothing is left over.
 *  1 minimum trading capital top-up (100% until the floor is met)
 *  2 loss recovery: loss_recovery_bps of what is left, capped at the unrecovered loss, back into trading capital
 *  3 emergency reserve: reserve_bps of what is left, capped at the gap to the reserve target
 *  4 liquidity requirement: operating funds are topped up until liquid funds reach the minimum
 *  5 remainder split by operating / long-term / reinvest bps; rounding dust goes to operating funds
 */
export function planAllocation(p: Policy, b: Balances, unrecoveredLoss: number, available: number = b.realizedProfits): { allocations: Allocation[]; totalCents: number; lossRecoveredCents: number } {
  const out: Allocation[] = [];
  let rem = Math.min(available, b.realizedProfits);
  const total = rem;
  const add = (account: string, cents: number, reason: string) => { const c = Math.min(cents, rem); if (c > 0) { out.push({ account, cents: c, reason }); rem -= c; } return c; };
  add("1100", Math.max(0, p.minTradingCapitalCents - b.tradingCapital), "minimum_trading_capital");
  const recovered = add("1100", Math.min(pct(rem, p.lossRecoveryBps), unrecoveredLoss), "loss_recovery");
  const reserveAdd = add("1400", Math.min(pct(rem, p.reserveBps), Math.max(0, p.reserveTargetCents - b.emergencyReserve)), "emergency_reserve");
  add("1300", Math.max(0, p.liquidityMinCents - liquidFunds(b, b.emergencyReserve + reserveAdd)), "liquidity_requirement");
  const op = pct(rem, p.operatingBps), lt = pct(rem, p.longTermBps), re = pct(rem, p.reinvestBps), dust = rem - op - lt - re;
  add("1300", op + dust, "operating_share"); add("1500", lt, "long_term_share"); add("1100", re, "reinvestment");
  return { allocations: out, totalCents: total - rem, lossRecoveredCents: recovered };
}

// ---- permissions (named users with a multi-factor session; the operator token can read but never moves money) ----
const execOrFinance = (a: Actor) => isGlobal(a, "executive") || isGlobal(a, "finance_approver");
export const canReadLedger = (a: Actor) => seesAll(a);
export const canRecordBatch = (a: Actor) => a.mfa && isGlobal(a, "accountant");
export const canSettleBatch = (a: Actor, recordedBy: string) => a.mfa && isGlobal(a, "finance_approver") && a.id !== recordedBy;
export const canReconcileBatch = (a: Actor, recordedBy: string, settledBy: string | null) => a.mfa && a.id !== recordedBy && a.id !== settledBy && (isGlobal(a, "executive") || isGlobal(a, "accountant"));
export const canRejectBatch = (a: Actor) => a.mfa && execOrFinance(a);
export const canProposePolicy = (a: Actor) => a.mfa && execOrFinance(a);
export const canApprovePolicy = (a: Actor, proposedBy: string) => a.mfa && a.id !== proposedBy && execOrFinance(a);
export const canAllocate = (a: Actor) => a.mfa && execOrFinance(a);
export const canContribute = (a: Actor) => a.mfa && isGlobal(a, "executive");
export const canFundDepartment = (a: Actor) => a.mfa && execOrFinance(a);
export const canPostExpense = (a: Actor, requestedBy: string) => a.mfa && isGlobal(a, "accountant") && a.id !== requestedBy;
export const canIncurLiability = (a: Actor) => a.mfa && isGlobal(a, "accountant");
export const canSettleLiability = (a: Actor) => a.mfa && execOrFinance(a);

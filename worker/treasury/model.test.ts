import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as T from "./model.ts";
import { SCHEMA, TRIGGERS } from "./schema.ts";
import type { Actor, Membership } from "../company/model.ts";

const actor = (id: string, memberships: Membership[], extra: Partial<Actor> = {}): Actor => ({ id, email: "", operator: false, mfa: true, memberships, ...extra });
const exec = actor("ex", [{ department: "*", role: "executive" }]);
const fin = actor("fi", [{ department: "*", role: "finance_approver" }]);
const acc = actor("ac", [{ department: "*", role: "accountant" }]);
const aud = actor("au", [{ department: "*", role: "auditor" }]);

const policy: T.Policy = { minTradingCapitalCents: 100_000, lossRecoveryBps: 5000, reserveTargetCents: 50_000, reserveBps: 2000, liquidityMinCents: 30_000, operatingBps: 5000, longTermBps: 2000, reinvestBps: 3000 };
const bal = (o: Partial<T.Balances> = {}): T.Balances => ({ tradingCapital: 200_000, realizedProfits: 100_000, operatingFunds: 0, emergencyReserve: 0, longTermInvestments: 0, departmentBudgets: 0, liabilities: 0, ...o });
const sum = (a: T.Allocation[], account?: string) => a.filter(x => !account || x.account === account).reduce((s, x) => s + x.cents, 0);

test("every entry builder yields a balanced, valid entry", () => {
  for (const lines of [T.contributionLines("1100", 500), T.profitRecognitionLines(700), T.lossRecognitionLines(300), T.fundDepartmentLines("trade", 900), T.expensePaymentLines("trade", 120), T.liabilityIncurLines(50), T.liabilitySettleLines(50)]) assert.equal(T.validateLines(lines), null);
  assert.equal(T.validateLines(T.allocationLines([{ account: "1300", cents: 60, reason: "x" }, { account: "1500", cents: 40, reason: "y" }])), null);
});

test("validateLines rejects unbalanced, one-sided, zero, float and mis-dimensioned entries", () => {
  assert.equal(T.validateLines([{ account: "1100", department: "*", debit: 10, credit: 0 }, { account: "3100", department: "*", debit: 0, credit: 9 }]), "entry_not_balanced");
  assert.equal(T.validateLines([{ account: "1100", department: "*", debit: 10, credit: 0 }]), "entry_needs_2_to_20_lines");
  assert.equal(T.validateLines([{ account: "1100", department: "*", debit: 0, credit: 0 }, { account: "3100", department: "*", debit: 0, credit: 0 }]), "line_needs_exactly_one_side");
  assert.equal(T.validateLines([{ account: "1100", department: "*", debit: 1.5, credit: 0 }, { account: "3100", department: "*", debit: 0, credit: 1.5 }]), "invalid_amount");
  assert.equal(T.validateLines([{ account: "9999", department: "*", debit: 1, credit: 0 }, { account: "3100", department: "*", debit: 0, credit: 1 }]), "unknown_account");
  assert.equal(T.validateLines([{ account: "1600", department: "*", debit: 1, credit: 0 }, { account: "1300", department: "*", debit: 0, credit: 1 }]), "invalid_department_dimension");
  assert.equal(T.validateLines([{ account: "1300", department: "trade", debit: 1, credit: 0 }, { account: "3100", department: "*", debit: 0, credit: 1 }]), "invalid_department_dimension");
});

test("signed balance deltas follow the normal side of each account type", () => {
  assert.equal(T.signedDelta("asset", 100, 0), 100);
  assert.equal(T.signedDelta("asset", 0, 40), -40);
  assert.equal(T.signedDelta("liability", 0, 70), 70);
  assert.equal(T.signedDelta("liability", 70, 0), -70);
  assert.equal(T.signedDelta("income", 0, 5), 5);
  assert.equal(T.signedDelta("expense", 5, 0), 5);
  assert.equal(T.nonNegative("asset"), true);
  assert.equal(T.nonNegative("equity"), false);
});

test("policy validation", () => {
  assert.equal(T.policyError(policy), null);
  assert.equal(T.policyError({ ...policy, reinvestBps: 2000 }), "split_must_total_10000_bps");
  assert.equal(T.policyError({ ...policy, lossRecoveryBps: 10001 }), "invalid_lossRecoveryBps");
  assert.equal(T.policyError({ ...policy, reserveTargetCents: -1 }), "invalid_reserveTargetCents");
  assert.equal(T.policyError({ ...policy, liquidityMinCents: 1.5 }), "invalid_liquidityMinCents");
  assert.equal(T.policyError(null), "policy_required");
});

test("allocation always distributes exactly the pool, with no negative or zero lines", () => {
  for (const pool of [1, 7, 99, 100_000, 123_457, 10_000_000]) for (const loss of [0, 500, 1_000_000]) {
    const r = T.planAllocation(policy, bal({ realizedProfits: pool }), loss);
    assert.equal(r.totalCents, pool);
    assert.equal(sum(r.allocations), pool);
    assert.ok(r.allocations.every(a => a.cents > 0));
    assert.ok(r.lossRecoveredCents <= loss);
  }
});

test("minimum trading capital is topped up first, ahead of everything else", () => {
  const r = T.planAllocation(policy, bal({ tradingCapital: 60_000, realizedProfits: 30_000 }), 0);
  assert.deepEqual(r.allocations, [{ account: "1100", cents: 30_000, reason: "minimum_trading_capital" }]);
});

test("loss recovery diverts a share of profit to trading capital and never exceeds the unrecovered loss", () => {
  const r = T.planAllocation({ ...policy, reserveBps: 0, liquidityMinCents: 0 }, bal({ realizedProfits: 100_000 }), 20_000);
  assert.equal(r.lossRecoveredCents, 20_000);
  const small = T.planAllocation({ ...policy, reserveBps: 0, liquidityMinCents: 0 }, bal({ realizedProfits: 100_000 }), 0);
  assert.equal(small.lossRecoveredCents, 0);
  const half = T.planAllocation({ ...policy, reserveBps: 0, liquidityMinCents: 0 }, bal({ realizedProfits: 100_000 }), 900_000);
  assert.equal(half.lossRecoveredCents, 50_000);
});

test("emergency reserve is funded up to its target only", () => {
  const p = { ...policy, lossRecoveryBps: 0, reserveBps: 10000, liquidityMinCents: 0 };
  const r = T.planAllocation(p, bal({ realizedProfits: 100_000, emergencyReserve: 20_000 }), 0);
  assert.equal(sum(r.allocations, "1400"), 30_000);
  const full = T.planAllocation(p, bal({ realizedProfits: 100_000, emergencyReserve: 50_000 }), 0);
  assert.equal(sum(full.allocations, "1400"), 0);
});

test("liquidity requirement tops up operating funds before long-term or reinvestment shares", () => {
  const p = { ...policy, lossRecoveryBps: 0, reserveBps: 0, operatingBps: 0, longTermBps: 10000, reinvestBps: 0, liquidityMinCents: 40_000 };
  const r = T.planAllocation(p, bal({ realizedProfits: 100_000, operatingFunds: 10_000, departmentBudgets: 5_000, liabilities: 3_000 }), 0);
  assert.equal(sum(r.allocations, "1300"), 28_000);
  assert.equal(sum(r.allocations, "1500"), 72_000);
  assert.equal(T.liquidFunds(bal({ operatingFunds: 10_000, departmentBudgets: 5_000, liabilities: 3_000 })), 12_000);
});

test("the remainder split follows the policy and rounding dust goes to operating funds", () => {
  const p = { ...policy, lossRecoveryBps: 0, reserveBps: 0, liquidityMinCents: 0, operatingBps: 3333, longTermBps: 3333, reinvestBps: 3334 };
  const r = T.planAllocation(p, bal({ realizedProfits: 101, tradingCapital: 1_000_000 }), 0);
  assert.equal(sum(r.allocations), 101);
  assert.equal(sum(r.allocations, "1500"), 33);
});

test("an empty profit pool allocates nothing", () => {
  const r = T.planAllocation(policy, bal({ realizedProfits: 0 }), 1000);
  assert.deepEqual(r.allocations, []);
  assert.equal(r.totalCents, 0);
});

test("the canonical hash input changes when anything in the entry changes", () => {
  const base = { prev: "GENESIS", seq: 1, environment: "actual" as const, kind: "contribution", at: 1, actor: "u", reference: "r", period: null, memo: "m", lines: T.contributionLines("1100", 5) };
  const text = T.canonicalEntry(base);
  assert.notEqual(text, T.canonicalEntry({ ...base, environment: "simulated" }));
  assert.notEqual(text, T.canonicalEntry({ ...base, lines: T.contributionLines("1100", 6) }));
  assert.notEqual(text, T.canonicalEntry({ ...base, prev: "x" }));
  assert.notEqual(text, T.canonicalEntry({ ...base, memo: "m2" }));
  assert.equal(text, T.canonicalEntry({ ...base }));
});

test("treasury permissions: segregation of duties and operator restrictions", () => {
  assert.equal(T.canRecordBatch(acc), true);
  assert.equal(T.canRecordBatch(fin), false);
  assert.equal(T.canSettleBatch(fin, "ac"), true);
  assert.equal(T.canSettleBatch(fin, "fi"), false);
  assert.equal(T.canSettleBatch(acc, "x"), false);
  assert.equal(T.canReconcileBatch(exec, "ac", "fi"), true);
  assert.equal(T.canReconcileBatch(exec, "ex", "fi"), false);
  assert.equal(T.canReconcileBatch(exec, "ac", "ex"), false);
  assert.equal(T.canReconcileBatch(acc, "ac", "fi"), false);
  assert.equal(T.canReconcileBatch(aud, "ac", "fi"), false);
  assert.equal(T.canApprovePolicy(exec, "fi"), true);
  assert.equal(T.canApprovePolicy(exec, "ex"), false);
  assert.equal(T.canAllocate({ ...exec, mfa: false }), false);
  assert.equal(T.canContribute(fin), false);
  assert.equal(T.canPostExpense(acc, "me"), true);
  assert.equal(T.canPostExpense(acc, "ac"), false);
  const op = actor("master", [], { operator: true, mfa: false });
  for (const f of [T.canRecordBatch, T.canProposePolicy, T.canAllocate, T.canContribute, T.canFundDepartment, T.canIncurLiability, T.canSettleLiability, T.canRejectBatch]) assert.equal(f(op), false);
  assert.equal(T.canReadLedger(op), true);
  assert.equal(T.canReadLedger(aud), true);
  assert.equal(T.canReadLedger(actor("m", [{ department: "trade", role: "member" }])), false);
});

test("the migration file and the embedded treasury schema stay identical", () => {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const file = squash(readFileSync(new URL("../../migrations/0010_treasury.sql", import.meta.url), "utf8").replace(/--[^\n]*\n/g, "\n"));
  for (const stmt of SCHEMA) assert.ok(file.includes(squash(stmt)), "missing from migration: " + stmt.slice(0, 70));
  assert.equal((file.match(/CREATE(UNIQUE)?(TABLE|INDEX)IFNOTEXISTS/g) || []).length, SCHEMA.filter(s => s.startsWith("CREATE")).length);
  assert.ok(!file.includes("TRIGGER"), "triggers are created at runtime, not in the migration");
  assert.equal(TRIGGERS.length, 4);
  for (const t of TRIGGERS) assert.match(t, /RAISE\(ABORT, 'ledger is immutable'\)/);
});

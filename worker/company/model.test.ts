import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "./model.ts";
import { SCHEMA } from "./schema.ts";

const actor = (id: string, memberships: M.Membership[], extra: Partial<M.Actor> = {}): M.Actor => ({ id, email: "", operator: false, mfa: true, memberships, ...extra });
const exec = actor("ex", [{ department: "*", role: "executive" }]);
const fin = actor("fi", [{ department: "*", role: "finance_approver" }]);
const acc = actor("ac", [{ department: "*", role: "accountant" }]);
const aud = actor("au", [{ department: "*", role: "auditor" }]);
const head = actor("he", [{ department: "trade", role: "department_head" }]);
const mem = actor("me", [{ department: "trade", role: "member" }]);

test("eleven departments are defined with unique codes", () => {
  assert.equal(M.DEPARTMENTS.length, 11);
  assert.equal(new Set(M.DEPARTMENTS.map(d => d.code)).size, 11);
  for (const d of M.DEPARTMENTS) assert.match(d.code, /^[A-Z]{2,8}$/);
});

test("expense approval follows role, limit, own-request and MFA rules", () => {
  const e = { department: "trade", amountCents: 100_000, requestedBy: "me" };
  assert.equal(M.canDecideExpense(head, e), true);
  assert.equal(M.canDecideExpense(head, { ...e, amountCents: 600_000 }), false);
  assert.equal(M.expenseDecisionBlock(head, { ...e, amountCents: 600_000 }), "above_approval_limit");
  assert.equal(M.canDecideExpense(fin, { ...e, amountCents: 5_000_000 }), true);
  assert.equal(M.canDecideExpense(fin, { ...e, amountCents: 5_000_001 }), false);
  assert.equal(M.canDecideExpense(exec, { ...e, amountCents: 900_000_000 }), true);
  assert.equal(M.expenseDecisionBlock(exec, { ...e, requestedBy: "ex" }), "cannot_decide_own_request");
  assert.equal(M.expenseDecisionBlock({ ...exec, mfa: false }, e), "mfa_required");
  assert.equal(M.expenseDecisionBlock(mem, { ...e, requestedBy: "other" }), "no_approval_authority"); // a member with no authority (not their own request)
  assert.equal(M.expenseDecisionBlock(aud, e), "no_approval_authority");
  assert.equal(M.canDecideExpense(actor("master", [], { operator: true, mfa: false }), e), false);
});

test("payment needs an accountant who neither requested nor approved", () => {
  const e = { requestedBy: "me", decidedBy: "ex" };
  assert.equal(M.canPay(acc, e), true);
  assert.equal(M.canPay(acc, { ...e, requestedBy: "ac" }), false);
  assert.equal(M.canPay(acc, { ...e, decidedBy: "ac" }), false);
  assert.equal(M.canPay(exec, e), false);
  assert.equal(M.canPay({ ...acc, mfa: false }, e), false);
});

test("budgets and revenue need a different second person", () => {
  assert.equal(M.canProposeBudget(head, "trade"), true);
  assert.equal(M.canProposeBudget(head, "risk"), false);
  assert.equal(M.canProposeBudget(mem, "trade"), false);
  assert.equal(M.canDecideBudget(fin, "he"), true);
  assert.equal(M.canDecideBudget(exec, "ex"), false);
  assert.equal(M.canDecideBudget(head, "ex"), false);
  assert.equal(M.canRecordRevenue(mem, "trade"), true);
  assert.equal(M.canRecordRevenue(mem, "risk"), false);
  assert.equal(M.canVerifyRevenue(acc, "me"), true);
  assert.equal(M.canVerifyRevenue(acc, "ac"), false);
  assert.equal(M.canVerifyRevenue(fin, "me"), false);
});

test("visibility: members see their department, company-wide roles and the operator see all", () => {
  assert.equal(M.canReadDept(mem, "trade"), true);
  assert.equal(M.canReadDept(mem, "risk"), false);
  assert.equal(M.canReadDept(aud, "risk"), true);
  assert.equal(M.canReadDept(actor("master", [], { operator: true }), "risk"), true);
  assert.equal(M.canViewAudit(mem, "trade"), false);
  assert.equal(M.canViewAudit(head, "trade"), true);
  assert.equal(M.canViewAudit(aud, "risk"), true);
  assert.equal(M.canManageCompany(exec), true);
  assert.equal(M.canManageCompany({ ...exec, mfa: false }), false);
  assert.equal(M.canManageCompany(actor("master", [], { operator: true, mfa: false })), true);
  assert.equal(M.canManageCompany(aud), false);
});

test("role scope and conflicts", () => {
  assert.equal(M.roleScopeOk("executive", "*"), true);
  assert.equal(M.roleScopeOk("executive", "trade"), false);
  assert.equal(M.roleScopeOk("member", "*"), false);
  assert.equal(M.roleScopeOk("member", "trade"), true);
  assert.equal(M.roleConflict(["accountant"], "finance_approver"), "approver_and_accountant_must_differ");
  assert.equal(M.roleConflict(["finance_approver"], "accountant"), "approver_and_accountant_must_differ");
  assert.equal(M.roleConflict(["member"], "auditor"), "auditor_must_be_independent");
  assert.equal(M.roleConflict(["auditor"], "member"), "auditor_must_be_independent");
  assert.equal(M.roleConflict(["auditor"], "auditor"), null);
  assert.equal(M.roleConflict(["member"], "department_head"), null);
});

test("periods, amounts and ids", () => {
  assert.equal(M.periodOf(Date.UTC(2026, 10, 15)), "2026-Q4");
  assert.equal(M.periodOf(Date.UTC(2026, 0, 1)), "2026-Q1");
  assert.equal(M.validPeriod("2026-Q4"), true);
  assert.equal(M.validPeriod("2026-Q5"), false);
  assert.equal(M.validPeriod("2026"), false);
  assert.equal(M.parseCents(1500), 1500);
  assert.equal(M.parseCents(0), null);
  assert.equal(M.parseCents(0, true), 0);
  assert.equal(M.parseCents(-5), null);
  assert.equal(M.parseCents(12.5), null);
  assert.equal(M.parseCents("100"), null);
  assert.equal(M.normalizeUserId(" Jane@Example.COM "), "jane@example.com");
  assert.equal(M.normalizeUserId("Abc_123"), "Abc_123");
  assert.equal(M.progressOf(5, 10), 0.5);
  assert.equal(M.progressOf(50, 10), 1);
  assert.equal(M.progressOf(5, 0), 0);
});

test("the migration file and the embedded schema stay identical", () => {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const file = squash(readFileSync(new URL("../../migrations/0009_company_management.sql", import.meta.url), "utf8").replace(/--[^\n]*\n/g, "\n"));
  for (const stmt of SCHEMA) assert.ok(file.includes(squash(stmt)), "missing from migration: " + stmt.slice(0, 60));
  assert.equal((file.match(/CREATE(TABLE|INDEX)IFNOTEXISTS/g) || []).length, SCHEMA.length);
});

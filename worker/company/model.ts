/**
 * Company management rules: departments, roles, permissions and segregation of duties. Pure functions, no I/O.
 *
 * Roles (stored in company_members; department '*' means company-wide):
 *   executive, finance_approver, accountant, auditor   company-wide
 *   department_head, member                            one department each
 * Segregation of duties (enforced here and again inside the SQL of every state change):
 *   - nobody approves or pays their own request; the person who paid cannot be the person who approved
 *   - budgets and revenue are decided/verified by someone other than the person who proposed/recorded them
 *   - finance_approver and accountant cannot be held by the same user; auditors hold no other role (read-only)
 *   - approvals, payments and administration by named users need a multi-factor session
 *   - the break-glass operator token can administer (departments, members) but never approves or pays
 * Payment here is a bookkeeping record of settlement; this module never moves funds.
 */
export const ROLES = ["executive", "department_head", "finance_approver", "accountant", "auditor", "member"] as const;
export type CompanyRole = typeof ROLES[number];
export const GLOBAL_ROLES: readonly CompanyRole[] = ["executive", "finance_approver", "accountant", "auditor"];
export const COMPANY_WIDE = "*";
export interface Membership { department: string; role: CompanyRole }
export interface Actor { id: string; email: string; operator: boolean; mfa: boolean; memberships: Membership[] }
export interface Limits { headCents: number; financeCents: number }
/** Default approval ceilings: department heads up to $5,000, finance approvers up to $50,000, executives unlimited. */
export const DEFAULT_LIMITS: Limits = { headCents: 500_000, financeCents: 5_000_000 };
export const EXPENSE_CATEGORIES = ["infrastructure", "software", "data_feeds", "compliance", "legal", "professional_services", "payroll", "marketing", "research", "other"] as const;

export interface DepartmentSeed { code: string; name: string; mission: string }
export const DEPARTMENTS: DepartmentSeed[] = [
  { code: "EXEC", name: "Executive Management", mission: "Sets company strategy, approves budgets and policy, and is accountable for overall results." },
  { code: "TRADE", name: "Trading and Investments", mission: "Runs the trading and investment strategies within approved risk limits and attributes the revenue they produce." },
  { code: "TREAS", name: "Treasury and Finance", mission: "Manages cash, reserves, funding of operations and financial planning." },
  { code: "CHAIN", name: "Blockchain and Digital Assets", mission: "Operates digital-asset infrastructure, custody procedures and on-chain activity." },
  { code: "RISK", name: "Risk Management", mission: "Defines and monitors risk limits, exposures and control breaches." },
  { code: "RES", name: "Research and Intelligence", mission: "Produces market, sports and macro research that feeds the trading and investment decisions." },
  { code: "TECH", name: "Technology and Engineering", mission: "Builds, secures and operates the ETI platform." },
  { code: "OPS", name: "Operations and Administration", mission: "Runs day-to-day operations, vendors and administration." },
  { code: "ACCT", name: "Accounting and Audit", mission: "Keeps the books, verifies revenue, records payments and supports audit." },
  { code: "HR", name: "Human Resources", mission: "Handles hiring, roles, access reviews and people policies." },
  { code: "BIZ", name: "Business Development", mission: "Develops partnerships, products and new revenue." },
];

const has = (a: Actor, role: CompanyRole, dept: string = COMPANY_WIDE) => a.memberships.some(m => m.role === role && m.department === dept);
export const isGlobal = (a: Actor, role: CompanyRole) => has(a, role, COMPANY_WIDE);
export const isHead = (a: Actor, dept: string) => has(a, "department_head", dept);
export const inDept = (a: Actor, dept: string) => a.memberships.some(m => m.department === dept && (m.role === "department_head" || m.role === "member"));
export const seesAll = (a: Actor) => a.operator || a.memberships.some(m => m.department === COMPANY_WIDE);
export const canReadDept = (a: Actor, dept: string) => seesAll(a) || a.memberships.some(m => m.department === dept);
/** Departments, members and role assignment: the operator token, or an executive with a multi-factor session. */
export const canManageCompany = (a: Actor) => a.operator || (a.mfa && isGlobal(a, "executive"));
export const canProposeBudget = (a: Actor, dept: string) => isGlobal(a, "executive") || isHead(a, dept);
export const canDecideBudget = (a: Actor, proposedBy: string) => a.mfa && a.id !== proposedBy && (isGlobal(a, "executive") || isGlobal(a, "finance_approver"));
export const canSubmitExpense = (a: Actor, dept: string) => inDept(a, dept);
export function expenseDecisionBlock(a: Actor, e: { department: string; amountCents: number; requestedBy: string }, l: Limits = DEFAULT_LIMITS): string | null {
  if (!a.mfa) return "mfa_required";
  if (a.id === e.requestedBy) return "cannot_decide_own_request";
  if (isGlobal(a, "executive")) return null;
  if (isGlobal(a, "finance_approver")) return e.amountCents <= l.financeCents ? null : "above_approval_limit";
  if (isHead(a, e.department)) return e.amountCents <= l.headCents ? null : "above_approval_limit";
  return "no_approval_authority";
}
export const canDecideExpense = (a: Actor, e: { department: string; amountCents: number; requestedBy: string }, l: Limits = DEFAULT_LIMITS) => expenseDecisionBlock(a, e, l) === null;
export const canPay = (a: Actor, e: { requestedBy: string; decidedBy: string | null }) => a.mfa && isGlobal(a, "accountant") && a.id !== e.requestedBy && a.id !== e.decidedBy;
export const canRecordRevenue = (a: Actor, dept: string) => inDept(a, dept) || isGlobal(a, "accountant");
export const canVerifyRevenue = (a: Actor, recordedBy: string) => a.mfa && isGlobal(a, "accountant") && a.id !== recordedBy;
export const canManageObjectives = (a: Actor, dept: string) => isGlobal(a, "executive") || isHead(a, dept);
export const canRecordMetric = (a: Actor, dept: string) => inDept(a, dept);
export const canViewAudit = (a: Actor, dept: string) => a.operator || isGlobal(a, "executive") || isGlobal(a, "auditor") || isGlobal(a, "accountant") || isHead(a, dept);

/** Role scope: company-wide roles need '*', department roles need a real department. */
export const roleScopeOk = (role: CompanyRole, dept: string) => GLOBAL_ROLES.includes(role) ? dept === COMPANY_WIDE : dept !== COMPANY_WIDE;
/** Returns a conflict code if a user holding `existing` roles may not also take `next`. */
export function roleConflict(existing: CompanyRole[], next: CompanyRole): string | null {
  if (next === "auditor" ? existing.some(r => r !== "auditor") : existing.includes("auditor")) return "auditor_must_be_independent";
  if ((next === "finance_approver" && existing.includes("accountant")) || (next === "accountant" && existing.includes("finance_approver"))) return "approver_and_accountant_must_differ";
  return null;
}

export const periodOf = (t: number) => { const d = new Date(t); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
export const validPeriod = (p: unknown): p is string => typeof p === "string" && /^\d{4}-Q[1-4]$/.test(p);
/** Whole cents only: no floats, no negatives, bounded. */
export const parseCents = (v: unknown, allowZero = false): number | null => typeof v === "number" && Number.isSafeInteger(v) && (allowZero ? v >= 0 : v > 0) && v <= 1_000_000_000_000 ? v : null;
export const normalizeUserId = (s: string) => { const t = s.trim(); return t.includes("@") ? t.toLowerCase() : t; };
export const progressOf = (current: number, target: number) => target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;

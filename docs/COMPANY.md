# ETI company management (`/api/company/*`)

Phase 1 of running ETI as a structured company: departments, roles, budgets, expenses, revenue attribution, objectives, metrics, an audit log and reports.
Everything is stored in the `ETI_PORTFOLIO_DB` D1 database (migration `0009_company_management.sql`; the API also creates the tables on first use).
Amounts are integer cents. These are internal management records, not audited financial statements.

Not part of this phase: treasury accounts and reserves, blockchain wallets, automatic allocation of trading profit, payroll, and a web dashboard. This module never moves funds; "pay" only records that a payment was made.

## Getting started
1. Call `POST /api/company/bootstrap` once with the operator token. It creates the 11 departments (EXEC, TRADE, TREAS, CHAIN, RISK, RES, TECH, OPS, ACCT, HR, BIZ).
2. As operator, assign people with `POST /api/company/members` (`userId` is an ETI account id or email, `role`, `departmentId` for department roles). Start with at least one `executive`, one `finance_approver` and one `accountant` held by different people.
3. Heads propose budgets, finance approvers/executives approve them, members submit expenses, and so on (below).

## Roles
| Role | Scope | Can |
| --- | --- | --- |
| `executive` | company | manage departments/members, propose and approve budgets, approve any expense, manage objectives |
| `finance_approver` | company | approve budgets, approve expenses up to $50,000 |
| `accountant` | company | verify revenue, record payments, read everything, record revenue |
| `auditor` | company | read everything incl. audit log; no write access; may hold no other role |
| `department_head` | department | propose the department budget, approve its expenses up to $5,000, manage its objectives, see its audit log |
| `member` | department | submit expenses, record revenue and metrics, update objective progress |

The approval ceilings ($5,000 head, $50,000 finance approver) are defaults set in `worker/company/model.ts` (`DEFAULT_LIMITS`). Change them there to match your policy.

## Segregation of duties
- Nobody approves or pays their own request; whoever approved an expense cannot also record its payment.
- A budget is approved by someone other than its proposer; revenue is verified by an accountant other than the one who recorded it.
- `finance_approver` and `accountant` cannot be held by the same user; `auditor` must hold no other role.
- Approvals, payments and role changes by named users need an MFA session. The operator token can administer (`bootstrap`, departments, members) but cannot approve or pay.
- Approval re-checks budget, status and the rules inside the SQL statement, so two simultaneous approvals cannot overspend a budget.

## Endpoints
`GET /me`, `POST /bootstrap`, `GET|POST /departments`, `GET|PATCH /departments/<id|code>`, `GET|POST /members`, `POST /members/<id>/deactivate`,
`GET|POST /budgets`, `POST /budgets/<id>/decision`, `GET|POST /expenses`, `POST /expenses/<id>/decision|pay|cancel`,
`GET|POST /revenue`, `POST /revenue/<id>/verify`, `GET|POST /objectives`, `PATCH /objectives/<id>`, `GET|POST /metrics`, `GET /activity`,
`GET /reports/company?period=2026-Q4[&format=csv]`, `GET /reports/departments/<id|code>?period=2026-Q4`.

Periods are calendar quarters (`YYYY-Qn`). Available budget = approved allocations minus approved and paid expenses for the period. The activity log is append-only: there is no edit or delete route.

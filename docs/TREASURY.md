# ETI Corporate Treasury

The treasury keeps the company's money in separate, auditable buckets on an immutable double-entry ledger. It records and controls money; it does **not** move funds or connect to a bank, broker or exchange. Figures are management records, not audited financial statements.

- Dashboard: `/treasury` (same-origin page; sign in at `/account` first)
- API: `/api/treasury/*` (served by `worker/treasury/api.ts`, mounted in `worker/main.ts`)
- Rules and ledger maths: `worker/treasury/model.ts` (pure functions); storage: `worker/treasury/schema.ts` and `migrations/0010_treasury.sql`
- People, roles, departments and approved budgets come from the company module (see `docs/COMPANY.md`)

## Two environments that never mix

Every balance, ledger entry, hash chain, allocation policy and profit batch belongs to exactly one environment:

| Environment | Meaning |
|---|---|
| `actual` | Real funds. Entries record money that has really moved at a bank, exchange or custodian, and must cite an external reference. |
| `simulated` | Paper, testnet and test balances. Never real money. |

Rules that keep them apart:

1. Every request must name `environment`; there is no default, and no operation accepts both.
2. `GET /api/treasury/balances` without an environment returns the two sets side by side and says they are never added together.
3. A profit batch whose source or description names paper, testnet, sandbox, demo, mock, simulated or back-test trading is refused in `actual` (`worker/treasury/guards.ts`). Record it in `simulated`.
4. Company expenses can be posted to the ledger in `actual` only.
5. Simulated activity has its own hash chain and its own policy. Nothing can be moved from one environment to the other.

## The seven balances (plus supporting accounts)

| Code | Account | Purpose |
|---|---|---|
| 1100 | Trading capital | Capital available to trade. |
| 1200 | Realized profits | Reconciled net profit awaiting allocation. |
| 1300 | Operating funds | Pays operating expenses. Funded only by profit allocation. |
| 1400 | Emergency reserve | Reserve fund. |
| 1500 | Long-term investments | Long-term holdings. |
| 1600 | Department budgets | One balance per company department. |
| 2100 | Outstanding liabilities | Amounts owed. |
| 3100 / 4100 / 5100 / 5200 | Owner capital, trading revenue, operating expenses, trading losses | Supporting accounts that keep every entry balanced. |

Assets and liabilities can never go below zero. The database rejects any posting that would do so.

## Only reconciled net profit reaches operating expenses

1. **Record**: an accountant records a profit batch (source, period, gross profit or loss, fees). Net is gross minus fees.
2. **Settle**: a *different* finance approver confirms the funds have settled and cites the exchange, bank or custody record.
3. **Reconcile**: a *third* person (executive or accountant) reconciles it against a statement. The statement figure must equal the recorded net exactly. Only then is the entry posted: profit goes to Realized profits (1200); a loss reduces Trading capital and increases the unrecovered-loss balance.
4. **Allocate**: an executive or finance approver runs the allocation. It can only spend what is in Realized profits.
5. **Spend**: operating funds can be moved to department budgets (limited, in `actual`, to the approved company budget for the period), and paid company expenses are posted against the department budget.

Owner contributions may fund trading capital, the emergency reserve and long-term investments, but **never operating funds**, so operating money always traces back to reconciled profit.

Every step needs a named account with multi-factor authentication. The operator token can read the ledger but can never move money.

## Allocation policy

A policy is proposed by one person and approved by a different one. Only one is active per environment. It sets:

| Setting | Effect |
|---|---|
| Minimum trading capital | Trading capital is topped up to this floor first. |
| Loss recovery % | Share of profit returned to trading capital until the unrecovered loss is cleared. |
| Emergency reserve target and reserve % | Reserve is funded, at that share of profit, until the target is met. |
| Minimum liquidity | Operating funds are topped up until liquid funds (operating + reserve + department budgets - liabilities) reach this level. |
| Operating / long-term / reinvest % | How the remainder is split (must total 100%). Rounding dust goes to operating funds. |

The waterfall runs in this order: minimum trading capital, loss recovery, emergency reserve, liquidity requirement, then the split. The whole pool is always allocated, with no negative or zero lines. `GET /allocations/plan` previews it without posting.

## Immutable double-entry ledger

- Every entry has two or more lines whose debits equal credits, in integer cents.
- Entries are hash-chained: each stores the previous entry's hash, and the hash covers every field and line.
- Database triggers refuse any update or delete of entries and lines, and database checks refuse negative balances, a forked chain and double posting.
- Each state change is one atomic batch: the entry, its lines, the balance updates and the status change commit together or not at all.
- There is no edit or delete route. A mistake is corrected with a new entry.
- `GET /verify` recomputes every hash and balance from the lines and reports any difference, plus whether the immutability triggers are present. The dashboard has a button for it.

## API summary

All calls name `environment` (query string for GET, body for POST).

| Call | Who | What |
|---|---|---|
| `GET /accounts`, `/balances`, `/report`, `/ledger`, `/verify` | ledger readers (executive, finance, accountant, auditor, operator) | Chart, balances, requirements report, ledger, integrity check. |
| `GET/POST /policy`, `POST /policy/<id>/decision` | executive or finance approver | Propose, then another person approves or rejects. |
| `GET/POST /profit-batches`, `POST /profit-batches/<id>/settle \| reconcile \| reject` | accountant / finance approver / executive | The record, settle, reconcile flow. |
| `GET /allocations/plan`, `POST /allocations` | executive or finance approver | Preview and run the allocation. |
| `POST /contributions` | executive | Owner capital into 1100, 1400 or 1500. |
| `POST /department-funding` | executive or finance approver | Operating funds to a department budget. |
| `POST /expenses/<id>/post` | accountant (not the requester) | Post a paid company expense (actual only). |
| `POST /liabilities`, `POST /liabilities/settle` | accountant / executive or finance approver | Incur and settle liabilities (settled from operating funds). |

Amounts are integer cents (`amountCents`, `grossCents`, `feesCents`, `statementNetCents`). The dashboard converts from decimals for you.

## Setup

1. Apply migration `0010_treasury.sql` (the Worker also creates the same tables on first use). The company tables from `0009` are required.
2. Give people roles in company management (executive, finance_approver, accountant, auditor). They need named ETI accounts with multi-factor authentication enabled.
3. In each environment, propose and approve an allocation policy.
4. Open `/treasury`, choose the environment and work through record, settle, reconcile, allocate.

No new secrets or environment variables are needed: access uses the existing ETI account sessions, `ETI_PORTFOLIO_DB` and `ETI_EXECUTION_LOG`.

## Limits and honest caveats

- It records money movements made elsewhere. Moving real funds, bank connections and custody are out of scope.
- A loss larger than the recorded trading capital cannot be reconciled until capital is contributed; the ledger cannot go negative.
- Concurrent writers retry a few times, then return `ledger_busy_retry`. Loss recovery cannot be applied twice beyond the unrecovered loss.
- The simulated-source check is a keyword safety net. The settlement and reconciliation steps, with their external references, are the real control.
- Management records only; have an accountant review before relying on them for tax or statutory reporting.

## Tests

`worker/treasury/model.test.ts` covers the ledger rules, allocation waterfall, permissions and schema parity. `worker/treasury/ui.test.ts` covers the page, the actual-environment source guard and the contribution rule. Both run with `npm test`.

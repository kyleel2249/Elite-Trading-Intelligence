# Financial accounting (double-entry engine)

`app/accounting/` is a double-entry ledger. Every financial event becomes one balanced journal entry; every report is
derived from the journal, so nothing is stored twice and nothing can drift.

## Guarantees
- **Balanced:** each entry balances per currency (debits = credits) or it is rejected. Amounts are integers in 1e-8 units (`money.py`); floats never reach the ledger.
- **Immutable:** `acct_entries`, `acct_lines`, `acct_periods`, `acct_recon_runs` have database triggers (SQLite + PostgreSQL) that reject UPDATE/DELETE. Corrections are compensating reversal entries (`POST /entries/{id}/reverse`).
- **Hash chain:** each entry stores `sha256(prev_hash | content digest | created_at)`; `GET /integrity` detects edits or deletions.
- **No duplicates:** `(source, source_id)` is a unique idempotency key. Re-posting identical content returns the original entry (`duplicate: true`); different content under the same key is a 409. A bank / exchange / on-chain reference can be booked only once per account unless the earlier entry was reversed.
- **Periods:** `POST /periods/close` blocks further postings into a month. `POST /periods/close-year` moves each environment's net income to Retained Earnings (excluded from the income statement so performance is not distorted).

## Honesty rules
- Every entry has an `environment`: `internal` and `live` are the real books; `paper` and `testnet` are simulated. Statements default to `scope=real`. Simulated results are never mixed into real statements and are labelled as simulated in the trading P&L.
- Fees are not invented. `sync/orders` books realized P&L from the `orders` table with fees = 0 (that table has no fee column); supply fees through `events/trade`.
- External transactions are stored exactly as reported. Missing ones are booked only on explicit request (`confirm: true`) and always to Suspense (1990), never guessed as revenue or capital.
- Reports are per currency (default `USD`); there is no FX conversion, and `currencies_present` shows what else exists.
- ETI does not fetch blockchain data itself: import transactions from your explorer or node via `reconcile/ingest`. Chain transactions below `min_confirmations` are reported as pending, not booked.

## What exists
| Need | Where |
|---|---|
| Chart of accounts | `GET/POST /api/accounting/accounts` (26 default accounts, departments list) |
| General ledger | `GET /reports/general-ledger?account=` (running balance, CSV) |
| Journal | `POST /entries` (manual), `POST /events/{capital,distribution,expense,internal-transfer,trade,funding}` |
| Accounts payable / receivable | `POST /bills`, `/invoices`, `/bills/pay`, `/invoices/receive`, `GET /aging/{payable,receivable}` (aging buckets, tie-out to the GL control account) |
| Income statement, balance sheet, cash flow (direct method) | `GET /reports/income-statement`, `/balance-sheet`, `/cash-flow` |
| Departmental expenses | `GET /reports/departments` (by department, account and month) |
| Trading P&L | `GET /reports/trading-pnl` (per environment, symbol, strategy; win rate, profit factor, expectancy after fees) |
| Treasury reconciliation | `POST /reconcile/balance` (statement balance vs ledger) |
| Bank / exchange / blockchain reconciliation | `POST /reconcile/ingest`, `/reconcile/transactions`, `/reconcile/post-missing`; classes: matched, amount_mismatch (with double-post hint), missing_internal, missing_external, pending_confirmation |
| Monthly / annual reports | `GET /reports/monthly?period=YYYY-MM`, `/reports/annual?year=` (all statements, aging, trial balance, integrity) |

All routes require `X-API-Key` (same as other protected APIs). Schema: migration `0012_accounting`.

## Not done / limits
- No multi-currency revaluation, tax computation or payroll.
- Open trading positions are not marked to market in the ledger; only realized P&L is booked.
- The paper engine's own closed trades are not auto-synced yet (use `events/trade` or the `orders` sync).
- Overpayment protection uses an in-process lock; run a single API worker or add a database lock before scaling out.

# Automatic profit management

Dashboard: `/profit`. API: `/api/profit/*`. Code: `worker/profit/`. Migration: `migrations/0013_profit_engine.sql`.

## What it does
1. **Calculates realized net profit** from the Trade Journal: closed trades only, gross minus fees and commissions, in cents.
2. **Counts losses and costs**: a net loss is charged to trading capital (account 5200 / 1100) and added to *unrecovered loss*, which profit must repay (policy `lossRecoveryBps`) before it is distributed.
3. **Calculates distributable profit**: the realized-profit pool (account 1200) after confirmed results are recognised. Nothing else can be allocated.
4. **Recommends allocations** using the treasury's approved policy waterfall (`planAllocation`), or routes everything to trading capital while capital protection holds distributions.
5. **Updates internal balances** through the treasury's own hash-chained, double-entry, guarded ledger path (same code as the treasury API).
6. **Enforces capital protection**: realized-drawdown limit, minimum trading capital, emergency reserve, liquidity minimum, unrecovered losses, and the existence of an approved policy.
7. **Forecasts company expenses** from paid expenses (trend, low/base/high range), approved budgets and liabilities, with runway.
8. **Reports**: `GET /api/profit/report?environment=&period=YYYY-Qn|YYYY-MM|all&format=json|md|csv` (totals, by strategy and symbol, equity curve, allocations, balances, protection, forecast, exclusions).

## Never allocated
Unrealized gains, open or partially filled positions, resting orders, broker outcomes that are unknown, trades with unreported fees, hand-entered trades, trades closed less than `ETI_PROFIT_CONFIRM_MINUTES` ago, sports-betting paper results, and trades with an unrecognised environment. Each is listed on the dashboard with its reason.

## Which books are automatic
| Journal environment | Treasury books | Automatic posting |
|---|---|---|
| `internal_paper`, `exchange_testnet` | simulated | Yes: recognised and allocated by the engine as `system:profit-engine` |
| `live` | actual | **No.** Recommendations only. Real funds need the treasury's three-person profit-batch workflow, because ETI places no live orders and cannot confirm live settlement itself |

The engine never moves funds, never places orders and never mixes simulated with actual books. Reports are management records, not audited financial statements. USDT results are treated as USD.

## Operation
- Runs on the monitor cron (throttled to every 5 minutes) and on demand: `POST /api/profit/run {"environment":"simulated"}` (operator, or MFA executive/finance approver).
- Reading needs a treasury-ledger reader (operator, executive, finance or accountant).
- Idempotent: each trade enters the books once (`profit_engine_trades` primary key); the batch, trade rows, ledger entry and balances commit in one D1 batch.
- Settings: see `ETI_PROFIT_*` in `ENVIRONMENT_VARIABLES.md`.

# ETI Autonomous Trading: Audit, Dependency Map and Build Log

Method: files read through the GitHub API. Nothing was compiled or run by the author of these notes, so every statement is an observation of source, not a test result. Confirm with the CI run for each commit.

## 1. Entry point and layers (worker/main.ts)

Worker entry: `worker/main.ts` (wrangler `main`). Request layers, innermost first:
base app (`worker/index.ts`) -> agents, futures, algo, markets, command, precision, daily report, pro, wallet, journal, company, treasury, elite, sports guard -> outer: perp, backup, providers, identity, security headers.

## 2. Scheduled handlers

Crons in wrangler.jsonc: `*/15 * * * *`, `* * * * *`, `*/5 * * * *`.

| Cron | Work started via ctx.waitUntil |
|---|---|
| `* * * * *` (monitor) | futures protective-stop monitor, journal cycle, portfolio cycle (D1 paper resting orders, exits, testnet fill sync), perp cycle |
| UNIVERSE_CRON | position management for ETI_MANAGE_ACCOUNTS, execution alert polling, universe batch |
| any other cron | provider probe, auth key maintenance, guarded paper cycle, alpha cycle, precision cycle, daily report, then the base app's scheduled handler |

Cloudflare may fire several cron expressions in the same minute (minute 0 matches all three) and does not guarantee exactly-once delivery.

## 3. Module map

| Capability | Location |
|---|---|
| Execution engine | worker/execution.ts, worker/algo/* |
| KV paper engine (non-transactional state in KV) | worker/algo/paper.ts, paper-api.ts |
| D1 portfolio ledger and paper engine | worker/portfolio/ledger.ts, engine.ts, store.ts, routes.ts |
| Wallet | worker/wallet/*, worker/portfolio/wallet-ui.ts |
| Journal | worker/journal/* |
| Treasury (double-entry, actual vs simulated) | worker/treasury/model.ts, schema.ts, api.ts, route.ts |
| Company management | worker/company/* |
| Order safeguards (duplicate reservation, funds check, refusal audit) | worker/safeguards.ts |
| Market data | worker/market.ts, markets.ts, markets-api.ts, worker/providers/* |
| Strategies and signals | worker/strategies.ts, signals.ts, worker/algo/*, worker/precision/* |
| Futures | worker/futures.ts, futures-monitor.ts, worker/perp/* |
| Auth and security | worker/auth/*, worker/identity/*, worker/security/* |
| Readiness | worker/readiness/* |

Bindings: D1 `ETI_PORTFOLIO_DB` (migrations dir `migrations`), KV `ETI_EXECUTION_LOG`.

## 4. Findings

1. **Real-money switches in production config.** wrangler.jsonc vars include `CHAIN_ENABLED=true` and `CHAIN_MAINNET_SEND_ENABLED=on`. The code behind them has not been read. Owner decision recommended: turn mainnet send off until the activation gate passes.
2. **Live trading is already disabled in this build.** `ETI_LIVE_TRADING_ENABLED` is report-only and `/api/orders/live` returns 423 (see docs/ENVIRONMENT_VARIABLES.md). No new live flag is added; this build does not activate live trading.
3. **Kill switch** `ETI_KILL_SWITCH` is honoured by the paper cycle and its evaluate path. Not yet verified for every other entry path (futures, perp, testnet, manage).
4. **Two parallel paper systems.** The KV `PaperEngine` (state stored without transactions, per its own status note) and the D1 portfolio engine. Whether fills from both reach ledger, journal and treasury through one pipeline is unverified.
5. **Safeguards cover duplicates and funds, not equity risk.** worker/safeguards.ts checks clientOrderId reuse, identical-order windows and cash/holdings, but not the percent-of-equity policy now in worker/risk/policy.ts.
6. A contact email appears in `SEC_USER_AGENT` in wrangler.jsonc (informational).

## 5. Build log

| Step | Status | Change |
|---|---|---|
| 1 | pushed | This audit. |
| 2 | pushed | `worker/risk/policy.ts`: balanced risk policy and sizing, tested in `worker/risk-policy.test.ts`. Not yet called by any order path. |
| 3 | pushed | Migration `0011_execution_locks.sql`, `worker/execution-lock.ts`: atomic D1 locks and idempotency claims, tested. |
| 4 | pushed | `worker/risk/capital.ts`: capital snapshot and wallet/ledger reconciliation, tested. Not yet called by any order path. |
| 5a/5b | pushed | `worker/paper-guard.ts`, wired into `worker/main.ts`: the scheduled KV paper cycle runs under the D1 lock with a per-minute idempotency claim. If the lock store is unreachable (for example migration 0011 not applied), the cycle still manages open positions but new entries are disabled for that run. |

**Operator action required for step 5:** apply migration 0011 to the production D1 database (`wrangler d1 migrations apply eti-portfolio-db --remote`). Until then the guard runs in its degraded mode and the scheduled paper cycle opens no new positions.

## 6. Remaining plan

6. Apply the risk policy and capital snapshot to the paper entry path (replace entry sizing checks with `sizeTrade`).
7. Execution-to-ledger outbox and reconciliation covering the KV and D1 paper systems, journal and treasury.
8. Dashboard controls (pause, resume, kill switch, close positions, cancel orders) on authenticated endpoints.
9. Strategy scoring, learning and the live-activation checks.

# ETI Autonomous Trading: Step 1 Audit and Dependency Map

Status: documentation only. No runtime code changed in this step.
Method: files read through the GitHub API. Nothing was compiled or run, so every statement below is an observation of source, not a test result.

## 1. Entry point and layers (worker/main.ts)

Worker entry: `worker/main.ts` (wrangler `main`). Request layers, innermost first:
base app (`worker/index.ts`) -> agents, futures, algo, markets, command, precision, daily report, pro, wallet, journal, company, treasury, elite, sports guard -> outer: perp, backup, providers, identity, security headers.

## 2. Scheduled handlers

Crons in wrangler.jsonc: `*/15 * * * *`, `* * * * *`, `*/5 * * * *`.

| Cron | Work started via ctx.waitUntil |
|---|---|
| `* * * * *` (monitor) | futures protective-stop monitor, journal cycle, portfolio cycle (paper resting orders, exits, testnet fill sync), perp cycle |
| UNIVERSE_CRON | position management for ETI_MANAGE_ACCOUNTS, execution alert polling, universe batch |
| any other cron | provider probe, auth key maintenance, paper cycle, alpha cycle, precision cycle, daily report, then the base app's scheduled handler |

Observation: each pass is isolated with its own catch, but no shared cross-cycle execution lock is visible in main.ts. Cloudflare may fire several cron expressions in the same minute (for example minute 0 matches all three) and does not guarantee exactly-once delivery. Locking and idempotency must be verified inside each cycle (step 3).

## 3. Module map (from directory listing, internals not yet read in depth)

| Capability | Location |
|---|---|
| Execution engine | worker/execution.ts, worker/algo/* |
| Paper trading | worker/algo/paper-api.ts, worker/portfolio/* |
| Portfolio ledger and engine | worker/portfolio/ledger.ts, engine.ts, store.ts, routes.ts |
| Wallet | worker/wallet/*, worker/portfolio/wallet-ui.ts |
| Journal | worker/journal/* |
| Treasury (double-entry, actual vs simulated) | worker/treasury/model.ts, schema.ts, api.ts, route.ts |
| Company management | worker/company/* |
| Risk and safeguards | worker/safeguards.ts |
| Market data | worker/market.ts, markets.ts, markets-api.ts, worker/providers/* |
| Strategies and signals | worker/strategies.ts, signals.ts, worker/algo/*, worker/precision/* |
| Futures | worker/futures.ts, futures-monitor.ts, worker/perp/* |
| Auth and security | worker/auth/*, worker/identity/*, worker/security/* |
| Readiness | worker/readiness/* |

Bindings: D1 `ETI_PORTFOLIO_DB` (migrations dir `migrations`), KV `ETI_EXECUTION_LOG`.

## 4. Findings

1. **Real-money switches on in production config.** wrangler.jsonc vars include `CHAIN_ENABLED=true` and `CHAIN_MAINNET_SEND_ENABLED=on`. The target policy is paper-first with real transfers only behind an approval and activation gate. Action: add an explicit `LIVE_TRADING_ENABLED=false` flag and gate real sends behind it and the readiness checks (steps 4 and 7). Owner decision needed on turning mainnet send off now.
2. **Kill switch exists** as `ETI_KILL_SWITCH=false` and is referenced by the paper cycle. Needs verification that every entry path (paper, futures, perp, testnet, manage) honours it.
3. **Autopilot flags**: `PAPER_AUTOPILOT=true`; paper entries also need `ETI_PAPER_SYMBOLS` and `ETI_PAPER_AUTOEXECUTE=true`.
4. **Possible parallel pipelines**: paper cycle (algo/paper-api), portfolio cycle (portfolio/routes), futures/perp cycles, and treasury have separate modules. Whether fills flow through one event pipeline into ledger, journal and treasury is unverified (step 5).
5. **Spec items not yet confirmed present**: per-cycle execution lock, outbox for execution-to-ledger events, 0.5% risk-per-trade and 2% daily-loss enforcement matching the spec, reconciliation covering missing or duplicate fills, a Stop Trade button.
6. A hardcoded contact email appears in `SEC_USER_AGENT` in wrangler.jsonc (informational).

## 5. Plan

1. This audit.
2. Risk policy module with tests.
3. Execution lock and idempotency for cycles.
4. Wallet capital discovery, fail-closed reconciliation, live-trading gate flag.
5. Execution, ledger, journal, treasury event pipeline.
6. Dashboard controls on authenticated endpoints.
7. Strategy scoring, learning, live activation gate checks.

Each later step must be read against the real module internals first, and CI results must be checked before it is called verified.

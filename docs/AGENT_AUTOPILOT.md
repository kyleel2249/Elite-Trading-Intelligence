# ETI Multi-Agent Autopilot

The Agent Intelligence Center contains twelve structured specialist agents: Commander, Quantitative, Technical, Fundamental, Macro, Crypto, News, Researcher, Risk Manager, Execution Specialist, Performance Auditor, and Fraud/Security Analyst.

## Operating model

- The five-minute Worker cron calls the scheduled autopilot.
- It evaluates the configured symbol universe with the existing live market providers and supplied research feeds.
- For every scheduled symbol, the complete twelve-agent council runs first, including market, research, security, risk and execution-readiness analysis. Its full snapshot is written to the append-only D1 decision archive (or the existing KV fallback) with authenticated `record:true`, including `NO_TRADE` decisions.
- The existing Omnisignal Swift and GainzAlgo engines are then run across scalp, intraday, swing and position strategies. At least three strategies must independently return the same tradeable direction with no hard validation failures and a score of 60/100 or higher. The Commander must independently agree with that direction. Confidence and consensus thresholds are checked before any execution request.
- Strategy agreement cannot override the council, security or Risk Manager. If any gate fails, the cycle records the reason and abstains. Only after every gate passes can the Execution Specialist request an ETI INTERNAL PAPER order.
- The Risk Manager must approve the proposal, account state and market integrity checks must pass, and high/critical security severity blocks entry.
- The Execution Specialist routes accepted entries to **ETI INTERNAL PAPER only**. The paper portfolio ledger performs its own cash, holdings, fill, fee and slippage accounting.
- Stop-loss and three take-profit levels from the proposal are attached to the internal paper order. The existing portfolio cycle manages fills and protective exits.
- A per-symbol, per-interval, five-minute KV claim prevents duplicate cron deliveries from submitting the same signal twice. Each cycle runs the council before strategy validation and records both actionable and abstaining decisions.
- Existing kill switch, execution token, audit log, max quantity, portfolio position and cash safeguards remain active.

## Default deployment configuration

Cloudflare deployment uses `ETI_AGENT_AUTOPILOT_ENABLED=true` and one consolidated `ETI_AGENT_AUTOPILOT_CONFIG` JSON variable to remain within the Workers Free plan's 64-variable ceiling. The Worker still accepts individual `ETI_AGENT_AUTOPILOT_*` overrides for local/testing environments.

| Setting | Default |
|---|---|
| Enabled | true |
| Venue | ETI INTERNAL PAPER |
| Symbols | BTCUSDT, ETHUSDT, SOLUSDT |
| Interval | 15m |
| Maximum entries per cycle | 2 |
| Strategies | Scalp, intraday, swing, position |
| Strategy quorum | At least 3 of 4 aligned tradeable signals |
| Minimum Omnisignal score | 60 / 100 heuristic points |
| Minimum Commander confidence | 0.65 |
| Minimum directional agreement | 0.65 |
| Maximum open positions | 3 |
| Pyramiding | disabled |
| Live exchange orders | disabled |

The internal paper wallet starts with the configured `ETI_PAPER_START_BALANCE` (default USD 10,000). This is simulated capital, not a live exchange balance.

## API

- `GET /api/agents/autopilot` — scheduler cadence, enabled/readiness state, missing configuration gates, integration status, and last cycle/outcomes. The Agent Intelligence Center refreshes this status every 30 seconds.
- `GET /agents` — Agent Intelligence Center dashboard.
- `GET /api/agents` — agent roster and integration state.
- `POST /api/agents/analyze` — read-only analysis.
- `POST /api/agents/execute` — authenticated execution path; the autopilot uses only `eti_paper`.

## Safety boundary

This autopilot does not submit real-money orders and never calls `/api/orders/live`. Bitget live execution remains a separate capability and is not enabled through this controller. Do not set an automatic live flag as a shortcut. A separate live rollout needs independently verified private exchange egress, read-only account/permission validation, exchange-native order filters, position reconciliation, explicit live authorization, and a tested emergency stop.

If the execution token or persistent audit/portfolio storage is unavailable, the cycle skips execution. Missing market, account, order-book, calendar or research inputs cause abstention or a Risk Manager veto; the agents do not fabricate missing data.

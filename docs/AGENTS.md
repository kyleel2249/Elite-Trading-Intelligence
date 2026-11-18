# ETI multi-agent system

Twelve specialised agents exchange schema-validated JSON (`eti.agent.report/1`, `eti.agent.message/1`, `eti.risk.decision/1`, `eti.decision/1`). Code: `worker/agents/`. The twelve agents are **deterministic statistical/rule-based modules, not language models**. A separate, advisory LLM reviewer can comment on their output (see `docs/LLM_BRIEF.md`); it never changes a decision.

| # | Agent | Data it uses |
|---|---|---|
| 1 | ETI Commander | all reports + risk decision |
| 2 | Quantitative Analyst | candles (+ optional benchmark) |
| 3 | Technical Analyst | candles |
| 4 | Fundamental Analyst | provider tokenomics (CoinGecko) or **supplied** valuation / tokenomics |
| 5 | Macro Intelligence | FRED indicators (needs `FRED_API_KEY`) or **supplied** macro indicators |
| 6 | Crypto Intelligence | order book; **supplied** on-chain metrics |
| 7 | News Intelligence | RSS headlines (CoinDesk, Cointelegraph) or **supplied** news items + calendar events |
| 8 | Elite Trader Researcher | candles (simplified public methodologies) |
| 9 | Risk Manager | proposal, raw market data, account state, security severity, event hazards |
| 10 | Execution Specialist | approved proposal, broker, clientOrderId |
| 11 | Performance Auditor | stored decisions + later candles |
| 12 | Fraud & Security Analyst | candles, book, cross-provider price, integration config |

## Guarantees

* **Risk veto is structural.** `riskManager()` sees only the proposal and raw data (never analyst opinions). If it rejects, `finalize()` returns `NO_TRADE` with `vetoedBy: "risk"`, `executionEligible` is false, no order ticket is built, and `/api/agents/execute` returns 409 without contacting any broker.
* **Disagreements are reported.** Opposing confident stances become a `direction` dispute (positions, explanation, resolution); all dissenting agents are listed in `dissent`; agents without data are listed as *abstaining*, never counted as neutral. A risk veto against the consensus is its own `risk_veto` dispute.
* **No fabricated data.** Fundamental, macro, news and on-chain agents return `insufficient_data` unless a provider returned data or the caller supplied inputs (see `docs/AGENT_PROVIDERS.md`). Caller-supplied data overrides provider data.
* **Paper/testnet only.** The Execution Specialist produces limit-order tickets and forwards them to the existing `/api/orders` gateway (bearer token, kill switch, in-process paper safeguards, KV audit log). The live route is never used.
* Confidence values are heuristic scores, not probabilities. Spot markets cannot be shorted: `SELL` is executable only against an existing `positionQuantity`. Shorting exists only on the Binance USD-M **testnet** futures path (`docs/FUTURES.md`).

## Endpoints

* `GET /agents` – dashboard. `GET /api/agents` – roster, integration status, latest audit summary.
* `GET /api/agents/analyze?symbol=BTCUSDT&interval=1h[&benchmark=ETHUSDT]` – read-only analysis; completed analyses are appended to D1 when configured.
* `POST /api/agents/analyze` – body may include `account`, `fundamentals`, `macro`, `news`, `onchain`, `benchmark`; completed analysis snapshots are automatically persisted when D1 is available.
* `POST /api/agents/execute` – bearer token required. Body: `symbol`, `interval`, `account`, supplied data, `execution: { broker, clientOrderId, riskConfirmed: true, executionSource? }`.
* `GET /api/agents/decisions?limit=25[&before=UNIX_MS][&symbol=BTCUSDT]` – bearer token required; returns full immutable D1 snapshots with reports, evidence, message trail, dissent, risk checks and final decisions. Page size is capped at 100; requires `ETI_PORTFOLIO_DB`.
* `GET /api/agents/audit` – bearer token required. Replays recorded decisions against later candles (stop-first, fees ignored), reports win rate with a Wilson interval and per-agent accuracy. Agents with ≥20 resolved trades and accuracy below 50% have their Commander weight reduced (floor 0.5×).
* `POST /api/agents/brief` – bearer token required; advisory LLM review (needs `ANTHROPIC_API_KEY`).

```json
{"symbol":"BTCUSDT","interval":"1h","account":{"equityUsd":10000,"dailyPnlPct":0,"drawdownPct":0,"openRiskPct":0},
 "news":{"events":[{"name":"FOMC","time":"2026-11-10T19:00:00Z","impact":"high"}]},
 "macro":{"expectedRateChangeBps":-25,"dxyChange30dPct":-1.2}}
```

## Default risk limits (`DEFAULT_RISK_PARAMS`)

1% equity risk per trade, 20% max position, -3% daily loss stop, 10% drawdown stop, 6% open-risk budget, 25 bps max spread, 10% max book participation, stop 0.75–4× ATR, ATR ≤ 8% of price, final-target R:R ≥ 2, stale-data and high-impact-event vetoes, kill switch, security severity ≥ high.

## Durable agent audit

Migration `0017_agent_decision_audit.sql` creates an append-only `eti_agent_decisions` table and indexes. The existing `ETI_PORTFOLIO_DB` D1 binding is reused; no new database or external API key is required. Snapshots use `INSERT OR IGNORE` keyed by decision ID, making retries idempotent. Database triggers reject updates and deletes. The existing KV compact decision log remains for compatibility. If both D1 and KV are unavailable, analysis still returns but reports `auditPersistence: "unavailable"`; the service never claims a failed write succeeded.

## Configuration still required

Account state per request (or Binance testnet credentials so it can be read); broker secrets, `ETI_EXECUTION_TOKEN` and the `ETI_EXECUTION_LOG` KV binding for execution; `FRED_API_KEY` for macro data; `ANTHROPIC_API_KEY` for the advisory review.

## Limits

Researcher methodologies are simplified readings of public descriptions, not the traders' systems. News sentiment in the News agent is a lexicon heuristic (the LLM reviewer does not feed it). The Fraud & Security agent is an anomaly screen, not forensics. Auditor outcomes ignore fees and slippage. Binance order filters (lot size, tick, minimum notional) are applied by the agent execute route; Alpaca filters are not.

Limits: specialist reports remain deterministic statistical/rule-based modules; the optional LLM reviewer remains advisory only. Durable D1 snapshots preserve the complete decision evidence and agent message trail. Performance calibration remains governed by the Auditor and its minimum sample-size threshold.

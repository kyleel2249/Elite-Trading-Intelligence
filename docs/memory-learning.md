# ETI persistent memory & learning

A permanent, structured memory plus a post-trade learning loop. Everything is stored in the main
database (SQLite locally, Postgres in production) and exposed under `/api/memory`.

## What is remembered

| Requirement | Where it lives | Notes |
|---|---|---|
| Trader profiles | `eti_memory_entries` kind `trader_profile` | Documented profiles are snapshotted from `app/knowledge` at startup (`POST /api/memory/seed` re-runs it). Versioned: a changed profile becomes version N+1. |
| Documented methodologies | kind `methodology` | Strategy modules from `app/knowledge/strategies.py`, versioned the same way. |
| Historical market observations | kind `market_observation` | Append-only free-form observations (`POST /api/memory/entries`). |
| Market conditions | `eti_regime_history` | Point-in-time regime series written by the adaptive-edge cycle and council calls. |
| Strategy configurations | `eti_strategy_versions` | Immutable versioned configs with status, diff, evidence, approver. |
| Backtesting results | `eti_backtests` | Every `/api/backtest/run` is stored with its partition and a leakage audit. |
| Previous signals / outcomes | `eti_signals` | Council and strategy-runner signals recorded as known at the time; scored at their horizon. |
| Executed trades (wins and losses) | `eti_trades` | One row per position lifecycle, with the full learning record. |
| Prediction accuracy | `GET /api/memory/accuracy` | Hit rate with Wilson interval, Brier score, calibration buckets, by regime/strategy, plus the legacy forecast accuracy. |
| User preferences, risk limits | kinds `user_preference`, `risk_limit` | `risk_limit/server_enforced` is a read-only snapshot of the limits the `RiskEngine` actually enforces; user limits are advisory memory and never loosen enforcement. |
| Strategy failures | kind `strategy_failure` | Written for every losing trade; explicitly labelled as evidence, not a verdict. |
| Lessons learned | `eti_lessons` | Aggregated over many trades; a lesson stays an `observation` until >= 5 trades. |

`GET /api/memory/overview` returns a count for each of these domains.

## The learning process

Wired in `PortfolioService`: every position-changing fill is handed to
`TradeLearningService` *after* the portfolio commit. Learning failures are logged and swallowed - they
can never block or alter order handling.

When a position closes, ten steps are persisted on the trade (`learning.steps`):

1. **Original analysis** - the signal snapshot taken at entry; its SHA-256 is re-verified at close
   (`analysis_integrity`: `verified` / `mismatch` / `n/a`).
2. **Actual execution** - every entry/exit fill, order ids, environment.
3. **Expected vs actual prices** - entry vs the signal's reference price; exit vs its stop (if it lost)
   or target (if it won).
4. **Realized P/L** - recomputed from fills and reconciled with the portfolio's own figure.
5. **Slippage and costs** - entry slippage (bps, adverse positive), stop-exit deviation, estimated fees.
6. **Assumptions that held** and 7. **assumptions that failed** - only objectively checkable ones
   (`direction`, `target_reached`, `stop_respected`, `horizon`, `regime_stable`, `max_slippage_bps`).
   Anything else is `not_evaluable`; the system never guesses.
8. **Market regime** at entry and exit - latest *point-in-time* observation, otherwise unknown.
9. **Strategy evaluation** - the existing `EdgeHealthMonitor` over *all* closed trades of the strategy,
   regime breakdown, and live-vs-backtest divergence test.
10. **Research and monitoring priorities** and lessons updated (`/api/memory/priorities`, `/lessons`).

### Controlled updates

* A trade never edits a strategy. After >= `MEMORY_MIN_TRADES_FOR_CHANGE` (20) closed trades *and* a
  statistically flagged edge problem (WEAKENING/DEGRADED/BROKEN) the loop may create **one conservative
  proposal** (lower risk per trade, avoid regimes with negative net expectancy), subject to a cooldown.
* Versions are immutable. `proposed -> candidate -> validated -> active`.
  `validated` needs a validation-partition backtest whose leakage audit passed;
  `active` needs a validated version and a named human approver. The learning loop can neither
  validate, activate nor retire (enforced in `StrategyVersionService.transition`, covered by tests).
* `rollback` re-instates a previously validated/baseline config as a new version, with approval.
* The adaptive-edge engine may *suspend* a strategy; only a human resumes it
  (`POST /api/memory/strategies/{id}/suspension`). The strategy runner refuses to execute suspended strategies.

### Bias controls

| Risk | Control |
|---|---|
| Training/validation/live mixing | Partitions `train`, `validation`, `holdout`, `live`, `unclassified`. A single-window backtest is in-sample (`train`) and can never be validation evidence. Walk-forward runs with fixed parameters are recorded as `validation`. Trades are `live` data (use `environment` to tell paper from live). |
| Look-ahead bias | Signals cannot be future-dated; an outcome cannot be dated before the horizon elapsed; regime labels are "latest as of T"; orders only link to signals that predate the fill; analysis is hash-fingerprinted. |
| Data leakage | `audit_split` fails on overlap, missing embargo, tuning on the evaluation window; `/api/memory/split-plan` produces chronological splits with embargo gaps. |
| Survivorship bias | Stats include every strategy that ever traded, retired or not; expired/pending/unscorable signals stay in the population report with a coverage figure; `universe_source` flags non-point-in-time symbol universes. |

## API (summary)

Reads are open; every mutation needs `X-API-Key`.

`GET /api/memory/overview`, `/entries`, `/signals`, `/accuracy`, `/trades`, `/trades/{id}`, `/performance`,
`/lessons`, `/priorities`, `/strategies`, `/strategies/{id}/versions`, `/backtests`, `/regimes`,
`/split-plan`, `/learning/strategies/{id}/evaluation`; `POST /entries`, `/seed`, `/signals`,
`/signals/resolve`, `/signals/{id}/outcome`, `/strategies/{id}/versions`,
`/strategies/{id}/versions/{v}/transition`, `/strategies/{id}/rollback`, `/strategies/{id}/suspension`,
`/backtests`, `/regimes`, `/leakage-audit`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `MEMORY_FEE_BPS` | 5.0 | Estimated per-side fee applied to closed trades (paper fills have no real fees). |
| `MEMORY_SLIPPAGE_ALERT_BPS` | 10.0 | Adverse entry slippage above this is flagged. |
| `MEMORY_DEFAULT_SIGNAL_HORIZON_SECONDS` | 14400 | Horizon given to directional signals that declare none (stored on the signal). |
| `MEMORY_SIGNAL_LINK_WINDOW_MINUTES` | 360 | A fill links to a signal created at most this long before it. |
| `MEMORY_FLAT_BAND_PCT` | 0.5 | A `flat` call is correct when the move stays inside this band. |
| `MEMORY_MIN_TRADES_FOR_CHANGE` | 20 | Closed trades required before a proposal can exist. |
| `MEMORY_PROPOSAL_COOLDOWN_HOURS` | 72 | Minimum gap between automatic proposals for a strategy. |
| `MEMORY_REGIME_MAX_AGE_SECONDS` | 21600 | Regime observations older than this are not used for labelling. |
| `MEMORY_SIGNAL_DEDUPE_SECONDS` | 300 | Identical open signals inside this window are not duplicated. |

## Known limitations

* Positions opened before this feature existed have no memory record (there is no entry price to
  reconstruct); only trades from now on are learned from.
* Fees are estimates. Stop/target checks use marks seen by the MTM job (60 s), not tick data.
* Signals are scored with a *current* quote inside a tolerance window after the horizon
  (`max(5 min, 25% of horizon)`); beyond it they are marked `expired_unscored`, never dropped.
* The strategy runner only applies `lookback` from a stored version's config.
* Linking an order to its signal is heuristic (latest matching open signal before the fill); orders
  do not yet carry an explicit `signal_id`.
* Memory features have no dashboard page yet - use the API / OpenAPI docs at `/docs`.

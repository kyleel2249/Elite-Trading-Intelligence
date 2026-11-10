# Elite Strategy Intelligence

23 independent, configurable strategy modules in `app/strategies/`, a shared cost-aware backtester, and a validation layer. The library produces **research signals and evidence grades only**; it never places orders (`execution_eligible` is always `false`). Execution stays behind `/api/risk-gateway` and the promotion authority.

## Modules (specification order)

trend_following, breakout, pullback, momentum, mean_reversion, swing_trading, scalping, position_trading, statistical_arbitrage, pairs_trading, quantitative_trading, volatility_trading, macro_trading, fundamental_value, growth_investing, contrarian, wyckoff_method, darvas_box, can_slim, volatility_contraction_pattern, turtle_trading, price_action, event_driven.

Each `StrategySpec` records: rule definition (`summary`), `entry_rules`, `exit_rules`, `timeframe`, `required_data`, `stop_loss`, `position_sizing`, `expected_costs`, `known_weaknesses`, default parameters and the parameter grid used for selection. Modules are separate classes with their own parameters (`get_strategy(id, **params)`); unknown parameters are rejected.

### Implementation fidelity (honest labelling)

Every spec carries `fidelity`: `full`, `partial` or `proxy`, with `fidelity_note`. Examples: Wyckoff encodes only the spring/upthrust test; volatility trading is a spot squeeze/expansion proxy (true vol trading needs implied-vol data); Turtle is single-unit, close-based, long-only; CAN SLIM tests only N, L, M (plus C/A if fundamentals are supplied); contrarian is a capitulation proxy unless a sentiment series is supplied.

### Data that is never invented

Pairs, stat-arb (aligned peer closes), CAN SLIM (benchmark), value/growth (point-in-time fundamentals), macro (point-in-time series + ex-ante `signs`) and event-driven (timestamped events) **refuse to run** without that data and return `status: blocked_missing_data`. Fundamentals/macro/sentiment are supplied as `[[effective_ts_ms, value], ...]` and aligned as-of the bar open (no look-ahead); events map to the bar containing their timestamp.

## Backtest engine guarantees

Signal on the close of bar *i* fills at the open of bar *i+1*; stops are intrabar and win ties with targets; gaps through a stop fill at the worse open; every fill pays fee + slippage + half-spread; shorts pay carry; size = `risk_pct` of equity / stop distance, capped by `max_leverage` (default 1x). Still-forming candles and candles with data-quality issues are dropped, never repaired.

## Validation (`/validate`)

1. Full-sample default-parameter backtest (labelled in-sample, descriptive only).
2. Train/test split: parameters chosen on the train segment only; test untouched.
3. Rolling walk-forward: per-fold parameter selection, stitched out-of-sample equity, positive-fold fraction, parameter stability.
4. Maximum drawdown: in-sample, hold-out, stitched walk-forward, worst fold.
5. Performance by regime (causal trend x volatility labels), with a sufficiency flag.
6. Cost stress at 1x / 2x / 3x.
7. Significance: block bootstrap CI and deflated Sharpe (penalises the number of parameter sets tried).
8. Evidence grade from published `CRITERIA`: `blocked_missing_data`, `insufficient_sample`, `no_evidence_of_edge`, `weak_evidence`, `candidate_requires_forward_test`. The best possible grade still means "worth a paper/forward test", never "works".

Historical performance alone never promotes a strategy: a candidate grade requires adequate out-of-sample trades, positive net walk-forward results, limited degradation from in-sample, statistical significance after multiple-testing correction, and survival of doubled costs.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/strategies` | all 23 specs summary + latest stored grade (`not_validated` if never run) |
| GET | `/api/strategies/{id}` | full spec + latest stored report |
| GET | `/api/strategies/{id}/validation` | latest stored report (404 `not_run` if none) |
| POST | `/api/strategies/{id}/backtest` | in-sample run, not stored |
| POST | `/api/strategies/{id}/validate` | full validation, stored; requires `API_KEY` |
| GET | `/api/strategies/{id}/signal` | research state at the last completed candle + evidence grade |

History comes from the Binance klines path (`MarketService.get_history`, max 1000 bars). Results are only stored from real runs: nothing is pre-populated, and no performance figures ship in the repository. Short history (for example 1000 daily bars for position/value strategies) will grade `insufficient_sample` — that is the intended answer, not an error.

## Persistence

Table `strategy_validation_runs` (model in `app/strategies/store.py`, migration `0004_strategy_validation`, joined by `0005_merge_0004_heads`).

## Tests

`python -m unittest tests.test_strategy_library` (also collected by pytest). Covers registry completeness, indicator maths, engine fill/stop/cost/sizing semantics, a prefix-equals-full **no-look-ahead check on all 23 modules**, blocked-on-missing-data, data alignment, statistics, and a false-discovery check (no module earns a candidate grade on driftless random walks). Synthetic series are used only to exercise code and are never reported as performance.

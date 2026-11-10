# ETI Omnisignal X

Analytical dual-engine signal system with a **simulated** paper-trading layer. Live trading is not available through
any of these routes, and no route can withdraw, transfer or move funds.

## Components (`worker/algo/`)

| Module | Role |
|---|---|
| `swift.ts` | Volume-weighted momentum, dual EMA, ATR, adaptive trailing bands, EMA filter, eight-timeframe consensus |
| `gainz.ts` | EMA 9/21/50, RSI intelligence (extremes are context, never reversal calls), breakout / failed-breakout / sweep / squeeze, adaptive threshold, quality gates |
| `fusion.ts` | Seven-outcome agreement detector. Disagreements are settled by independent evidence (higher timeframes, structure, volume, order book, regime), never a majority vote. The rejected engine and the reason are recorded |
| `validation.ts`, `omnisignal.ts` | Independent validation with hard rejections that no score can override. Final: BUY / SELL / HOLD / REJECTED / DATA_UNRELIABLE |
| `paper.ts` | Simulated fills, fees, slippage, TP1/TP2/TP3 partials, break-even and trailing (stops only tighten), kill switch, loss limits, idempotent orders |
| `performance.ts` | Expectancy, profit factor, Sharpe/Sortino (per trade), drawdown, Wilson intervals, calibration. Withheld below 30 trades |
| `replay.ts`, `replay-io.ts` | Historical replay lab with no lookahead, in/out-of-sample split, bootstrap CI, engine comparison |

Confidence is an **uncalibrated evidence score**, not a probability of profit.

## HTTP API

Read-only, public: `GET /api/omnisignal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz`

Authenticated (`Authorization: Bearer $ETI_EXECUTION_TOKEN`), all paper/simulated:

| Route | Purpose |
|---|---|
| `GET /api/paper/status` | Equity, open positions, kill switch, gateway configured |
| `POST /api/paper/evaluate` `{symbol, strategy, execute?}` | Analyse; with `execute:true` open a paper position **only if the risk gateway approves** |
| `POST /api/paper/tick` `{symbol}` | Advance an open position with closed 1-minute bars (each bar applied once) |
| `POST /api/paper/kill` `{on}` | Engage/release the paper kill switch (`ETI_KILL_SWITCH=true` also blocks, with HTTP 423) |
| `GET /api/paper/performance` | 24h/7d/30d/90d/all windows, per engine, per regime, calibration |
| `GET /api/paper/audit?limit=100` | Decision trail (90-day TTL) |

### Required configuration (Worker secrets / bindings)

`ETI_EXECUTION_TOKEN`, `ETI_EXECUTION_LOG` (KV), `ETI_RISK_GATE_URL`, `ETI_RISK_GATE_TOKEN`. Without the gateway settings
every order is rejected (fail closed). Orders are preflighted as `provider=binance, environment=paper, order_type=limit`
against the existing Python `POST /api/risk-gateway/preflight`.

### Scheduled paper cycle (Cron Trigger, every 15 minutes)

`wrangler.jsonc` registers `*/15 * * * *` for this cycle (the `* * * * *` trigger is the futures monitor and `*/5 * * * *` is the universe scan below); the Worker's `scheduled` handler runs one pass. It is **off by default**.

| Variable | Effect |
|---|---|
| `ETI_PAPER_SYMBOLS` | Comma list (max 3 per run, validated). Unset = the cycle only manages already-open positions, otherwise does nothing |
| `ETI_PAPER_STRATEGY` | `scalp` \| `intraday` (default) \| `swing` \| `position` |
| `ETI_PAPER_AUTOEXECUTE` | Only the exact string `true` lets the cycle open positions. Otherwise it analyses only |

Each pass: manage every open position first (always, even under a kill switch or after a symbol is removed), then evaluate the
configured symbols. New entries still need gateway approval and are blocked by `ETI_KILL_SWITCH` or the API kill switch
(recorded as `SKIPPED`). One symbol failing never stops the others. The last pass is visible at
`GET /api/paper/status` -> `scheduler.lastRun`. The 3-symbol cap exists because the Workers free plan allows about
50 subrequests per invocation and one symbol costs about 10.

### Known limits

* State lives in KV, which is not transactional: send paper requests one at a time (a Durable Object would remove this limit).
* Position management uses closed 1-minute bars; the partial minute containing the fill is unmonitored.
* Order-book depth is a REST snapshot; providers are not cross-checked.

## Historical replay

```bash
node scripts/replay.mjs --symbol BTCUSDT --strategy intraday --days 180 --compare --out report.json
node scripts/replay.mjs --csv btc_15m.csv --tf 15m --symbol BTCUSDT --strategy intraday
```

Needs Node >= 22.18 and (without `--csv`) access to `data-api.binance.vision`. Replay has no historical order book,
uses flat fee/slippage, stubs the risk gateway, and is **not** a forecast.

## Dashboard (`/omnisignal`)
Standalone page (`GET /omnisignal`, script at `GET /omnisignal.js`) under a strict CSP: no inline script, same-origin connections only, all values written with `textContent`. Shows both engines, agreement/decision, entry/SL/TP1-3, the eight-timeframe matrix, evidence families, validation, liquidity, and the paper panel (status, positions, performance, audit, kill switch). The paper API token is typed at runtime and held in memory only. It has no live-trading, testnet, withdrawal or transfer controls. Visual checks used synthetic fixtures, not real market data.

## Scanner and leaderboard
`GET /api/omnisignal/scan?symbols=BTCUSDT,ETHUSDT&strategy=intraday` (max 4 symbols per request, about 10 subrequests each). Read-only. Only BUY/SELL rows are ranked, by opportunity score = 60% validator score + 25% reward/risk to TP3 (capped at 3R) + 15% liquidity. This ranks evidence quality, not predicted profit, and is uncalibrated. A failing symbol becomes DATA_UNRELIABLE without aborting the scan. Universe-wide scanning would need a scheduled job writing results to KV; it is not built.

## Walk-forward optimizer, champion/challenger and rollback (offline)
`node scripts/optimize.mjs --symbol BTCUSDT --strategy intraday --days 365 --folds 4` (Node >= 22.18; fetches public candles, so run it where Binance is reachable, or pass `--csv`).
- **Search space:** the default plus six tighten-only gate adjustments (minimum reward/risk 2 or 2.5, confirmation threshold 72 or 80, cost limit 0.15R, and a combined strict set). Real-data runs showed the weight-only profiles (`trend_heavy`, `flow_heavy`, `structure_heavy`, `risk_averse`, still exported) leave the trade set unchanged, so they are not searched by default. Adjustments can only make a gate stricter than its default. Weights keep the default total, data integrity is pinned, and reward/risk keeps a floor. Risk limits, kill switch, permissions, environments and live trading are not tunable.
- **Method:** anchored walk-forward. Each fold trains on earlier data and is scored only on the next unseen block; pooled out-of-sample trades decide.
- **Promotion gates (all required):** at least 30 out-of-sample trades for both sides, mean-R improvement of at least 0.1R, bootstrap 95% interval above zero, drawdown no more than 25% worse than the champion, and the challenger winning at least half the folds. Passing only produces `RECOMMEND_PROMOTION_PENDING_HUMAN_APPROVAL`; `autoApplied` is always false.
- **Registry (`ParamRegistry`, memory or KV store):** `propose` requires an optimizer recommendation, `promote` requires a named human approver (AI-like names are refused), `rollback` only returns to a previously approved version, and `rollbackCheck`/`autoRollbackIfDegraded` revert when at least 30 recent trades fall well below the approved baseline. Every change is audited.
- **Not wired yet:** the scheduled paper cycle and `/api/omnisignal` still use the default weights. The registry is a tested library with no HTTP endpoint, and the optimizer has only been exercised on synthetic data.

## Cost-aware gate (added after the first real-data run)
The first 365-day BTCUSDT 15m replay on real Binance candles showed gross expectancy of about 0R before costs and average fees plus slippage of 0.55R per trade: the stops were too tight for the cost level. The validator now hard-rejects a trade when round-trip costs exceed 0.25R of the risk (`DEFAULT_MAX_COST_R`, fixed in advance, not fitted). The cost assumption is `ETI_ROUND_TRIP_COST_BPS` (default 30 = 2x0.10% fee + 2x0.05% slippage); the replay derives it from the paper fee and slippage. This removes trades where costs dominate. It does not create an edge.

## Real-data research workflow
Actions -> "ETI Research" -> Run workflow (symbol, strategy, days, folds, run_optimizer). It runs the tests, the three-way replay and trade-level diagnostics (`scripts/diagnose.mjs`), and optionally the optimizer, all on real public candles, and prints the results to the job log and step summary. It places no orders and uses no secrets.

The research workflow is now a matrix: `symbols` (default BTC, ETH, SOL, BNB, XRP) x `strategies` (default intraday, swing), at most 8 x 4 jobs. Each job logs a `POOLDUMP` line of per-trade R values so results can be pooled across symbols with a bootstrap interval. The optimizer step is off by default (`run_optimizer`).

## Parameter registry API (token-protected, same bearer token as the paper API)
- `GET /api/paper/params` shows the champion, all versions and the audit trail.
- `POST /api/paper/params/propose {name, result}` where `name` must be a server-side whitelisted candidate (`tight_rr2`, `tight_rr2_5`, `tight_conf72`, `tight_conf80`, `tight_cost15`, `tight_strict`) and `result` is the optimizer output recommending it. Weights and gates are resolved from the whitelist, never from the request.
- `POST /api/paper/params/promote {id, approver}` needs a named human approver (AI-like names are refused). `POST /api/paper/params/rollback {reason}` returns to the previous approved version.
- The champion's weights and tighten-only gates are used by `/api/paper/evaluate`, the scheduled cycle, `/api/omnisignal` and the scanner; responses include `parameters: {version, name}`. No registry means the built-in defaults. If the registry cannot be read, new analysis and entries fail closed (HTTP 503). Nothing here can change risk limits, permissions or live trading.


## Exchange execution steps (Phase 8)

`POST /api/omnisignal/execute {symbol, strategy, accountId, riskUsd, maxNotionalUsd}` (bearer token) analyses with the champion parameters and,
for a BUY plan only (spot cannot short), submits to the Python engine (`ETI_EXECUTION_API_URL`, else the origin of `ETI_RISK_GATE_URL`; key `ETI_RISK_GATE_TOKEN`).
It refuses `live` accounts (403), halted accounts (409) and an active kill switch. Size = the smaller of `riskUsd / (entry - stop)` and `maxNotionalUsd / entry`.
The engine then runs: risk authorization, balance, precision and minimum-notional checks, acknowledgement, fill verification, **protective orders** and reconciliation.
Protective orders are three Binance spot SELL OCO tranches (40/30/30 targets sharing the stop), sized to the quantity actually filled minus a fee buffer
(`reconcile_tolerance_pct`, default 0.25%). If protection cannot be placed the account is halted and the result is `filled_unprotected`.
Limits: stops are static on the exchange (no break-even or trailing adjustment); working protective legs reserve the sellable balance.
**Verification status:** tested only against a fake venue that follows Binance's documented REST shapes (`tests/test_protective_execution.py`). It has not been run against the real Binance testnet; that needs testnet keys.

## Elite Trader assessment (Phase 5)

Every directional plan carries `elite`: the documented methodologies in the Elite Trader research database (`worker/knowledge.generated.json`, built from `app/knowledge`)
checked against the candle-testable strategy modules (turtle, Seykota, Minervini, Darvas, Wyckoff, PTJ) and nine principle checks (trend following, momentum, breakout,
reversal, capital preservation, position sizing, portfolio management, entry/exit, statistical validation, plus the volume footprint). It reports `supports | mixed | opposes | unavailable`.
It is **advisory** unless `eliteGate: true` is passed (replay/options), in which case an `opposes` alignment downgrades the trade to HOLD. It never claims a trader would take the trade,
attributes no position or performance to anyone, and investor disclosures are reported as `not_available` for crypto spot (no verified feed). Whether the gate helps is untested; run it through the research workflow before enabling.

## Volume footprint (Phase 5)

`flow` reports abnormal activity (volume/range z-scores), absorption (heavy volume, narrow range, close location after a move), thin moves, climaxes and a volume-weighted
close-location pressure proxy. Binance candles now carry the exchange-reported taker-buy volume (optional 7th field, kept only when plausible); when nearly every recent bar has it, `pressureBasis` is `taker_buy_volume` (true aggressor imbalance), otherwise the close-location proxy is used and labelled as such. Neither identifies who traded or any institution. Bybit/OKX candles do not supply it, and the public `/api/market/klines` response stays 6 columns.

## Confidence calibration

Scores stay `uncalibrated` until `POST /api/paper/calibration/fit` (token) fits a monotone reliability map from this system's own closed paper trades (clients cannot supply outcomes).
Requirements: at least 100 outcomes, 20 per bin, and the map must beat the base rate (Brier score) on a later 30% holdout, otherwise the status is `no_skill` and no probability is shown.
When calibrated, a plan shows the observed fraction of similar past trades that closed net-positive with a Wilson 95% interval and mean R. That is a past frequency, not a forecast or an expectancy.
`GET /api/paper/calibration` shows the table. Given the research findings (no demonstrated edge), expect `no_skill` until the system has one.

## Universe scanning

`GET /api/omnisignal/universe?limit=25` returns the stored leaderboard and coverage; `POST /api/omnisignal/universe/refresh` (token) runs one batch.
The universe is built from Binance's 24h ticker (one request): USDT pairs, excluding stablecoins and leveraged tokens, with minimum quote volume (default 5M), trade count and a maximum spread (25 bps), capped at 150 by volume.
A dedicated `*/5 * * * *` cron analyses a rotating batch (never-analysed first, then active movers, then the stalest) and stores rows in KV. It is **off unless `ETI_UNIVERSE_ENABLED=true`**.
`ETI_UNIVERSE_BATCH` (default 3, max 25; each symbol costs about 10 subrequests, so mind the plan limit of 50 free / 1000 paid), `ETI_UNIVERSE_MAX_SYMBOLS`, `ETI_UNIVERSE_MIN_QUOTE_VOLUME`, `ETI_UNIVERSE_MAX_SPREAD_BPS`, `ETI_UNIVERSE_STRATEGY`.
Rows older than 8 hours are not ranked; coverage reports fresh, stale and never-analysed counts. At the default batch of 3, full coverage of 150 symbols takes about 4 hours, so raise the batch on a paid plan for a fresher board.

### Running the real-testnet verification

`scripts/testnet_verify.py` (or the manual `ETI Testnet Verify` workflow) needs `BINANCE_TESTNET_API_KEY` and `BINANCE_TESTNET_API_SECRET`.
**Location matters:** Binance rejects signed requests from restricted regions (HTTP 451-style "Service unavailable from a restricted location"). GitHub-hosted runners are in US data centres,
and the first real run (run 42908373572) was rejected for that reason after the keys were read correctly. Run it from a machine in an eligible region
(`pip install -r requirements.txt`, export the two variables, `python scripts/testnet_verify.py`) or from a self-hosted runner there. The same applies to wherever the Python execution backend runs.
ETI does not route around the restriction.

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
| `GET /api/paper/status` | Equity, open positions, kill switch, safeguards in force |
| `POST /api/paper/evaluate` `{symbol, strategy, execute?}` | Analyse; with `execute:true` open a simulated paper position **only if the in-process safeguards pass** |
| `POST /api/paper/tick` `{symbol}` | Advance an open position with closed 1-minute bars (each bar applied once) |
| `POST /api/paper/kill` `{on}` | Engage/release the paper kill switch (`ETI_KILL_SWITCH=true` also blocks, with HTTP 423) |
| `GET /api/paper/performance` | 24h/7d/30d/90d/all windows, per engine, per regime, calibration |
| `GET /api/paper/audit?limit=100` | Decision trail (90-day TTL) |

### Required configuration (Worker secrets / bindings)

`ETI_EXECUTION_TOKEN` and `ETI_EXECUTION_LOG` (KV); optionally `ETI_MAX_ORDER_QUANTITY` (quantity cap). No external service is needed.
Every simulated order passes the in-process safeguards before it opens: kill switch, idempotency key, valid plan and price, position
count, daily-loss and loss-streak limits, re-entry cooldown, entry-zone deviation, stop on the protective side, the optional quantity
cap, and a simulated free-cash check (new notional must fit within equity minus the notional already committed). A SELL opens a
simulated short using the same collateral check. Fills are simulated; no broker is contacted (use `POST /api/orders` for Alpaca Paper
or Binance testnet orders).

### Scheduled paper cycle (Cron Trigger, every 15 minutes)

`wrangler.jsonc` registers `*/15 * * * *` for this cycle (the `* * * * *` trigger is the futures monitor and `*/5 * * * *` is the universe scan below); the Worker's `scheduled` handler runs one pass. It is **off by default**.

| Variable | Effect |
|---|---|
| `ETI_PAPER_SYMBOLS` | Comma list (max 3 per run, validated). Unset = the cycle only manages already-open positions, otherwise does nothing |
| `ETI_PAPER_STRATEGY` | `scalp` \| `intraday` (default) \| `swing` \| `position` |
| `ETI_PAPER_AUTOEXECUTE` | Only the exact string `true` lets the cycle open positions. Otherwise it analyses only |

Each pass: manage every open position first (always, even under a kill switch or after a symbol is removed), then evaluate the
configured symbols. New entries still pass the same safeguards and are blocked by `ETI_KILL_SWITCH` or the API kill switch
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
uses flat fee/slippage, applies the same in-process safeguards, and is **not** a forecast.

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
for a BUY plan only (spot cannot short), executes it in the Worker's own paper/testnet flow (ETI Internal Paper, or Binance testnet) under the in-process safeguards. If the optional Python engine is configured (`ETI_EXECUTION_API_URL` + `ETI_EXECUTION_API_TOKEN`) the plan is submitted there instead, which adds protective OCO orders. No risk gateway is involved either way.
It refuses `live` accounts (403), halted accounts (409) and an active kill switch. Size = the smaller of `riskUsd / (entry - stop)` and `maxNotionalUsd / entry`.
The engine then runs: risk authorization, balance, precision and minimum-notional checks, acknowledgement, fill verification, **protective orders** and reconciliation.
Protective orders are three Binance spot SELL OCO tranches (40/30/30 targets sharing the stop), sized to the quantity actually filled minus a fee buffer
(`reconcile_tolerance_pct`, default 0.25%). If protection cannot be placed the account is halted and the result is `filled_unprotected`.
Stop management (Phase 9): the execution supervisor's cycle watches the venue-side take-profits. After TP1 fills, the remaining tranches' stops move to break-even plus costs (entry +0.25%); after TP2 fills they trail to the TP1 price.
Binance cannot amend an OCO, so each tranche is cancelled and re-placed; only that short window leaves the tranche without a stop. If the replacement is refused the original levels are restored, and if that also fails the account is halted and `protective_failed` is logged.
Stops are only ever tightened, never moved past the market (a stop must sit 0.2% below the bid), and never loosen or add exposure. Idempotent (deterministic client ids per stage). Events: `protective_adjusted`, `protective_adjust_skipped`, `protective_adjust_failed`, `protective_restored`.
Not built: closing or reducing a position on thesis invalidation (structure, momentum, liquidity deterioration); only price levels drive exits. Working protective legs reserve the sellable balance.
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

## Thesis-invalidation exit (Phase 9)

`POST /api/omnisignal/manage {accountId, strategy?, close?}` (bearer token) re-analyses each position ETI opened (up to 3 per call) using the Python engine's `GET /api/execution/accounts/{id}/managed-positions`.
A long is **invalidated** when: both engines and the validator confirm a SELL; or the Elite Trader modules and the volume footprint both oppose it while the buy case is gone; or liquidity is blocked and deteriorating;
or the multi-timeframe consensus is bearish at 60+/100 without degradation and the buy case is gone. Unreliable data is never an invalidation and neither confirms nor clears the counter.
It must hold on **consecutive evaluations** (`ETI_INVALIDATION_CONFIRMATIONS`, default 2, readings no more than 3 hours apart) before anything is done.
Closing only happens with `close: true` (or `ETI_MANAGE_AUTOCLOSE=true` for the scheduled run); otherwise the outcome is `report_only`. Live accounts are refused.
The close is `POST /api/execution/accounts/{id}/positions/{symbol}/close`: venue protective orders are cancelled (they reserve the balance), then a reduce-only sell of at most what ETI holds is sent. It cannot open or add exposure and does not halt the account.
If the sell fails after protection was cancelled, the account is halted with `failed_unprotected_halted`. Fee dust left in the ledger after a full exit is not treated as a position.
Scheduled monitoring: set `ETI_MANAGE_ACCOUNTS` (comma separated account ids, max 3) and optionally `ETI_MANAGE_STRATEGY`; it runs on the `*/5` cron alongside the universe scan, so mind the subrequest budget (about 10 per position).
Not built: partial reductions on a weakened thesis (only full exits on invalidation), and exits driven by anything except the conditions above. Tested against the fake venue only, not the real testnet.

## Alerts (Phase 15)

Email alerts with a persisted, auditable alert log. **Nothing is delivered until you configure a provider**; until then every alert is still logged with `delivered: false` and the reason.

Configuration (Cloudflare Worker variables and secrets; the recipient is deliberately not in the repository):
- `ETI_ALERT_EMAIL`: the recipient address.
- `ETI_ALERT_FROM`: the sender, which must be on a domain your provider has verified.
- **Resend:** secret `RESEND_API_KEY`. Or **Cloudflare Email Service:** a `send_email` binding named `ALERT_EMAIL` (its destination address must be verified in Email Routing).
- Optional: `ETI_ALERT_MAX_PER_HOUR` (default 20; critical alerts always pass), `ETI_ALERTS_DISABLED=true`, `ETI_ALERT_ACCOUNTS` (accounts whose execution log is polled for events; defaults to `ETI_MANAGE_ACCOUNTS`).

Endpoints (bearer token): `POST /api/omnisignal/alerts/test` sends a test email and reports the real result (HTTP 502 if not delivered); `GET /api/omnisignal/alerts` shows configuration status (never the key) and the last 100 alerts with delivery status.

Alerts raised: new BUY/SELL signals and high-conviction signals (universe scan, score 80+), engine disagreement on a held position, trades executed, take-profit hits, stop moved/activated, stop-loss hit, position closed, thesis invalidated, risk rejections, protective-order failures, account halts, exchange outages and recovery,
market-data failures, strategy degradation (read-only comparison of recent paper trades with the approved baseline; it never rolls back by itself), parameter promotion/rollback, kill switch.
Execution-engine events come from polling its log on the `*/5` cron (one subrequest per account); the first poll only records a cursor, so no backfill flood.
Alerts are plain text, redact credential-shaped strings, are de-duplicated (critical 30 min, warning 3 h, info 6 h) and batched into one email per run. A failed send is not marked as seen, so it is retried on the next occurrence.
Not verified: delivery through a real provider (needs your Resend key or Email Routing setup); the Cloudflare binding path is untested outside the Workers runtime.

## Automatic rollback (Phase 11)

On every scheduled paper cycle the champion configuration is judged on the paper trades closed **since it took over** (at least 30, last 60). If recent mean R is more than 0.3R below the baseline it was approved on, is negative, or drawdown exceeds 1.5x the approved baseline,
the registry automatically restores the last **previously human-approved** version and raises a critical alert. Rollback can only return to an approved version; it can never promote or invent a configuration, and a restored version is not blamed for its predecessor's trades.
`ETI_AUTO_ROLLBACK=false` makes it advisory (warning alert only; use `POST /api/paper/params/rollback`). With no earlier approved version (the default configuration) there is nothing to restore and only a warning is raised.

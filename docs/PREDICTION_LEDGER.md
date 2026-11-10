# Prediction Ledger (Tracking & Accountability)

An append-only record of every prediction ETI makes, how it turned out, and how well-calibrated it is.

## What is stored (`predictions`)
Server-assigned UID and exact UTC timestamp (clients cannot supply it), asset, market, price feed, direction (`up|down|neutral`), entry reference, horizon (label, seconds, `expires_at`), expected price range (`target_low/high`, optional `target_base`), probability estimate, reasoning, supporting sources (>=1 required), invalidation criteria (+ optional invalidation price), market regime, strategy, model version, analyst, SHA-256 `content_hash`.

`GET /api/predictions/{uid}/verify` recomputes the hash from the stored fields; `intact=false` means a row was altered outside the application.

## Outcomes (`prediction_outcomes`)
One write-once row per prediction: realized price, price source, observation time, lateness, direction correct, in target range, absolute / % error, invalidation flag. Statuses: `resolved`, `invalidated`, `late`. Failed predictions are scored and kept like any other.

## Never delete / never rewrite
Three layers: (1) ORM `before_update`/`before_delete` listeners raise `ImmutableRecordError`; (2) database triggers (SQLite and PostgreSQL) abort any UPDATE/DELETE on `predictions`, `prediction_outcomes`, `prediction_reports`, including bulk and raw SQL; (3) the first outcome wins (unique `prediction_id`). Migration `0004` refuses to downgrade unless `ALLOW_LEDGER_DOWNGRADE=yes-destroy-prediction-history` is set. A database superuser can still drop triggers; protect DB credentials and back up the tables. The legacy `forecasts` / `forecast_accuracy` tables are not trigger-protected (other code paths use them); the ledger is the accountability record.

## Metrics (`GET /api/predictions/metrics`)
Directional accuracy; target-range hit rate; mean absolute error and % error; Brier score (+ skill vs. coin-flip); expected calibration error and per-bin reliability; breakdowns by asset, timeframe, market regime, strategy, market. Groups under 30 scored predictions are flagged `sufficient_sample=false` with a warning.

Rules: `up` correct if price > entry, `down` if price < entry, `neutral` if |return| <= 0.5%.

## Resolution (how the realized price is obtained)
`PredictionResolverJob` runs every `PREDICTION_RESOLVE_INTERVAL_SECONDS` (default 300):

1. **Binance candles (preferred).** Uses completed 1m / 5m / 1h candles (a size is used only if <= 10% of the horizon). The realized price is the close of the last candle that closes at or before expiry (within one candle), and invalidation is checked against the **high/low path** from creation to expiry. Because this is historical data it is exact and never `late`, however long after expiry the job runs, as long as the candle window (up to 1000 candles) still covers the prediction.
2. **Snapshot fallback** (Alpaca, or Binance when candles do not cover the window): the live price at evaluation time. If that is later than max(15 min, 10% of horizon) after expiry the outcome is stored as `late` and excluded from accuracy (counted separately).
3. **No feed** (`provider` null): settle with `POST /api/predictions/{uid}/outcome` (API key; refused before expiry) or the form on `/predictions`.

The job also publishes the previous month's report once.

## Auto-logging
`GET /api/intelligence/forecast?persist=true` also writes the forecast to the ledger (deduplicated per symbol/horizon/model/hour). The regime comes from `MarketRegimeEngine`. The scaffold model scales *hourly* return volatility by 0.5 / 1 / 2 / 3.5, so auto-logged forecasts are scored over the window the model actually describes: scalp 30 min, intraday 1 h, swing 2 h, position 3.5 h. Direction comes from the base scenario; up calls are invalidated at the bear scenario, down calls at the bull scenario. The model's heuristic `confidence` is stored as its stated probability, so the calibration table shows whether it deserves that confidence.

## Monthly reports
`prediction_reports`: one per `YYYY-MM`, generated only after the month ends, immutable once published. Scope: predictions whose horizon expired in the month. Endpoints: `GET /api/predictions/reports`, `/reports/{period}`, `/reports/{period}/markdown`, `/reports/{period}/preview` (any time, not stored), `POST /reports/{period}/publish` (API key).

## API
`POST /api/predictions` (key), `GET /api/predictions`, `GET /api/predictions/{uid}`, `GET /api/predictions/{uid}/verify`, `POST /api/predictions/{uid}/outcome` (key), `GET /metrics`, `GET /job/status`, `POST /job/run` (key). Dashboard: `/predictions`.

## Known limitations
- Candle-based resolution is exact to one candle (<= 10% of horizon); path invalidation excludes the partial candle containing creation.
- Only Binance has historical candles. Alpaca and manual predictions use snapshots / manual settlement.
- Existing deployments: run `alembic upgrade head` (merge revision `0005_merge_0004_heads` joins the three parallel 0004 migrations) or restart (`init_db` creates the tables and triggers).
- `tests/test_repo_integrity.py` fails CI if Alembic forks again or if `app/main.py` loses the ledger/markets/strategies/adaptive-edge/memory routers.

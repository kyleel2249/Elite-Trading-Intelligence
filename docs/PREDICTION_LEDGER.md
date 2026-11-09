# Prediction Ledger (Tracking & Accountability)

An append-only record of every prediction ETI makes, how it turned out, and how well-calibrated it is.

## What is stored (`predictions`)
Server-assigned UID and exact UTC timestamp (clients cannot supply it), asset, market, price feed, direction (`up|down|neutral`), entry reference, horizon (label, seconds, `expires_at`), expected price range (`target_low/high`, optional `target_base`), probability estimate, reasoning, supporting sources (>=1 required), invalidation criteria (+ optional invalidation price), market regime, strategy, model version, analyst, SHA-256 `content_hash`.

## Outcomes (`prediction_outcomes`)
One write-once row per prediction: realized price, price source, observation time, lateness, direction correct, in target range, absolute / % error, invalidation flag. Statuses: `resolved`, `invalidated`, `late`. Failed predictions are scored and kept like any other.

## Never delete / never rewrite
Three layers: (1) ORM `before_update`/`before_delete` listeners raise `ImmutableRecordError`; (2) database triggers (SQLite and PostgreSQL) abort any UPDATE/DELETE on `predictions`, `prediction_outcomes`, `prediction_reports`, including bulk and raw SQL; (3) the first outcome wins (unique `prediction_id`). Migration `0004` refuses to downgrade unless `ALLOW_LEDGER_DOWNGRADE=yes-destroy-prediction-history` is set. A database superuser can still drop triggers; protect DB credentials and back up the tables.

## Metrics (`GET /api/predictions/metrics`)
Directional accuracy; target-range hit rate; mean absolute error and % error; Brier score (+ skill vs. coin-flip); expected calibration error and per-bin reliability; breakdowns by asset, timeframe, market regime, strategy, market. Groups under 30 scored predictions are flagged `sufficient_sample=false` with a warning.

Rules: `up` correct if price > entry, `down` if price < entry, `neutral` if |return| <= 0.5%. Outcomes recorded later than max(5 min, 10% of horizon) after expiry are stored as `late` and excluded from accuracy (counted separately).

## Evaluation
`PredictionResolverJob` (every `PREDICTION_RESOLVE_INTERVAL_SECONDS`, default 300) scores matured predictions with a Binance/Alpaca snapshot, and publishes the previous month's report once. Predictions without a feed (`provider` null) are settled with `POST /api/predictions/{uid}/outcome` (API key; refused before expiry).

## Auto-logging
`GET /api/intelligence/forecast?persist=true` also writes the forecast to the ledger (deduplicated per symbol/horizon/model/hour). The regime comes from `MarketRegimeEngine`. Horizon seconds: scalp 1h, intraday 6h, swing 3d, position 14d. The scaffold model's `confidence` is recorded as its stated probability, so the calibration table shows whether it deserves that confidence.

## Monthly reports
`prediction_reports`: one per `YYYY-MM`, generated only after the month ends, immutable once published. Scope: predictions whose horizon expired in the month. Endpoints: `GET /api/predictions/reports`, `/reports/{period}`, `/reports/{period}/markdown`, `/reports/{period}/preview` (any time, not stored), `POST /reports/{period}/publish` (API key).

## API
`POST /api/predictions` (key), `GET /api/predictions`, `GET /api/predictions/{uid}`, `POST /api/predictions/{uid}/outcome` (key), `GET /metrics`, `GET /job/status`, `POST /job/run` (key). Dashboard: `/predictions`.

## Known limitations
- Realized price is a snapshot at evaluation time; invalidation is checked at that price, not along the price path.
- Legacy `forecasts` / `forecast_accuracy` tables are untouched. Their scorer ignores horizon maturity, so the ledger supersedes it for accountability.
- Existing deployments: run `alembic upgrade head` (or restart; `init_db` creates the tables and triggers).

# ETI Sports Betting Intelligence

## Global bookmaker and fixture ingestion

ETI uses OddsPapi v4 as its primary football fixture and odds source. The provider advertises 300+ bookmakers and 60+ sports; ETI displays only bookmakers and markets actually returned for each fixture. Coverage is dependent on the account subscription and live provider feed. The Odds API remains an optional fallback for its supported US and international regions.

Worker secrets (never commit these to Git):
- ODDSPAPI_API_KEY — global football fixtures, odds, results and account diagnostics.
- ODDS_API_KEY — optional The Odds API fallback.
- ETI_SPORTS_PAPER_TOKEN — protects the separate paper betting ledger and administrative history sync.

A key committed to a repository, browser bundle, log or source file must be revoked and rotated immediately. GitHub Actions secrets do not automatically become Cloudflare Worker secrets; add the values to the deployed Worker under Settings → Variables and Secrets → Secrets.

## Endpoints

- GET /api/sports/status — reports whether credentials and the D1 binding are configured (not whether the provider is reachable).
- GET /api/sports/health — performs live, key-safe provider probes and checks whether all sports D1 tables exist. It never returns the provider API key.
- GET /api/sports/football/next?limit=8 — retrieves upcoming football fixtures in the next eight days, scans available bookmaker boards, and attaches model predictions, best available price, expected value, decision and recommended stake when the model is qualified.
- POST /api/sports/football/sync-history — paper-token protected; fetches finished fixtures and scores from the previous eight days and stores unseen results for model training. Manual request body may include limit (1–30).
- POST /api/sports/bets — paper-token protected; accepts an event_id only for a persisted ETI model VALUE_CANDIDATE. It uses the stored best market, selection, bookmaker, odds, model probability and stake recommendation. Manual arbitrary probabilities and stakes are rejected; optional stake_cents cannot exceed the model recommendation.
- GET /api/sports/bets — paper-token protected; returns the separate sports bankroll and paper ledger.
- POST /api/sports/bets/{id}/settle — manual settlement remains available for supported paper entries. The history sync automatically settles model-backed Full Time Result, Both Teams To Score and Over/Under Full Time paper bets when final scores arrive.

## Autonomous schedule and quota protection

The Worker scheduled handler invokes the sports scan and history sync. D1 job locks prevent duplicate execution when multiple cron schedules fire:
- ETI_SPORTS_SCAN_INTERVAL_MINUTES defaults to 360 (six hours), minimum 60.
- ETI_SPORTS_HISTORY_SYNC_MINUTES defaults to 1440 (24 hours), minimum 360.
- ETI_SPORTS_AUTO_SCAN_LIMIT defaults to 1 fixture per scheduled cycle; maximum 12.
- ETI_SPORTS_HISTORY_BATCH_SIZE defaults to 5 unseen finished fixtures per scheduled cycle; maximum 30.
- Manual dashboard scans can request up to 12 fixtures and manual history sync can import up to 30.
- Provider calls are sequential and respect the OddsPapi fixture/odds/scores endpoint cooldowns. Adjust intervals only after checking your account request allowance.

The health endpoint reports active subscription request limits and usage. The scheduled scan requires ODDSPAPI_API_KEY, ETI_SPORTS_PAPER_TOKEN, ETI_PORTFOLIO_DB and migrations 0003–0005.

## Autonomous Football Prediction Engine

### Model

The current first model version is `eti-poisson-form-v1`. It:
1. Builds recent team form from stored final match results.
2. Uses league-specific home/away goal baselines and venue-specific attack/defence rates with shrinkage toward league averages.
3. Estimates expected home and away goals.
4. Uses Poisson scoreline probabilities to derive 1X2, Both Teams To Score and Over/Under 2.5 probabilities.
5. Compares those probabilities with the best currently available bookmaker price for each supported market/outcome.

The model refuses to publish team-specific probabilities when it has fewer than five historical matches for either team or fewer than 20 relevant competition results. It will display “Insufficient history” and recommend zero stake.

### Calibration and value gate

Predictions are stored before kickoff and later labelled from final scores. After at least 100 resolved predictions, ETI fits a temperature-scaling calibration parameter using past out-of-sample predictions and reports Brier score and log loss. Stakes remain disabled unless the sample is at least 100 and the current model-quality gates pass (Brier <= 0.62 and log loss <= 1.15). These are conservative operational gates, not a guarantee of future performance.

A value candidate requires at least 3% expected value at the best available price. The suggested stake uses 25% Kelly and is capped at 1% of the separate sports paper bankroll per event. If the model is uncalibrated, data is stale or insufficient, or there is no positive edge, stake is zero.

### Supported markets

- Full Time Result (Home / Draw / Away)
- Both Teams To Score (Yes / No)
- Over/Under Full Time 2.5 goals

Other markets are displayed when returned by the provider but are not automatically recommended or paper-settled by this model version.

### Results and journal

- `sports_event_scans` stores fixture and bookmaker snapshots.
- `sports_match_results` stores final scores used for training.
- `sports_model_predictions` stores pre-match probabilities, model version, calibration evaluation, best market/selection/bookmaker/odds, expected value, recommended stake and eventual outcome.
- `sports_bets` stores paper stakes, source provenance, bankroll reservation and settlement P/L.
- `sports_job_state` prevents duplicate scheduled syncs.

All paper bets are kept separate from ETI financial trading balances. No bookmaker login, real-money execution, deposits or withdrawals are implemented.

## Database migrations

Apply the repository migrations in order to the D1 database bound as ETI_PORTFOLIO_DB:

```sh
npx wrangler d1 migrations apply eti-portfolio-db --remote
```

This includes:
- 0003_sports_betting.sql
- 0004_sports_event_audit.sql
- 0005_football_prediction_engine.sql

Confirm readiness at GET /api/sports/health. If tables are missing, inspect Wrangler's configured D1 database name and migration history before retrying.

## Operational limitations

- The model is a transparent baseline, not a guarantee of accuracy. It does not yet incorporate verified injuries, lineups, xG, weather, player availability or tactical data.
- Initial model training is cold-started from recent OddsPapi final scores. Historical data accumulates over time; do not enable staking before the calibration gate reports stake_enabled=true.
- Odds can change between scan and kickoff. ETI stores the scanned price and provider timestamp but should re-scan before recording a paper bet.
- Provider coverage, request quotas and available markets vary by subscription and country. Ghanaian and African books appear only when the provider returns them for a fixture.
- Model recommendations and paper bets are simulations, not financial advice or a claim of guaranteed profit.

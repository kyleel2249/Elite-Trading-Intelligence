# ETI Sports Betting Intelligence

## Global bookmaker and fixture ingestion

ETI uses OddsPapi v4 as its primary football fixture and odds source. The provider advertises 300+ bookmakers and 60+ sports; ETI requests odds without a bookmaker filter so the response can include every bookmaker available for each fixture under the active subscription. The dashboard and `/api/sports/health` expose the active subscription's bookmaker names. Coverage is dependent on the account subscription and live provider feed. The provider's regional coverage map is still being completed, so Ghanaian and other African operator availability must be confirmed from the actual subscribed bookmaker list and event responses; ETI does not claim every local operator is covered. The Odds API remains an optional fallback for its documented `us`, `us2`, `uk`, `eu` and `au` regions; the fallback route rejects unknown region codes.

Worker secrets (never commit these to Git):
- ODDSPAPI_API_KEY — global football fixtures, odds, results and account diagnostics.
- ODDS_API_KEY — optional The Odds API fallback.
- ETI_SPORTS_PAPER_TOKEN — protects the separate paper betting ledger and administrative history sync.
- Existing ETI provider credentials removed from wrangler.jsonc must also be re-added as Worker secrets: TOKENOMIST_API_KEY, FMP_API_KEY and EVENT_FEED_TOKEN.

A key committed to a repository, browser bundle, log or source file must be revoked and rotated immediately. GitHub Actions secrets do not automatically become Cloudflare Worker secrets; add the values to the deployed Worker under Settings → Variables and Secrets → Secrets.

## Endpoints

- GET /api/sports/status — reports whether credentials and the D1 binding are configured (not whether the provider is reachable).
- GET /api/sports/health — performs live, key-safe provider probes and checks whether all sports D1 tables exist. It never returns the provider API key.
- GET /api/sports/football/next?limit=12&competition=uefa_nations_league — retrieves UEFA Nations League fixtures returned by OddsPapi in the next 47 hours, scans every bookmaker board returned for each selected fixture, and attaches model probabilities, best available price, expected value, decision and recommended stake when the model is qualified. Use `competition=all` for the general football feed. The endpoint reports when its 12-fixture safety cap truncates the provider feed.
- POST /api/sports/football/sync-history — paper-token protected; fetches finished fixtures and scores from the previous 47 hours and stores unseen results for model training. Manual request body may include limit (1–30).
- POST /api/sports/bets — paper-token protected; accepts an event_id only for a persisted ETI model VALUE_CANDIDATE. It uses the stored best market, selection, bookmaker, odds, model probability and stake recommendation. Manual arbitrary probabilities and stakes are rejected; optional stake_cents cannot exceed the model recommendation.
- GET /api/sports/bets — paper-token protected; returns the separate sports bankroll and paper ledger.
- POST /api/sports/bets/{id}/settle — manual settlement remains available for supported paper entries. The history sync automatically settles model-backed Full Time Result paper bets from the provider 90-minute `fulltime` score. It does not substitute the `result` score (which may include extra time) or a half-time score; if a regulation-time score is absent, settlement is deferred. Other market bets are not auto-created by this model version.

## Autonomous schedule and quota protection

The Worker scheduled handler invokes the sports scan and history sync. OddsPapi requires sport-wide fixture date ranges to be shorter than 48 hours, so both queries use a 47-hour window. History results are processed oldest-first within that window. D1 job locks prevent duplicate execution when multiple cron schedules fire:
- ETI_SPORTS_SCAN_INTERVAL_MINUTES defaults to 360 (six hours), minimum 60.
- ETI_SPORTS_HISTORY_SYNC_MINUTES defaults to 1440 (24 hours), minimum 360.
- ETI_SPORTS_AUTO_SCAN_LIMIT defaults to 12 fixtures per scheduled cycle; maximum 12. The Nations League dashboard scan requests up to 12 eligible fixtures per scan.
- ETI_SPORTS_HISTORY_BATCH_SIZE defaults to 5 unseen finished fixtures per scheduled cycle; maximum 30.
- Manual dashboard scans can request up to 12 fixtures and manual history sync can import up to 30.
- Provider calls are sequential, respect the documented fixtures/odds/scores cooldowns, and retry transient `429 RATE_LIMITED` responses using the provider's `retryMs`. Quota-exhaustion errors are not retried. Adjust intervals only after checking your account request allowance.

The health endpoint reports active subscription request limits and usage. The scheduled scan requires ODDSPAPI_API_KEY, ETI_SPORTS_PAPER_TOKEN, ETI_PORTFOLIO_DB and migrations 0003–0007.

## UEFA Nations League coverage\n\nThe `/sports` dashboard defaults to UEFA Nations League. ETI filters the OddsPapi global football fixture feed by the competition name, scans up to 12 eligible fixtures inside the provider-safe 47-hour window, and requests the odds board for each fixture without a bookmaker filter. It therefore compares all bookmakers returned by the active subscription for those fixtures; it cannot guarantee that every national-team fixture or Ghanaian/African bookmaker is present in the provider feed. The dashboard can switch back to all football competitions. The automatic scheduled scan defaults to a maximum of 12 fixtures per cycle, subject to the provider response and account quota.\n\n## Autonomous Football Prediction Engine

### Model

The current baseline model is `eti-poisson-form-v1`. It:
1. Builds recent team form from stored final match results.
2. Uses league-specific home/away goal baselines and venue-specific attack/defence rates with shrinkage toward league averages.
3. Estimates expected home and away goals.
4. Uses Poisson scoreline probabilities to derive 1X2, Both Teams To Score and Over/Under 2.5 probabilities.
5. Compares those probabilities with the best currently available bookmaker price for each supported market/outcome.

For UEFA Nations League fixtures, the engine first uses competition-specific results. If fewer than 20 are available, it may use only international national-team competitions (Nations League, World Cup, European Championship/Euro, international fixtures and qualifiers, Copa America, AFCON and Asian Cup) as the fallback pool; it does not mix club results into country-v-country estimates. The model refuses to publish team-specific probabilities when it has fewer than five historical matches for either team or fewer than 20 relevant international results. It will display “Insufficient history” and recommend zero stake. Nations League staking calibration is separately restricted to resolved international-competition predictions and must independently pass the same 100-record / 30-holdout quality gate.

### Calibration and value gate

Predictions are stored before kickoff and later labelled from final scores. After at least 100 resolved predictions, ETI sorts labelled predictions chronologically, fits temperature scaling on the oldest 70%, and evaluates only on the newest 30% (at least 30 holdout matches). It reports holdout Brier score and log loss alongside the uncalibrated baseline. Calibration is rejected if it worsens either metric by more than 0.005, if Brier exceeds 0.62, or if log loss exceeds 1.08. The route independently enforces these gates before any stake can be recommended. These are conservative operational gates, not a guarantee of future performance.

A value candidate requires at least 3% expected value at the best available price. The paper ledger enforces one open model-backed stake per fixture, including across model-version upgrades and rejects concurrent duplicate entries. Migration 0006 removes duplicate open stakes within a model version, and migration 0007 enforces one open model-backed stake per fixture across model versions. Both migrations keep the earliest open entry, mark later duplicates VOID and refund those duplicate stakes to the sports paper bankroll before creating the unique index. The suggested stake uses 25% Kelly and is capped at 1% of the separate sports paper bankroll per event. If the model is uncalibrated, data is stale or insufficient, or there is no positive edge, stake is zero.

### Stakeable market in this model version

- Full Time Result (Home / Draw / Away)

The engine also calculates exploratory BTTS and Over/Under 2.5 probabilities from its Poisson score matrix, but they are explicitly not eligible for value recommendations or automatic paper stakes until each market has its own out-of-sample calibration and quality gate. Other markets are displayed when returned by the provider but are not automatically recommended or paper-settled.

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

- The model is a transparent baseline, not a guarantee of accuracy. For Nations League predictions it can fall back to international-only history, but it does not yet incorporate verified injuries, lineups, xG, weather, player availability, travel fatigue or tactical data.
- Initial model training is cold-started from recent OddsPapi final scores. Historical data accumulates over time; do not enable staking before the calibration gate reports stake_enabled=true.
- Odds can change between scan and kickoff. ETI stores the scanned price and provider timestamp but should re-scan before recording a paper bet.
- Provider coverage, request quotas and available markets vary by subscription and country. Ghanaian and African books appear only when the provider returns them for a fixture.
- Model recommendations and paper bets are simulations, not financial advice or a claim of guaranteed profit.

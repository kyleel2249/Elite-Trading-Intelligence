# ETI Sports Betting Intelligence

## Global football discovery and bookmaker coverage

The module now supports two odds-data paths:

- **OddsPapi** (ODDSPAPI_API_KEY): preferred global football discovery and multi-bookmaker feed. ETI requests the next eight-day fixture window, finds the nearest upcoming football fixtures with odds, and retrieves the complete bookmaker board for each selected fixture by omitting the bookmaker filter. The API provider advertises 300+ bookmakers and 60+ sports, including regional operators. Actual bookmaker, country, competition and market coverage depends on the provider's current feed and subscription.
- **The Odds API** (ODDS_API_KEY): secondary odds provider for supported regions. ETI's region allowlist includes us, us2, uk, eu, au, ca, fr, se, and fi. It is useful for US and major international books. Its published region list does not include a Ghana or Africa region, so do not assume it supplies Ghanaian books.

The global scan endpoint is:
- GET /api/sports/football/next?limit=8 — finds the next upcoming football fixtures in an eight-day window and retrieves bookmaker odds for up to 12 events (default 8). It returns the soonest event separately, all returned bookmaker prices, and a count of distinct bookmakers seen.
- Each returned event is written to sports_event_scans when D1 and migration 0004_sports_event_audit.sql are available.
- GET /api/sports/status reports which odds providers are configured.
- Existing GET /api/sports/events?sport=...&regions=... remains available for The Odds API.

### Ghana and African bookmakers

OddsPapi is the intended provider for the broad regional board. Its published coverage includes many global and regional bookmakers; the actual Ghana-specific book list must be verified from live provider data after connecting the key. ETI must display only bookmakers actually returned by the API, never claim a brand is connected merely because it appears on a static watchlist.

The Odds API's documented region set currently does not include Ghana/Africa. Ghana-facing books such as SportyBet Ghana, 1xBet Ghana, MSport and other locally licensed operators should appear only if the connected provider actually supplies their current odds. Do not scrape bookmaker websites or reverse-engineer private app endpoints. If a target book is missing, use a licensed provider feed or an authorized bookmaker API contract.

## Automatic analysis and probability integrity

The global fixture/odds scan is implemented as a data-ingestion layer, not a calibrated prediction model. Odds from bookmakers are not an independent model probability. The current response deliberately returns model_probability: null, recommended_stake: 0, and NO_BET_UNTIL_VALIDATED_MODEL_AVAILABLE until a validated team-performance model is connected.

The production model layer must ingest licensed historical match results and current team features (xG for/against, home/away form, shots, injuries/suspensions, rest, lineups, competition strength and weather where relevant), then:
1. Estimate expected goals using a documented Poisson/Dixon-Coles or stronger model.
2. Convert scoreline probabilities into 1X2, totals, BTTS, handicap and other supported market probabilities.
3. Calibrate out-of-sample probabilities and report Brier score, log loss, calibration error and sample size by league/market.
4. Compare model probability with best available decimal odds after removing bookmaker overround.
5. Reject stale prices, suspended markets, mismatched fixtures, duplicate/clone bookmaker feeds and low-liquidity prices.
6. Recommend a stake only when the calibrated edge passes configured thresholds. Default to fractional Kelly with a strict per-event cap, daily loss cap and bankroll drawdown stop. Never size from raw confidence labels.

No prediction should be described as accurate or guaranteed. A model probability must include model version, data timestamp, training window, calibration status and uncertainty. If data is missing or stale, return no bet.

## Event and stake journal

Migration 0003_sports_betting.sql creates the separate paper bankroll and stake ledger. Migration 0004_sports_event_audit.sql adds:
- Event-level scan snapshots, fixture identity, competition, country, kickoff time, bookmaker count and raw normalized odds snapshot.
- Stake provenance fields for fixture ID, bookmaker, odds provider, implied probability, expected value and model version.

The stake ledger continues to be isolated from financial trading balances. All initial activity remains paper-only. Settlement is manual in this release; automatic result settlement must use a trusted official results feed and idempotent settlement logic.

## Cloudflare Worker secrets

Set these as Worker secrets, never commit them:
- ODDSPAPI_API_KEY — global/regional bookmaker odds and football fixtures.
- ODDS_API_KEY — optional The Odds API fallback.
- ETI_SPORTS_PAPER_TOKEN — long random token protecting the simulated bankroll and ledger.

The existing ETI_PORTFOLIO_DB D1 binding is reused only as a database host. Sports data is stored in separate sports_* tables and does not share the financial portfolio ledger.

Apply both migrations to the configured D1 database:
```sh
npx wrangler d1 migrations apply eti-portfolio-db --remote
```

## Operational limits

- OddsPapi documents /v4/fixtures and /v4/odds as quota-bearing endpoints and specifies endpoint cooldowns. The scan intentionally caps the number of events per request; do not run an unlimited every-minute global scan without a suitable plan and quota budget.
- The OddsPapi API key is sent as a query parameter by its documented API. It must remain server-side in a Worker secret; never expose it in browser code, logs, URLs shared with users, or Git.
- The OddsPapi feed claims 300+ bookmakers, but no aggregator can guarantee every bookmaker, every country or every market. ETI reports observed feed coverage, not theoretical coverage.
- No real-money bookmaker execution, deposits or withdrawals are implemented.

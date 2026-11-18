# ETI analytics: implementation matrix

See **[CAPABILITY_MAP.md](CAPABILITY_MAP.md)** for how the 31 requested items map onto existing ETI code (its rows for calendars,
token unlocks and whale activity are superseded by [PROVIDERS.md](PROVIDERS.md)).

Status key: **UNIT** = offline unit tests (synthetic data or fake transport). **ROUTE** = also exercised through FastAPI's
TestClient against the real app with fake market/provider HTTP. **NOT RUN LIVE** = never executed against a live provider or
exchange. Nothing below is PASS: PASS requires verification against real data, which the Integration Health Center and
`scripts/verify_deployment.py` provide on a deployed instance.

All routes are under `/api/analytics`. Auth: none for GET/compute routes; `POST /intel/providers/probe` and
`POST /intel/health-center/verify` need `X-API-Key`; `GET /intel/calendar/feed` needs `Authorization: Bearer $EVENT_FEED_TOKEN`
(required when `APP_ENV` is production/staging). CPU-heavy routes are bounded (Monte Carlo paths x horizon <= 2,000,000; walk-forward
grid <= 60 combinations) and run in a worker thread. The intel router is mounted once, by `app.main`'s router loop, at
`/api/analytics/intel`.

| Capability | Method + route | Provider / data | Status |
|---|---|---|---|
| Scan + ranking + watchlist | GET `/scan` | MarketService candles | PARTIAL (UNIT + ROUTE; NOT RUN LIVE) |
| Regime / unusual volume / breakout | GET `/regime`, `/unusual-volume`, `/volatility-breakout` | MarketService | PARTIAL (UNIT; regime ROUTE) |
| Correlation, Monte Carlo | GET `/correlation`, `/monte-carlo` | MarketService | PARTIAL (UNIT + ROUTE incl. limits) |
| Stress / scenarios | POST `/stress`, `/scenario`; GET `/stress/scenarios` | request body | PARTIAL (UNIT + ROUTE) |
| Walk-forward, strategy lab | POST `/walk-forward`, `/strategy-lab/compare` | MarketService | PARTIAL (UNIT + ROUTE incl. grid limit) |
| Tax lots, multi-currency, live vs backtest, risk alerts | POST `/tax/realized-gains`, `/portfolio/multi-currency`, `/live-vs-backtest`, `/risk-alerts` | request body | PARTIAL (UNIT; tax ROUTE; not tax advice) |
| Research dossier, NL query | POST `/research`, `/query` | rules / evidence in body | PARTIAL (UNIT; query ROUTE) |
| Voice page | `/static/assistant.html` | browser Web Speech API + `/query` | NOT RUN (JS syntax checked only) |
| Health Center | GET `/intel/health-center`; POST `/intel/health-center/verify`; page `/static/integration_health.html` | in-process state from real requests | PARTIAL (UNIT + ROUTE; page not run in a browser) |
| Provider health / probe | GET `/intel/providers`, `/intel/providers/health-log`; POST `/intel/providers/probe` | in-process | PARTIAL (UNIT + ROUTE) |
| Economic calendar | GET `/intel/calendar/economic` | FMP | BLOCKED until a live verification succeeds (ROUTE with fake FMP) |
| Readiness feed | GET `/intel/calendar/feed` | FMP -> Worker readiness format | BLOCKED until the Worker fetches it (UNIT + ROUTE incl. bearer auth) |
| Earnings calendar | GET `/intel/calendar/earnings` | FMP | BLOCKED (live) |
| Fundamentals | GET `/intel/fundamentals/{symbol}` | FMP profile/quote/income/key-metrics | BLOCKED (live); ROUTE incl. section independence |
| Event risk | GET `/intel/event-risk` | FMP | BLOCKED (live); UNIT + ROUTE |
| Token unlocks | GET `/intel/unlocks/{token_id}` | Tokenomist | BLOCKED (live); UNIT + ROUTE |
| Whale transfers | GET `/intel/whales/{blockchain}/{symbol}` | Whale Alert Enterprise REST | BLOCKED (needs the Enterprise plan + key); UNIT + ROUTE |
| Strategy marketplace | none | | NOT BUILT |

New environment variables: `FMP_API_KEY`, `TOKENOMIST_API_KEY`, `WHALE_ALERT_API_KEY` (optional), `EVENT_FEED_TOKEN`, `TOKENOMIST_CREDIT_RESERVE`.

## Verification status (honest)
- GitHub Actions `test` job (real dependency install, compileall, full pytest, `import app.main`): passed on PR #8 (analytics + providers, unit tests only). PR #9 added route-level tests which exposed a real defect (provider failures flattened to `upstream`); fixed on `main` in 5a2fdc9. CI results after later merges were not observed by the analytics author: confirm the latest `main` run is green.
- The Cloudflare "Workers Builds" check fails on PRs #7-#9 (predates this work); its log is only in the Cloudflare dashboard.
- No live provider request has been made by the author. After the keys are set on the deployed backend, open `/static/integration_health.html`, press "Verify now", or run `scripts/verify_deployment.py`; only then can an integration be called operational.

See `docs/PROVIDERS.md` for provider selection, pricing, limits, event-feed wiring and licence notes.

# ETI analytics: implementation matrix

See **[CAPABILITY_MAP.md](CAPABILITY_MAP.md)** for how the 31 requested items map onto existing ETI code.

Status key: **UNIT** = covered by offline unit tests (synthetic data or fake transport). **ROUTE** = also exercised through
FastAPI's TestClient against the real app with fake market/provider HTTP (`tests/test_analytics_api.py`). **NOT RUN LIVE** = never
executed against a live provider or exchange. Nothing below is classified PASS, because PASS requires verification against real data.

All routes are under `/api/analytics`. Auth: none for GET/compute routes; `POST /intel/providers/probe` needs `X-API-Key`;
`GET /intel/calendar/feed` needs `Authorization: Bearer $EVENT_FEED_TOKEN` (required when `APP_ENV` is production/staging).
CPU-heavy routes are bounded (Monte Carlo paths x horizon <= 2,000,000; walk-forward grid <= 60 combinations) and run in a worker thread.

| Capability | Method + route | Provider / data | Status |
|---|---|---|---|
| Scan + ranking + watchlist | GET `/scan` | MarketService candles (Binance/Alpaca) | PARTIAL (UNIT + ROUTE with fake candles; NOT RUN LIVE) |
| Regime | GET `/regime` | MarketService | PARTIAL (UNIT + ROUTE) |
| Unusual volume | GET `/unusual-volume` | MarketService | PARTIAL (UNIT) |
| Volatility breakout | GET `/volatility-breakout` | MarketService | PARTIAL (UNIT) |
| Correlation | GET `/correlation` | MarketService | PARTIAL (UNIT + ROUTE) |
| Monte Carlo | GET `/monte-carlo` | MarketService | PARTIAL (UNIT + ROUTE incl. size limit) |
| Stress / scenarios | POST `/stress`, `/scenario`; GET `/stress/scenarios` | request body | PARTIAL (UNIT + ROUTE) |
| Walk-forward | POST `/walk-forward` | MarketService | PARTIAL (UNIT + ROUTE incl. grid limit) |
| Strategy lab | POST `/strategy-lab/compare` | MarketService | PARTIAL (UNIT) |
| Tax lots / CSV | POST `/tax/realized-gains` | request body | PARTIAL (UNIT + ROUTE; not tax advice) |
| Multi-currency | POST `/portfolio/multi-currency` | caller FX rates | PARTIAL (UNIT) |
| Live vs backtest | POST `/live-vs-backtest` | request body | PARTIAL (UNIT) |
| Risk alerts | POST `/risk-alerts` | request body | PARTIAL (UNIT) |
| Research dossier | POST `/research` | evidence in body + optional candles | PARTIAL (UNIT) |
| NL query router | POST `/query` | none (rules) | PARTIAL (UNIT + ROUTE) |
| Voice page | static `/static/assistant.html` | browser Web Speech API + `/query` | NOT RUN (JS syntax checked only) |
| Provider health | GET `/intel/providers`, `/intel/providers/health-log` | in-process | PARTIAL (UNIT + ROUTE) |
| Provider probe | POST `/intel/providers/probe` | FMP, Tokenomist (live) | BLOCKED until keys are set |
| Economic calendar | GET `/intel/calendar/economic` | FMP | BLOCKED (ROUTE with fake FMP; no key verified) |
| Readiness feed | GET `/intel/calendar/feed` | FMP -> Worker readiness format | BLOCKED (UNIT + ROUTE incl. bearer auth) |
| Earnings calendar | GET `/intel/calendar/earnings` | FMP | BLOCKED |
| Event risk | GET `/intel/event-risk` | FMP | BLOCKED (UNIT + ROUTE with fake FMP) |
| Token unlocks | GET `/intel/unlocks/{token_id}` | Tokenomist | BLOCKED (UNIT + ROUTE with fake Tokenomist) |
| Whale Alert adapter | none | Whale Alert | NOT BUILT (existing on-chain whale analysis: `app/alpha/whales.py`) |
| Strategy marketplace | none | | NOT BUILT |

Dependencies: Python stdlib only for `app/analytics`; `httpx` (already in requirements) for providers; `pydantic-settings` for provider env.
New environment variables: `FMP_API_KEY`, `TOKENOMIST_API_KEY`, `EVENT_FEED_TOKEN`, `TOKENOMIST_CREDIT_RESERVE`, `WHALE_ALERT_API_KEY` (reserved).

## Verification status (honest)
- GitHub Actions `test` job (real dependency install, compileall, full pytest, `import app.main`): passed on PR #8, which already contained the analytics and provider code (unit tests only).
- PR #9 added the route-level tests; they exposed a real defect (provider failures flattened to a generic `upstream` error, so an unconfigured provider returned 502 instead of 503 `not_configured`). That was fixed on `main` in commit 5a2fdc9. The result of CI after that fix has not been observed by the analytics author; confirm the latest `main` run is green.
- The Cloudflare "Workers Builds" check fails on PRs #7, #8 and #9 (it predates this work); its log is only in the Cloudflare dashboard.
- No live provider or exchange request has been made. Live evidence: `PYTHONPATH=. python scripts/live_provider_check.py` with the keys, or the workflow template in `docs/live-provider-check.workflow.yml`.

## Endpoint test plan against live data
For each route: data compared with the provider's own site for 3 sample events/tokens; response time recorded; provider errors surface as the documented 4xx/5xx; quota consumption checked (`GET /intel/providers`).

See `docs/PROVIDERS.md` for provider selection, pricing, limits and licence notes.

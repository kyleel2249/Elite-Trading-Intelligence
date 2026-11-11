# ETI analytics: implementation matrix

Status key: **UNIT** = covered by offline unit tests (synthetic data or fake transport; run in the author's sandbox 2026-11-11, 41/41 passing).
**NOT RUN LIVE** = never executed against a running server or a live provider. Nothing below is classified PASS yet, because
PASS requires verification against real data.

All routes are under `/api/analytics`. Auth: none for GET/compute routes; `POST /intel/providers/probe` needs `X-API-Key`.

| Capability | Method + route | Provider / data | Status |
|---|---|---|---|
| Scan + ranking + watchlist | GET `/scan` | MarketService candles (Binance/Alpaca) | PARTIAL (UNIT logic; route NOT RUN LIVE) |
| Regime | GET `/regime` | MarketService | PARTIAL |
| Unusual volume | GET `/unusual-volume` | MarketService | PARTIAL |
| Volatility breakout | GET `/volatility-breakout` | MarketService | PARTIAL |
| Correlation | GET `/correlation` | MarketService | PARTIAL |
| Monte Carlo | GET `/monte-carlo` | MarketService | PARTIAL |
| Stress / scenarios | POST `/stress`, `/scenario`; GET `/stress/scenarios` | request body | PARTIAL (UNIT) |
| Walk-forward | POST `/walk-forward` | MarketService | PARTIAL |
| Strategy lab | POST `/strategy-lab/compare` | MarketService | PARTIAL |
| Tax lots / CSV | POST `/tax/realized-gains` | request body | PARTIAL (UNIT; not tax advice) |
| Multi-currency | POST `/portfolio/multi-currency` | caller FX rates | PARTIAL (UNIT) |
| Live vs backtest | POST `/live-vs-backtest` | request body | PARTIAL (UNIT) |
| Risk alerts | POST `/risk-alerts` | request body | PARTIAL (UNIT) |
| Research dossier | POST `/research` | evidence in body + optional candles | PARTIAL |
| NL query router | POST `/query` | none (rules) | PARTIAL (UNIT) |
| Provider health | GET `/intel/providers`, `/intel/providers/health-log` | in-process | PARTIAL (UNIT of health logic) |
| Provider probe | POST `/intel/providers/probe` | FMP, Tokenomist (live) | BLOCKED until keys are set |
| Economic calendar | GET `/intel/calendar/economic` | FMP | BLOCKED (no key verified) |
| Earnings calendar | GET `/intel/calendar/earnings` | FMP | BLOCKED |
| Event risk | GET `/intel/event-risk` | FMP | BLOCKED (logic UNIT) |
| Token unlocks | GET `/intel/unlocks/{token_id}` | Tokenomist | BLOCKED (logic UNIT) |
| Whale activity | none | Whale Alert (selected) | NOT BUILT |
| Institutional holdings | none as analytics (Quiver exists for ticker context in the Council) | | NOT BUILT |
| Multi-account, marketplace, AI reports, voice, replay endpoint | none | | NOT BUILT |

Dependencies: Python stdlib only for `app/analytics`; `httpx` (already in requirements) for providers; `pydantic-settings` for provider env.
New environment variables: `FMP_API_KEY`, `TOKENOMIST_API_KEY`, `WHALE_ALERT_API_KEY` (reserved), `TOKENOMIST_CREDIT_RESERVE`.

## Verification status (honest)
- The authoring sandbox has no network and cannot install packages, so FastAPI, the app import, route registration, auth, response schemas, database interaction and every live provider call have **not** been executed by the author.
- Existing CI (`ci.yml`) runs compile, `pytest` and `from app.main import app` on each push to `main`; check its result for the commits that added `/api/analytics`.
- Live evidence: `PYTHONPATH=. python scripts/live_provider_check.py` with the two keys, or the workflow template in `docs/live-provider-check.workflow.yml`.

## Endpoint test plan (when a runnable environment exists)
For each route above: registered in `/openapi.json`; wrong method rejected; validation errors are 422; schema as documented; provider errors map to 4xx/5xx as in `app/api/intel.py`; response time recorded; data compared with the provider's own site for 3 sample events/tokens.

See `docs/PROVIDERS.md` for provider selection, pricing, limits and licence notes.

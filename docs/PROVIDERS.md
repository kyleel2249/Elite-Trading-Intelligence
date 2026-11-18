# Intelligence providers

Providers sit behind `app/providers/base.py` (`ProviderClient`): bounded retries with exponential backoff + full jitter
(honours `Retry-After`), a circuit breaker for outage-type failures only (5 consecutive; a rejected key or plan limit never opens it),
TTL cache, a client-side per-minute rate ceiling, per-provider health and a bounded health log, and secret redaction. Providers are
grouped by *capability* in `app/providers/registry.py`; adding a fallback = append another client to that capability's list.
Failover is automatic (`Capability.call`), reports `failover_attempts`, and preserves the real error kind (`not_configured` -> 503,
`auth`/`plan_restricted` -> 502). Providers are independent: one failing never disables the others.

Credentials are read only from backend environment variables (`app/providers/registry.py::ProviderSettings`). They are never sent to
the browser, never logged, and never included in error text. Set them as backend secrets, not in the repo.

| Integration | Provider | Env var | Used for |
|---|---|---|---|
| Calendar + fundamentals | Financial Modeling Prep (Stable API) | `FMP_API_KEY` | economic/earnings calendar, profile, quote, income statement, key metrics |
| Token unlocks | Tokenomist (API v5) | `TOKENOMIST_API_KEY` | token list, unlock events |
| Whale transfers | Whale Alert **Enterprise REST** | `WHALE_ALERT_API_KEY` (optional) | blockchain status, transactions |
| Event feed | ETI backend itself (see below) | `EVENT_FEED_TOKEN` (alias `ETI_EVENT_FEED_TOKEN`) | Worker readiness engine calendar |

## Event feed: what `EVENT_FEED_TOKEN` is
It is **not** a third-party credential. The Cloudflare Worker's readiness engine (`worker/readiness/events.ts`) fetches
`ETI_EVENT_FEED_URL` over HTTPS with `Authorization: Bearer $ETI_EVENT_FEED_TOKEN` (4 s timeout) and expects rows
`{title, time, impact, category, currency}`. ETI's backend serves exactly that at `GET /api/analytics/intel/calendar/feed`,
built from the FMP economic calendar, and checks the bearer token. So the token must be set to the **same value on both sides**:
backend `EVENT_FEED_TOKEN`; Worker secret `ETI_EVENT_FEED_TOKEN`; Worker var `ETI_EVENT_FEED_URL=https://<backend>/api/analytics/intel/calendar/feed`.
In production the feed refuses requests when no token is configured. It is reported "operational" only after the Worker has fetched
it successfully with the token.

## Integration Health Center
`/static/integration_health.html` (data: `GET /api/analytics/intel/health-center`). For each integration: status, last successful
retrieval, last error (kind only), data freshness, quota where the provider reports it (Tokenomist credits), request/failure/retry
counts, latency, and subscription access per endpoint. Statuses:
`unconfigured` (no credential) - `unverified` (credential present, no successful request yet) - `ok` (a real request succeeded) -
`unauthorized` (credential rejected) - `plan_restricted` - `degraded` - `down` (circuit open) - `stale` (no success for 24 h) -
`not_verified_by_worker` (feed token set, Worker has not fetched yet).
A present secret never produces `ok`. Configured providers are verified automatically in the background when the page is loaded
(FMP every 6 h, Whale Alert every 12 h, Tokenomist every 24 h because each verification costs 2 credits); `POST .../health-center/verify`
(API key) verifies immediately. State is in-process (resets on restart, per instance).
Deployment check: `ETI_BASE_URL=https://<backend> ETI_API_KEY=... python scripts/verify_deployment.py` (exit 0 only when every configured integration is `ok`).

## Selection record (researched 2026-11-12)

### FMP
- Endpoints (documented): `/stable/economic-calendar`, `/stable/earnings-calendar`, `/stable/profile`, `/stable/quote`, `/stable/income-statement`, `/stable/key-metrics`.
- Pricing as listed by third parties: Basic free (250 calls/day), Starter $22/mo, Premium $59/mo, Ultimate $149/mo. Which endpoints a plan allows differs, which is why the Health Center verifies each endpoint and reports `full`/`partial`/`none` access.
- No revision field; timestamps assumed UTC (unverified until a live response is checked).
- Fundamentals are exposed at `GET /intel/fundamentals/{symbol}` next to, not fused into, ETI's SEC-based screens (`app/alpha/fundamentals.py`), so the two sources can be cross-checked.
- Trading Economics was not evaluated in depth (second-provider candidate if revisions are needed).

### Tokenomist
- `https://api.tokenomist.ai`, header `x-api-key`; `GET /v5/token/list`, `GET /v5/unlock/events/{tokenId}`. Plans: Pro 1,000 credits/month, Standard 50,000, Elite 500,000; 120 requests/min. ETI stops spending at a 10% reserve (`TOKENOMIST_CREDIT_RESERVE`) and caps itself at 100 requests/min.
- **Licence: personal / non-commercial, non-redistribution.**
- Queried per token slug; the "all upcoming" endpoint path was not confirmed. CryptoRank was not evaluated (secondary candidate).

### Whale Alert
- Enterprise REST (`https://leviathan.whale-alert.io`, `?api_key=`): `GET /status`, `/{blockchain}/status`, `/{blockchain}/height_at_time/{ts}`, `/{blockchain}/transactions` (500 calls/min). ~$699/mo. The $29.95/mo Alerts plan is WebSocket only and is **not** supported by this adapter (a pure `normalize_alert()` exists for a future WebSocket collector); with that plan REST calls are reported `plan_restricted`.
- Reports transfers, not trades. Flows are classified `exchange_inflow`, `exchange_outflow`, `exchange_to_exchange`, `internal_exchange_transfer`, `wallet_to_wallet`, `mint`/`burn`/...; unattributed flows are excluded from exchange totals; **no buy/sell signal is produced**. Exchange detection relies on `owner_type` containing "exchange", whose full vocabulary is not documented, so treat classification as context until verified against live data.
- On-chain whale analysis from an explorer (`app/alpha/whales.py`) remains the key-free alternative.

## Safety rules
Provider data only informs risk and research. `corroborate()` marks single-provider data as unverified and never allows automation.
No endpoint here submits an order. This repo's providers have only been exercised against fake HTTP in tests; the Health Center is how real connectivity is proven on a deployed instance.

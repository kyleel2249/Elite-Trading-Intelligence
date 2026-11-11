# Intelligence providers

Providers sit behind `app/providers/base.py` (`ProviderClient`): bounded retries with exponential backoff + full jitter
(honours `Retry-After`), circuit breaker (5 consecutive failed calls, 60 s cool-down), TTL cache, per-provider health
(latency, retries, last success, latest data timestamp, quota) and a bounded health log, secret redaction. Providers are
grouped by *capability* in `app/providers/registry.py`; adding a fallback = append another client to that capability's
list. Failover is automatic (`Capability.call`) and reported in `failover_attempts`.

| Capability | Primary | Status | Credential |
|---|---|---|---|
| Economic + earnings calendar | Financial Modeling Prep (Stable API) | Adapter built, **not yet verified live** | `FMP_API_KEY` |
| Token unlocks | Tokenomist (API v5) | Adapter built, **not yet verified live** | `TOKENOMIST_API_KEY` |
| Whale / large transfers | existing `app/alpha/whales.py` (explorer + operator labels); Whale Alert optional | Whale Alert adapter **not built** | `WHALE_ALERT_API_KEY` (reserved) |

No key is stored in the repo. Verify live with `PYTHONPATH=. python scripts/live_provider_check.py`, or copy
`docs/live-provider-check.workflow.yml` to `.github/workflows/` and run it from Actions (needs the two secrets).
Until that passes, treat these as unverified. The repo's earlier provider code was also only exercised against mocks.

## Selection record (researched 2026-11-11)

### Calendar: FMP
- One key covers both economic and earnings calendars (`/stable/economic-calendar`, `/stable/earnings-calendar`; ranges up to 90 days).
- Pricing as listed by third parties: Basic free (250 calls/day), Starter $22/mo, Premium $59/mo, Ultimate $149/mo (billed annually).
  Sources disagree on whether calendars are in the free plan or need Premium ("corporate calendars"). **Unresolved**: the probe reports `plan_restricted` per endpoint if the plan is too low.
- Fields: date, country, event, currency, previous, estimate, actual, change, impact. **No revision field**, so revisions are not available from FMP. Central-bank/inflation/employment/GDP/rate categories are derived from event names by ETI.
- Timestamp timezone is not documented in what was reviewed; ETI assumes UTC and says so in every event.
- Trading Economics was not evaluated in depth (pricing/licence not reviewed); intended second provider if revisions or better central-bank coverage are needed.
- Integration with the existing readiness engine: `GET /api/analytics/intel/calendar/feed` emits the Worker's feed format (see `CAPABILITY_MAP.md` for wiring). Events with unrecognised impact are dropped, never defaulted.

### Token unlocks: Tokenomist
- Base `https://api.tokenomist.ai` (old `api.unlocks.app` still works), header `x-api-key`. Endpoints used: `GET /v5/token/list`, `GET /v5/unlock/events/{tokenId}` (paginated).
- Plans (docs): API included in Pro (1,000 credits/month, 1 y back / 1 y forward), Standard 50,000, Elite 500,000; 120 requests/min; every successful request costs a credit and each response reports `metadata.credit`. ETI stops spending at a 10% reserve (`TOKENOMIST_CREDIT_RESERVE`).
- **Licence: personal / non-commercial, non-redistribution.** Do not expose raw data to third parties.
- Linear unlock schedules, daily emission, allocations and fundraising endpoints exist but are not integrated; the v5 "upcoming across all tokens" path was not confirmed, so ETI queries per tracked token.
- CryptoRank was not evaluated; candidate secondary.

### Whale activity
- ETI already analyses on-chain transfers in `app/alpha/whales.py` (Etherscan-compatible explorer, operator-supplied labels, no hard-coded addresses, unlabelled addresses stay "unattributed"). That is the primary path; it needs the explorer settings and labels from the operator.
- Whale Alert is an optional paid upgrade: REST (transactions, exchange attribution, ~10 chains, 30 d history) is the $699/mo plan; the $29.95/mo Alerts plan is WebSocket only (100 alerts/hour, personal use). It reports transfers, not trades, so it cannot see DEX swaps and an exchange inflow is not proof of selling. No adapter is built; it would need a key and a verified response schema.

## Endpoints (all under `/api/analytics/intel`)
`GET /providers`, `GET /providers/health-log`, `POST /providers/probe` (API key), `GET /calendar/economic`, `GET /calendar/feed` (bearer), `GET /calendar/earnings`,
`GET /event-risk?symbol=`, `GET /unlocks/{token_id}`.

## Safety rules
Provider data only informs risk and research. `corroborate()` marks single-provider data as unverified and never allows automation.
No endpoint here submits an order.

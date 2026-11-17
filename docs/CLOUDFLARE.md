# Cloudflare-only deployment

ETI's Cloudflare-native edge build runs as a Cloudflare Worker. It serves the dashboard,
health endpoints, and public read-only market data UI. **No FastAPI origin or
BACKEND_URL is required for this build.**

## Deploy on the Cloudflare Workers Free plan

1. Connect this GitHub repository to Cloudflare Workers Builds, or deploy manually.
2. Set the project root to the repository root.
3. Build command: `npm install`
4. Deploy command: `npx wrangler deploy`
5. Ensure the Worker has Workers Free plan access and Workers Dev subdomain enabled.

### 1. Run the FastAPI app (origin)

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
cp .env.example .env
# edit .env: set API_KEY and DATABASE_URL (Postgres in production); keep APP_ENV=production
docker compose up --build -d
curl -s http://localhost:8000/api/system/health
```

Compose binds the origin to 127.0.0.1:8000 and forces APP_ENV=production. Expose it through a local HTTPS reverse proxy or Cloudflare Tunnel. A containerized proxy can use the Compose network.

### 2. Deploy the edge Worker (no Containers)

Workers Builds / local:

| Setting | Value |
|---------|--------|
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
Manual deployment:

```bash
npm install
npx wrangler deploy
```

Local preview:

```bash
npm install
npx wrangler dev
```

## Verify deployment

Replace the hostname with the Worker URL printed by Wrangler:

```bash
curl https://<worker>.<subdomain>.workers.dev/__eti/status
curl https://<worker>.<subdomain>.workers.dev/api/system/health
curl https://<worker>.<subdomain>.workers.dev/api/market/providers
```

The health response should include `"status":"ok"` and `"backend_required":false`.
The previous `BACKEND_URL is not set` error is removed because the Worker no longer
proxies requests to a separate origin.

## Public market data routing

ETI uses provider-specific transport rather than silently substituting another exchange:

- **Bybit:** public V5 REST requests are served from the Cloudflare Worker.
- **Bitget:** public REST requests are made directly from the user's browser through the same-origin `/bitget-client.js` adapter. Bitget returned HTTP 403 with a Cloudflare block response to both `api.bitget.com` and `capi.bitget.com` from the ETI Worker. A server-side retry cannot change that egress identity, so the dashboard no longer depends on Worker-to-Bitget public REST.
- **Bitget browser adapter:** tries the official V3 endpoints first, then the documented V2 public endpoints and official legacy host. It normalizes symbols, candles, order-book levels, trades, ticker and futures funding/open-interest context. It uses no exchange API key for public market data.
- **No cross-exchange substitution:** if the selected venue cannot be reached from the browser, ETI reports the feed as unavailable rather than displaying another venue's prices as Bitget data.

Browser-direct Bitget data depends on the user's network, browser CORS policy, exchange availability, region and rate limits. The dashboard polls REST snapshots; it is not an institutional low-latency feed. If a request fails, the UI must show the disconnected/partial state rather than present stale values as live. The Omnisignal analysis API accepts validated browser snapshots, then runs the analysis and risk checks in the Worker.

## Free-plan constraints and scope

- No paid Cloudflare Containers, Durable Objects, Workers Paid features, Fly.io, VPS,
  Railway, Render, or other application-hosting origin is required for this dashboard.
- Cloudflare Workers Free plan quotas and execution limits apply.
- Public browser market data is read-only. It does not place trades or expose private exchange credentials.
- Bybit market data is Worker-fetched; Bitget public data is browser-fetched because of the upstream Cloudflare egress block.
- Authenticated Bitget live order submission remains fail-closed until private API connectivity from the Worker is independently verified.
- The Worker continues to apply server-side execution authentication, audit, duplicate, quantity, leverage and kill-switch safeguards where an execution adapter is enabled.
- Cloudflare Workers Free quotas and browser network conditions apply; this build does not claim an always-on Bitget ingestion process when no user dashboard is open.

## Secrets and trading safety

Do not put broker credentials, Quiver tokens, Liquid API credentials, or exchange private
keys in browser code or public Worker variables. Store Bitget credentials only as Cloudflare
Worker secrets (`BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE`).

Public market-data requests do not require authentication. The browser adapter receives no
private key or passphrase. Bitget live orders require `ETI_BITGET_LIVE_ENABLED=true` and
`ETI_BITGET_EGRESS_VERIFIED=true`, plus the master execution token, audit KV and all
server-side safeguards. Leave the egress flag unset until private Bitget API connectivity
from the Worker is independently verified. No withdrawal, transfer or wallet-management
permissions or endpoints are enabled.

## Troubleshooting

| Symptom | Action |
|---|---|
| Build fails | Run `npm install` then `npm run check:worker`; inspect Wrangler output |
| Worker URL unavailable | Check Workers Builds deployment status and workers.dev setting |
| Market data unavailable | Check Bybit V5 REST and the user's browser access to Bitget public REST/CORS; inspect the UI's per-provider error |
| Bitget browser feed unavailable | Check `api.bitget.com` / `capi.bitget.com` reachability from the browser, CORS and regional access; never paste API secrets into the browser |
| BACKEND_URL error persists | Confirm Cloudflare is deploying the latest commit and correct Worker entry point |

## Deployment architecture

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set API_KEY in .env, or explicitly choose APP_ENV=development for local-only unauthenticated work.
uvicorn app.main:app --reload --port 8000
```

## Security

- Set `API_KEY` on the origin; send `X-API-Key` on POST routes.
- Keep `LIVE_TRADING_ENABLED=false` until keys and risk limits are verified.
- Quiver is research-only; never used for order placement.
- Worker only proxies HTTP; it does not hold trading secrets.

## Post-deploy checks
```text
Browser
  |-- HTTPS --> Cloudflare Worker (ETI dashboard + health APIs)
  |
  |-- HTTPS --> Bybit V5 public REST (Worker)
  |-- HTTPS --> Bitget V3/V2 public REST (browser-direct adapter)

No external FastAPI origin is used by this Cloudflare-native edge build.
```

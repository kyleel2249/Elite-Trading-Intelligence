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

## Live market data

The dashboard consumes Binance's public REST endpoints for initial candle and order-book
snapshots, then subscribes to Binance public WebSocket streams for trades, partial depth,
and kline updates. No exchange API key is required for these public market-data endpoints.

This is a browser-to-exchange data connection. It is not a Cloudflare-hosted exchange
feed or a guaranteed low-latency institutional feed. Exchange availability, regional
connectivity, rate limits, and browser network conditions apply. If the exchange stream
is disconnected, the UI must show the disconnected state rather than presenting stale
data as live.

## Free-plan constraints and scope

- No paid Cloudflare Containers, Durable Objects, Workers Paid features, Fly.io, VPS,
  Railway, Render, or other application-hosting origin is required for this dashboard.
- Cloudflare Workers Free plan quotas and execution limits apply.
- Public browser market data is read-only. It does not place trades.
- Full historical data storage, always-on ingestion, persistent background monitoring,
  and authenticated broker execution require separate design against the available
  Cloudflare free-plan quotas; they are not claimed by this dashboard build.
- Existing Python/FastAPI intelligence, portfolio, broker execution, investor-monitoring,
  Quiver Quant, and Liquid API modules have not all been ported by this edge-dashboard
  change. Do not represent those features as operational on this Worker until separately
  migrated and tested.

## Secrets and trading safety

Do not put broker credentials, Quiver tokens, Liquid API credentials, or exchange private
keys in browser code or public Worker variables. Use encrypted Worker secrets only for
server-side integrations that are actually implemented and required.

Public market-data routes do not require authentication. No withdrawal permission is
requested or supported. Live order execution remains disabled unless a separately
implemented, authenticated, risk-gated execution service is deployed and tested.

## Troubleshooting

| Symptom | Action |
|---|---|
| Build fails | Run `npm install` then `npm run check:worker`; inspect Wrangler output |
| Worker URL unavailable | Check Workers Builds deployment status and workers.dev setting |
| Market data unavailable | Check Binance API/WebSocket availability and local network access |
| WebSocket disconnects | UI should show disconnected/retrying; refresh and check exchange connectivity |
| BACKEND_URL error persists | Confirm Cloudflare is deploying the latest commit and correct Worker entry point |

## Deployment architecture

```text
Browser
  |-- HTTPS --> Cloudflare Worker (ETI dashboard + health APIs)
  |
  |-- HTTPS/WSS --> Binance public market-data API/streams

No external FastAPI origin is used by this Cloudflare-native edge build.
```

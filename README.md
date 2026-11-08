# ETI — Elite Trading Intelligence

ETI Cloudflare-native edge dashboard for live public market data.

## Cloudflare-only deployment

This deployment serves the ETI dashboard and health APIs directly from a Cloudflare Worker.
It does not require a FastAPI origin, Fly.io, Docker hosting, a VPS, or `BACKEND_URL`.

### Cloudflare Workers Builds

Connect this GitHub repository to Cloudflare Workers Builds and configure:

| Setting | Value |
|---|---|
| Root directory | `/` |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
| Entry point | `worker/index.ts` |

Use the Cloudflare Workers Free plan. Ensure the workers.dev subdomain is enabled.

### GitHub Actions deployment

Add these repository Actions secrets:

- `CLOUDFLARE_API_TOKEN` — token with permission to deploy Workers.
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.

Push to `main` or manually run **Deploy ETI to Cloudflare Workers**.

### Local development and checks

```bash
npm install
npm run check:worker
npm run dev
```

### Health checks

```bash
curl https://<worker>.<subdomain>.workers.dev/__eti/status
curl https://<worker>.<subdomain>.workers.dev/api/system/health
curl https://<worker>.<subdomain>.workers.dev/api/market/providers
```

The health endpoint should report `status: ok` and `backend_required: false`.

## Live market dashboard

The Worker serves:

- Live candlestick chart and selectable intervals.
- Order-book bid/ask depth and spread.
- Cumulative visible market depth.
- Recent executed trades with timestamps and side.
- Connection status and update timestamps.

The current market-data adapter uses Binance's public REST API for initial snapshots and
public WebSocket streams for live updates. It is read-only and does not require exchange
credentials. Exchange connectivity, browser networking, public API limits and stream
availability apply. The interface must not represent stale or disconnected data as live.

## Important feature boundary

This Cloudflare edge deployment is a working market dashboard foundation, not a completed
port of every legacy Python/FastAPI subsystem. Existing investor disclosure monitoring,
Quiver Quant, Liquid API, research workflows, persistent portfolios, background jobs and
authenticated order execution must be migrated separately into Cloudflare-compatible
services and individually tested before being advertised as available.

Persistent ingestion and always-on jobs must be designed against actual Workers Free plan
limits. Do not silently rely on paid Workers features, Containers, or an external host.

## Security

- Public market feeds are read-only.
- Do not expose API keys, broker credentials, Quiver tokens or Liquid API tokens in frontend
  JavaScript or public environment variables.
- Withdrawal permissions must never be requested, stored or enabled.
- Live trading remains disabled unless a separate authenticated and risk-gated execution
  implementation is explicitly deployed and tested.

## Documentation

See [Cloudflare deployment guide](docs/CLOUDFLARE.md).


## Broker execution — paper/testnet only

The Worker includes a server-side execution gateway for **Alpaca Paper** and **Binance Spot Testnet**. It has no live-trading code path. Both adapters submit only spot/equity buy or sell market/limit orders; advanced order types, cancel/replace, persistent audit history and portfolio reconciliation are not yet exposed.

Configure these as **Cloudflare Worker secrets**, never frontend variables or GitHub source files:

- `ETI_EXECUTION_TOKEN` — long random bearer token used by the trusted ETI client.
- `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` — Alpaca paper-account key pair only.
- `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` — Binance Spot Testnet key pair only.

Optional Worker variables: `ETI_MAX_ORDER_QUANTITY` (default 100) and `ETI_KILL_SWITCH` (set to `true` to reject orders). Each order requires a unique `clientOrderId`; requests without it are rejected. The gateway uses a fixed Alpaca paper URL and fixed Binance Spot Testnet URL. It does not offer a live-mode switch, and never calls withdrawal, transfer, funding or wallet-management endpoints.

Authenticated order request:

```http
POST /api/orders
Authorization: Bearer <ETI_EXECUTION_TOKEN>
Content-Type: application/json

{"broker":"alpaca","symbol":"AAPL","side":"buy","type":"limit","quantity":1,"limitPrice":150,"clientOrderId":"eti-demo-000001","riskConfirmed":true}
```

For Binance use `"broker":"binance"` and a Binance Spot Testnet symbol such as `BTCUSDT`. Check `GET /api/execution/status` for configured adapters and kill-switch state. This endpoint intentionally reports paper/testnet-only mode.

**Before enabling order submission:** create paper/testnet API keys with trading-only permissions, disable withdrawals/transfers, and set the three credentials as Worker secrets using Wrangler or the Cloudflare dashboard. Never paste secrets into chat, commit them, or place them in browser code. The bearer token must be held only by a trusted authenticated backend/client; do not embed it in public dashboard JavaScript.

Live trading is not implemented or enabled. A future live-trading release must be a separately reviewed change with explicit activation, separate live credentials, per-order confirmation and risk controls.


## Execution attribution, audit history and gated live mode

Every submitted order must include an `executionSource` object so the execution receipt identifies who or what initiated it:

```json
{
  "executionSource": {
    "actorType": "manual_user",
    "actorId": "authenticated-user-id",
    "sourceName": "ETI Order Console",
    "strategyId": null,
    "signalId": null,
    "triggerReason": "User approved the order preview"
  }
}
```

Supported `actorType` values: `manual_user`, `strategy`, `system`, `automation`. Strategy/system orders should include a meaningful `actorId`, `sourceName`, and, where applicable, `strategyId` and `signalId`. ETI writes a 90-day execution record to the `ETI_EXECUTION_LOG` KV namespace binding. The record includes UTC execution time, broker, paper/testnet/live mode, symbol, side, order type, quantity, client and broker order IDs, and source attribution. Retrieve records from authenticated `GET /api/execution/history`; this endpoint is for a trusted backend, not public browser JavaScript. Configure a Cloudflare KV namespace and bind it to the Worker as `ETI_EXECUTION_LOG`. Order submission fails closed if this audit binding is absent.

### Live trading is present but locked by default

A separate `POST /api/orders/live` route exists. It is not activated by the default deployment. Live submission requires **all** of the following:

1. Set Worker variable `ETI_LIVE_TRADING_ENABLED=true` only after paper/testnet validation and explicit owner authorization.
2. Add secret `ETI_LIVE_ACTIVATION_TOKEN` and send it as `X-ETI-Live-Authorization` on each live request.
3. Add separate live broker credentials as `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY`, `BINANCE_LIVE_API_KEY`, and `BINANCE_LIVE_SECRET_KEY`.
4. Submit to `/api/orders/live` with `riskConfirmed:true`, a unique client order ID and the required `executionSource`.
5. Keep the general `ETI_EXECUTION_TOKEN` authentication in place. The emergency `ETI_KILL_SWITCH=true` rejects both paper and live submissions.

Paper/testnet remains the default `POST /api/orders` route. Never enable withdrawals, transfers, or wallet-management permissions on any broker API key. Live trading has not been activated or validated by this repository change. The execution history endpoint stores audit records in KV for 90 days; configure backups/retention separately if longer regulatory retention is required.

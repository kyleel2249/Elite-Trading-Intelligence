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

The Worker includes a server-side execution gateway for **Alpaca Paper**, **Binance Spot Testnet**, and a separately locked live route. Live execution is not ready for activation: it now requires a reachable ETI FastAPI risk-preflight service, independent live credentials, an explicit per-order confirmation and server-side quantity/notional caps. The Worker does not expose withdrawal, transfer, funding or wallet-management endpoints.

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

### Live trading is locked pending integrated risk preflight

A separate `POST /api/orders/live` route exists. It is not activated by the default deployment. Live submission requires **all** of the following:

1. Set Worker variable `ETI_LIVE_TRADING_ENABLED=true` only after paper/testnet validation and explicit owner authorization.
2. Add secret `ETI_LIVE_ACTIVATION_TOKEN` and send it as `X-ETI-Live-Authorization` on each live request.
3. Add separate live broker credentials as `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY`, `BINANCE_LIVE_API_KEY`, and `BINANCE_LIVE_SECRET_KEY`.
4. Submit to `/api/orders/live` with `riskConfirmed:true`, a unique client order ID and the required `executionSource`.
5. Keep the general `ETI_EXECUTION_TOKEN` authentication in place. The emergency `ETI_KILL_SWITCH=true` rejects both paper and live submissions.
6. Configure `ETI_LIVE_MAX_NOTIONAL_USD` and `ETI_LIVE_MAX_ORDER_QUANTITY` as positive server-side Worker variables. Live orders fail closed if either cap is missing or invalid.
7. Live orders are limit-order only. The Worker rejects live market orders and rejects any quantity or `quantity × limitPrice` that exceeds the configured caps. This is a deterministic order-input cap, not a guarantee against gaps, slippage, exchange faults or losses.
8. Configure `ETI_RISK_GATE_URL` as the HTTPS URL of the deployed ETI FastAPI `/api/risk-gateway/preflight` endpoint, and `ETI_RISK_GATE_TOKEN` as a Worker secret matching the FastAPI `API_KEY`. The Worker sends every paper, testnet and live order to this service before contacting a broker. Missing, unreachable, unauthorized or rejected preflight blocks the order.
9. The FastAPI preflight derives equity, open positions, daily PnL, drawdown and quote freshness server-side, and attaches verified investor-disclosure context. It never submits an order. Until the FastAPI service is deployed, reachable and configured with synchronized live-account equity, live preflight will reject orders.

Paper/testnet remains the default `POST /api/orders` route. The Cloudflare Worker dashboard and Python/FastAPI intelligence service are separate deployable components: all order submission now requires the FastAPI service to be hosted at a stable HTTPS origin. The Cloudflare-only Worker deployment by itself does not host the Python portfolio/disclosure engine. Never enable withdrawals, transfers, or wallet-management permissions on any broker API key. Live trading has not been activated or validated by this repository change. The execution history endpoint stores audit records in KV for 90 days; configure backups/retention separately if longer regulatory retention is required.


## Elite-method signal engine (incremental release)

The Worker now exposes a read-only `GET /api/signals?symbol=BTCUSDT&interval=1h` endpoint and a searchable `GET /api/intelligence/traders` directory. The signal engine uses validated OHLCV candles from Binance/Bybit/OKX failover and computes EMA 20/50/200, RSI 14, MACD, ATR 14, ADX, Bollinger bands, relative volume and 20-candle breakout levels. It returns BUY, SELL or WAIT; a reference entry; ATR-derived stop; and 1R, 2R and 3R targets.

The displayed score is a **heuristic confluence score, not a probability**. The historical win rate is a walk-forward candle replay using non-overlapping samples and a conservative stop-first rule. It is withheld unless at least 20 samples are available. Simulation excludes fees, slippage, funding and market impact, so it is not a live expected win rate. A signal endpoint rejects stale candles and returns no recommendation if market data is unavailable.

The trader directory records documented high-level public principles and maps only testable ideas to indicators. It explicitly does not claim access to private algorithms (including Renaissance Technologies / D. E. Shaw methods), undocumented entry rules, or unsupported win rates/returns. Fundamentals, macro event calendars, portfolio optimization, continuous self-learning, broad multi-asset provider coverage, 3D UI, and a complete production deployment are separate workstreams and are not represented as finished by this signal-engine increment.

Example:
```bash
curl 'https://<worker>.<subdomain>.workers.dev/api/signals?symbol=BTCUSDT&interval=1h'
curl 'https://<worker>.<subdomain>.workers.dev/api/intelligence/traders?q=reflexivity'
```

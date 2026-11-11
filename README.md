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

`wrangler.jsonc` defines `build.command` (`node scripts/build-knowledge.mjs`), so every
`wrangler deploy` first generates `worker/knowledge.generated.json` from the Python knowledge
registry (`app/knowledge/*`). The generated file is not committed. If `python3` is unavailable the
generator writes an empty stub and the Worker serves its built-in profiles (`source: built-in-fallback`).

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

## Trade / no-trade intelligence: ETI Market Readiness Engine

`GET /api/readiness` (and the **ETI Market Readiness Engine** dashboard panel) decide whether trading is advisable now,
in a session, in a given hour, today or tomorrow, and can recommend **not trading** with reasons. Verdicts:
Favourable, Selectively favourable, Uncertain, High risk, Avoid trading. Twelve factors are evaluated; anything that cannot be
verified is reported as *not evaluated* and lowers the verdict. Crypto has live price data; US stocks use Alpaca market data when the Alpaca keys are set, Forex needs an operator-configured
price adapter (`ETI_FX_*`); without a feed those markets are schedule/calendar based only. An economic-calendar feed must be configured
(`ETI_EVENT_FEED_URL` / `ETI_EVENTS_JSON`); without it the calendar is reported as unverified. A favourable rating is never an
entry signal. See [docs/READINESS.md](docs/READINESS.md).

## Trade signals: ETI PRECISION SIGNAL ENGINE

`GET /api/precision/signal?symbol=BTCUSDT&strategy=intraday` returns one fully-specified, read-only result for a crypto spot pair:
BUY, SELL or NO TRADE, with entry/zone, stop, TP1-TP3, gross and net-of-cost reward-to-risk, estimated costs, higher-timeframe view,
justifications, news, liquidity, volatility, invalidation, expiry, timestamps, evidence and attribution. A 0-100 opportunity score
(research-priority bands, not probabilities) ranks setups, but about 18 hard risk gates decide whether one may be signalled: any
failed gate forces NO TRADE regardless of score. Confidence is qualitative unless a calibration model validated on held-out
outcomes exists. Fundamentals, news and expectancy are operator-supplied (token-protected admin routes); missing evidence is
reported as unavailable and caps the score. It cannot place orders. See [docs/PRECISION_ENGINE.md](docs/PRECISION_ENGINE.md).

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
- There is no live trading path: orders go only to Alpaca Paper and the Binance testnets.

## Multi-market intelligence

ETI classifies and adapts to forex, precious metals, crypto, stocks, indices, commodities, futures and options:
per-market trading hours (DST-correct), liquidity by time of day, spread/fee/slippage profiles, volatility-aware
sizing and market-adjusted risk limits that are enforced inside the `RiskEngine`. Open `/markets` or call
`/api/markets/assess?symbol=EURUSD`. Execution exists today only for crypto (Binance spot) and US stocks/ETFs
(Alpaca); metals, indices and commodities route through labelled ETF proxies; forex, non-US stocks, futures and
options are analysis-only until an adapter is added. See [docs/MARKETS.md](docs/MARKETS.md) for coverage, limits and API.

## Prediction tracking and accountability (FastAPI service)

The Python/FastAPI service keeps an **append-only prediction ledger**: every forecast is stored with its
server timestamp, asset, market, direction, entry reference, horizon, expected price range, probability,
reasoning, sources, invalidation criteria, regime and strategy. Outcomes are written once when the horizon
expires. Predictions and outcomes can never be updated or deleted (ORM guards plus SQLite/PostgreSQL
triggers), so failed predictions stay on record and forecasts are never rewritten after the result is known.

- Metrics: directional accuracy, price-target hit rate, mean error, Brier score, calibration, and breakdowns
  by asset, timeframe, market regime and strategy (`GET /api/predictions/metrics`).
- Monthly performance reports, published once after each month ends (`GET /api/predictions/reports`).
- Dashboard: `/predictions`. A background job scores matured predictions (`PREDICTION_RESOLVE_INTERVAL_SECONDS`).
- Run `alembic upgrade head` on existing databases (migration `0004_prediction_ledger`).

Statistics on small samples are flagged as unreliable; this is research output, not investment advice.
See [docs/PREDICTION_LEDGER.md](docs/PREDICTION_LEDGER.md).

## Documentation

See [Cloudflare deployment guide](docs/CLOUDFLARE.md), [multi-market guide](docs/MARKETS.md),
[prediction ledger guide](docs/PREDICTION_LEDGER.md) and [Precision signal engine](docs/PRECISION_ENGINE.md).


## Broker execution — paper/testnet only

The Worker includes a server-side execution handler for **Alpaca Paper** and the **Binance Spot Testnet**. Orders are validated by in-process safeguards (see "Paper / testnet execution and in-process safeguards" below); no separately deployed risk service is needed and there is no live route that submits orders. The Worker does not expose withdrawal, transfer, funding or wallet-management endpoints.

Configure these as **Cloudflare Worker secrets**, never frontend variables or GitHub source files:

- `ETI_EXECUTION_TOKEN` — long random bearer token used by the trusted ETI client.
- `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` — Alpaca paper-account key pair only.
- `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` — Binance Spot Testnet key pair only.

Optional Worker variables: `ETI_MAX_ORDER_QUANTITY` (default 100), `ETI_DUPLICATE_WINDOW_SECONDS` (default 60, 0 disables) and `ETI_KILL_SWITCH` (set to `true` to reject orders). Each order requires a unique `clientOrderId`; requests without it are rejected. The handler uses a fixed Alpaca paper URL and fixed Binance Spot Testnet URL. It does not offer a live-mode switch, and never calls withdrawal, transfer, funding or wallet-management endpoints.

Authenticated order request:

```http
POST /api/orders
Authorization: Bearer <ETI_EXECUTION_TOKEN>
Content-Type: application/json

{"broker":"alpaca","symbol":"AAPL","side":"buy","type":"limit","quantity":1,"limitPrice":150,"clientOrderId":"eti-demo-000001","riskConfirmed":true}
```

For Binance use `"broker":"binance"` and a Binance Spot Testnet symbol such as `BTCUSDT`. Check `GET /api/execution/status` for configured adapters, the safeguards in force and kill-switch state. This endpoint intentionally reports paper/testnet-only mode.

**Before enabling order submission:** create paper/testnet API keys with trading-only permissions, disable withdrawals/transfers, and set the three credentials as Worker secrets using Wrangler or the Cloudflare dashboard. Never paste secrets into chat, commit them, or place them in browser code. The bearer token must be held only by a trusted authenticated backend/client; do not embed it in public dashboard JavaScript.

Live trading is not implemented or enabled in this build.


## Paper execution, attribution and audit history

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

Supported `actorType` values: `manual_user`, `strategy`, `system`, `automation`. Strategy/system orders should include a meaningful `actorId`, `sourceName`, and, where applicable, `strategyId` and `signalId`. ETI writes a 90-day execution record to the `ETI_EXECUTION_LOG` KV namespace binding. The record includes UTC execution time, broker, paper/testnet mode, symbol, side, order type, quantity, client and broker order IDs, and source attribution. Retrieve records from authenticated `GET /api/execution/history`; this endpoint is for a trusted backend, not public browser JavaScript. Configure a Cloudflare KV namespace and bind it to the Worker as `ETI_EXECUTION_LOG`. Order submission fails closed if this audit binding is absent.

### Paper / testnet execution and in-process safeguards

ETI executes **paper and testnet orders only**: Alpaca Paper (`paper-api.alpaca.markets`) and the Binance Spot Testnet (`testnet.binance.vision`). There is no live order path in this build: `POST /api/orders/live` exists only to answer `423 live_trading_disabled`, no live broker host or live credential is referenced, and `ETI_LIVE_TRADING_ENABLED=true` is ignored (the status endpoint reports `live_flag_ignored`). No separately deployed risk service is required: `ETI_RISK_GATE_URL` and `ETI_RISK_GATE_TOKEN` are no longer read.

Every order is checked inside the Worker, in this order, before a broker is contacted. A refusal at any step never reaches the broker and is written to the audit log with the reason.

1. **Kill switch** (`ETI_KILL_SWITCH=true`) refuses everything with `423`.
2. **Bearer auth** (`ETI_EXECUTION_TOKEN`), and the `ETI_EXECUTION_LOG` KV binding must exist so every outcome can be audited.
3. **Valid order**: broker, symbol, buy/sell, market/limit, positive quantity, limit price rules, a unique `clientOrderId`, `riskConfirmed:true` and a complete `executionSource`.
4. **Quantity cap**: `ETI_MAX_ORDER_QUANTITY` (default 100).
5. **Broker configured**: paper/testnet credentials present.
6. **Duplicate protection**: a `clientOrderId` can be used once (it stays reserved when the broker's answer is ambiguous, so nothing is blindly re-sent), and an identical order from the same actor inside `ETI_DUPLICATE_WINDOW_SECONDS` (default 60) is refused.
7. **Market readiness** (`ETI_READINESS_GATE`): `advisory` (default) records the verdict, `enforce` blocks adverse conditions, `off` skips it.
8. **Paper balance and holdings**, read from the paper broker's own account: a BUY needs free cash (with a 0.1% buffer for limit orders and 1% for market orders), a SELL needs held quantity (no short selling through the spot endpoints). If the account cannot be read the order is refused (fail closed).

Outcomes are explicit: `executed` (broker order ID and status returned), `rejected` (refused by ETI, `broker_contacted:false`), `broker_rejected` (the paper broker answered 4xx; the ID is freed for correction) and `unknown` (timeout/5xx; the ID stays reserved, check the broker before retrying). `GET /api/execution/status` (public, no secrets) reports the safeguards in force; `GET /api/execution/history` (bearer) lists executed and refused orders, newest first, and the dashboard renders both.

The same checks cover every pathway: the dashboard Buy/Sell buttons, `POST /api/orders`, the Global Alpha executor and the agent execution route all call this one handler; futures testnet orders (`POST /api/futures/orders`) use the same kill switch, duplicate protection and refusal audit with their own hard limits. The simulated engine behind `/api/paper/*` applies its own in-process safeguards (kill switch, idempotency, position and loss limits, quantity cap, simulated free-cash check) and its scheduled cycle runs from the cron trigger (analyse-only unless `ETI_PAPER_AUTOEXECUTE=true`).

**Omnisignal execute (`POST /api/omnisignal/execute`)** works with no extra service: a BUY plan becomes an ordinary limit order for the same in-Worker flow (ETI Internal Paper, or Binance testnet) and is subject to every safeguard above; the plan's stop and targets are returned but the Worker does not place resting stop/take-profit orders. Optionally set `ETI_EXECUTION_API_URL` + `ETI_EXECUTION_API_TOKEN` to route plans to the Python execution engine instead, which adds per-account limits and protective OCO orders. **Retired settings:** `ETI_RISK_GATE_URL` / `ETI_RISK_GATE_TOKEN` are never read; a deployment that still has them keeps working and `/api/execution/status` reports `legacy_gateway_config_ignored: true` so they can be deleted. A test (`worker/execution.test.ts`) fails the build if any Worker source or config file starts depending on a risk gateway or a live-trading switch again.

The Python/FastAPI `POST /api/risk-gateway/preflight` endpoint still exists as an independent service of the Python application; the Cloudflare Worker neither calls nor requires it. Never enable withdrawals, transfers or wallet management with any key used here.


## Elite-method signal engine (incremental release)

The Worker now exposes a read-only `GET /api/signals?symbol=BTCUSDT&interval=1h` endpoint and a searchable `GET /api/intelligence/traders` directory. The signal engine uses validated OHLCV candles from Binance/Bybit/OKX failover and computes EMA 20/50/200, RSI 14, MACD, ATR 14, ADX, Bollinger bands, relative volume and 20-candle breakout levels. It returns BUY, SELL or WAIT; a reference entry; ATR-derived stop; and 1R, 2R and 3R targets.

The displayed score is a **heuristic confluence score, not a probability**. The historical win rate is a walk-forward candle replay using non-overlapping samples and a conservative stop-first rule. It is withheld unless at least 20 samples are available. Simulation excludes fees, slippage, funding and market impact, so it is not a live expected win rate. A signal endpoint rejects stale candles and returns no recommendation if market data is unavailable.

The trader directory records documented high-level public principles and maps only testable ideas to indicators. It explicitly does not claim access to private algorithms (including Renaissance Technologies / D. E. Shaw methods), undocumented entry rules, or unsupported win rates/returns. Fundamentals, macro event calendars, portfolio optimization, continuous self-learning, broad multi-asset provider coverage, 3D UI, and a complete production deployment are separate workstreams and are not represented as finished by this signal-engine increment.

Example:
```bash
curl 'https://<worker>.<subdomain>.workers.dev/api/signals?symbol=BTCUSDT&interval=1h'
curl 'https://<worker>.<subdomain>.workers.dev/api/intelligence/traders?q=reflexivity'
```


## Global Alpha Intelligence

Discovery, independent validation, strategy competition, investor-disclosure analysis, prediction accountability and risk-gated paper/testnet execution. Dashboard at `/alpha`, API under `/api/alpha`. See [docs/GLOBAL_ALPHA.md](docs/GLOBAL_ALPHA.md). Live execution is off by default and needs two operator flags plus a per-request confirmation.

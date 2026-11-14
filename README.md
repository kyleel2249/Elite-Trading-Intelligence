# ETI — Elite Trading Intelligence

Production-oriented multi-asset trading intelligence platform with a named elite desk, risk-gated paper/live paths, and probabilistic research tools.

**Repository:** https://github.com/kyleel2249/Elite-Trading-Intelligence  
**Branch:** `main`

## One-command local demo (Docker)

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
cp .env.example .env
# Optional: add Alpaca / Binance keys to .env
docker compose up --build
```

Open http://localhost:8000  · API docs http://localhost:8000/docs

Health: `curl -s localhost:8000/api/system/health | jq`

## Cloudflare (edge proxy only)

Cloudflare Workers **do not run** the Python app. Deploy FastAPI with Docker (above) or any host,
then optionally deploy the Worker as a reverse proxy:

```bash
npm install
npx wrangler deploy
npx wrangler secret put BACKEND_URL   # https://your-origin.example.com
```

Details and Workers Builds settings: [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md).

## Local Python (no Docker)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
pytest -q
```

## Elite Trading Desk

| Name | Title |
|------|--------|
| Adrian Cole | Chief Investment Strategist |
| Elena Varga | Technical Analysis Specialist |
| Marcus Okonkwo | Fundamental Analysis Specialist |
| Sofia Rahman | Macroeconomic Analyst |
| Kenji Mori | Quantitative Researcher |
| Nadia Petrova | Market Structure Analyst |
| Jamal Reed | Liquidity Analyst |
| Priya Nair | News and Sentiment Analyst |
| Lars Hagen | Predictive Intelligence Analyst |
| **Helena Frost** | Risk Management Officer (**veto**) |
| Omar Diallo | Execution Analyst |
| Claire Bennett | Portfolio Auditor |

Profiles & methods: `GET /api/intelligence/traders`

## Key APIs

| Area | Endpoints |
|------|-----------|
| Health | `GET /api/system/health` |
| Providers / streams | `GET /api/providers/status` |
| Market | `GET /api/market/snapshot`, `/order-book`, `/history` |
| Council | `GET /api/intelligence/council` |
| Forecast | `GET /api/intelligence/forecast` |
| Forecast accuracy | `POST /api/intelligence/forecast/score`, `GET /api/intelligence/forecast/accuracy` |
| Risk | `GET /api/risk/evaluate` |
| Trading | `POST /api/trading/order` |
| Paper portfolio | `GET /api/paper-trading/portfolio`, `/positions`, `/journal` |
| Reconcile | `POST /api/trading/reconcile` |
| MTM job | `GET /api/system/mtm-status`, `POST /api/system/mtm-run` |

## Authentication

Mutating routes (orders, reconcile, MTM run, strategy execution, monitor control) require the
`X-API-Key` header matching the `API_KEY` environment variable:

```bash
curl -X POST localhost:8000/api/trading/order \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"binance","environment":"paper","symbol":"BTCUSDT","side":"buy","qty":0.01}'
```

- **Local development** (`APP_ENV=development`): routes are open if `API_KEY` is unset.
- **Production / staging** (`APP_ENV=production|prod|staging`): if `API_KEY` is unset, protected routes
  refuse requests with HTTP 503 instead of running open. Set `APP_ENV` and `API_KEY` on the
  **FastAPI origin** (Docker/host). Optional Cloudflare Worker only proxies to `BACKEND_URL`
  (see `docs/CLOUDFLARE.md`); it does not run the Python app or hold broker secrets.
- **Live orders** are refused (HTTP 403) on any deployment without an `API_KEY`.

## Safety

- Live trading is **disabled by default** (`LIVE_TRADING_ENABLED=false`). When enabled, every order still passes **Helena Frost / RiskEngine** and requires an `API_KEY`
- Risk inputs are **server-derived**: equity, open positions, daily PnL, drawdown and data freshness come from the database and a server-fetched quote. Values sent in the order request body are ignored (the fields remain accepted but deprecated). Responses include `risk_inputs` showing what the risk engine used
- Paper equity = `PAPER_STARTING_EQUITY` + realized + unrealized PnL. Live equity must be configured via `LIVE_ACCOUNT_EQUITY`; until set, live orders are rejected
- Paper/testnet preferred defaults; secrets only via environment
- Forecasts are **probabilistic** (Lars Hagen) — not guarantees
- No withdrawal permissions requested

## Tests & CI

```bash
pytest -q
```

GitHub Actions runs compile + pytest on every push to `main`.

## Disclaimer

Research and trading software. Use at your own risk. Live trading can result in loss of capital.

## Security defaults and API compatibility

The application now defaults to `APP_ENV=production`. Configure `API_KEY` before using mutations or private portfolio, journal, and order-history reads. A missing configured key returns HTTP 503 on these routes; an incorrect or missing request header returns HTTP 401 when a key is configured. Only explicit `development`, `test`, or `local` mode permits a missing key. Unknown environment names and nonpositive job intervals are rejected.

Market snapshot, council, and forecast GET requests are read-only by default. Existing clients that need to save results must explicitly send `persist=true` and `X-API-Key`. Forecast scoring also requires the key; supplied prices must be positive and finite. Private reads use the same shared key, not per-user account permissions.

Dashboard keys now use tab-session storage instead of persistent local storage. Enter the key on the Command Centre or Alerts page in the same tab. Clearing that field clears the session key on the next request. Existing persistent keys are removed when a dashboard page loads. This does not protect keys from other same-origin JavaScript; do not host untrusted scripts on this origin.

Docker Compose binds port 8000 to host loopback and sets production mode. Use a local reverse proxy or tunnel for HTTPS. If a containerized reverse proxy needs direct access, connect it to the Compose network rather than exposing port 8000 publicly.

Run Python regressions with `python -m pytest -q`. Run offline Worker and dashboard regressions with `npm run test:security` using Node 22.6 or newer (Node 22 LTS recommended). No provider calls are made by those security tests.
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

## Daily report: ETI GLOBAL MARKET INTELLIGENCE

`GET /api/daily-report` (page: `/daily`) assembles one structured report for the trading day: 16 sections (global conditions, economic
developments, upcoming announcements, forex, gold and commodities, crypto, stocks, best opportunities, assets to avoid, volatility,
liquidity, session recommendations, high-risk periods, validated strategy candidates, portfolio risk, final readiness verdict) and an
opportunity table for EUR/USD, XAU/USD, BTC/USD and one selected stock. It is built only from ETI's own engines and live data: BUY or SELL appears
only for a validated setup, and anything that could not be measured (for example a forex or equities feed that is not connected, or a
missing economic calendar) is shown as unavailable and lowers the verdict. One report per UTC weekday is stored by the cron job when the
`ETI_EXECUTION_LOG` KV binding exists. Read-only; it cannot place orders. See [docs/DAILY_REPORT.md](docs/DAILY_REPORT.md).

## ETI Pro dashboard

`/pro` is a neon dashboard (market chart, trade signal, readiness, daily report, system and execution status) that renders only what the live
endpoints return: failed sources show as unavailable, stale data is flagged, and no sample balances, P/L or win rates are shown. Account
figures stay in the Command Centre (`/command`), which needs the paper-account token.

## Advanced market analysis engine

Technical, multi-timeframe, fundamental and news/sentiment engines feed a central intelligence layer at
`/api/analysis/*` (and an on-demand dashboard panel). See [docs/ANALYSIS_ENGINE.md](docs/ANALYSIS_ENGINE.md) for
methodology, endpoints, required secrets and limitations. It is analytical only and cannot place orders.

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
`/api/markets/assess?symbol=EURUSD`. Adapters: Binance (crypto), Alpaca (US stocks/ETFs/options) and OANDA (forex, spot
metals, index/commodity CFDs; practice account = paper, live double-gated). Routes whose provider has no credentials report
`needs_setup`; non-US stocks and futures stay analysis-only. Optional live calibration derives ATR, spread and volume from
real data, and the Cloudflare Worker serves the planning endpoints too (`/api/markets/*`). Provider adapters are tested
against fakes, not live accounts. See [docs/MARKETS.md](docs/MARKETS.md) for coverage, limits and API.

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

## ETI Autonomous Trade Journal

`/journal` and `/api/journal/*`: a permanent, append-only, hash-chained record of every analysis, order, refusal, cancellation, fill, closed trade (wins and losses) and evaluated prediction, plus manual trades and notes. Details, storage advice (use D1) and limits: [docs/TRADE_JOURNAL.md](docs/TRADE_JOURNAL.md).

## Documentation

See [Cloudflare deployment guide](docs/CLOUDFLARE.md), [multi-market guide](docs/MARKETS.md),
[prediction ledger guide](docs/PREDICTION_LEDGER.md), [Precision signal engine](docs/PRECISION_ENGINE.md)
and [Daily intelligence report](docs/DAILY_REPORT.md).


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

The project has no risk gateway anywhere: the Python app's former preflight endpoint is now `POST /api/pretrade/check`, a dry run of the in-process `RiskEngine` that nothing depends on. Never enable withdrawals, transfers or wallet management with any key used here.


## Profit & leverage calculator and chart trading

The dashboard has a **Profit & Leverage Calculator** (`/api/calc/position`, 1-150x, margin / quantity / risk-% sizing, estimated liquidation, fees,
net P&L and reward/risk, optional chart lines) and a **Trade from the chart** ticket: click the live chart to pick a price, then place a
limit or market order through the same confirmed, safeguarded paper/testnet flow as the Order Execution panel. See
[docs/CALCULATOR_AND_CHART_TRADING.md](docs/CALCULATOR_AND_CHART_TRADING.md). Liquidation figures are estimates; leverage magnifies losses.

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

Discovery, independent validation, strategy competition, investor-disclosure analysis, prediction accountability and paper/testnet execution through the in-process order safeguards. Dashboard at `/alpha`, API under `/api/alpha`. See [docs/GLOBAL_ALPHA.md](docs/GLOBAL_ALPHA.md). Live execution is not available: Alpha orders go through the same paper/testnet handler as every other path, and no live route exists.

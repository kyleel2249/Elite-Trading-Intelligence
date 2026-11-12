# API integration

Interactive schema: `GET /docs` (Swagger) and `GET /openapi.json` on the FastAPI service. This page covers the routes defined in `app/main.py` and how to extend ETI. Other routers (`app/api/*`, the prediction ledger, the Worker) are documented in their own docs and in OpenAPI.

## Authentication

Read routes are open. Mutating routes require the `X-API-Key` header matching `API_KEY` (constant-time comparison). In `production`/`prod`/`staging` with no `API_KEY` configured they fail closed with `503`; a wrong or missing key gives `401`. Live orders additionally return `403` when no `API_KEY` is configured. The Cloudflare Worker uses a bearer `ETI_EXECUTION_TOKEN` for `/api/orders` and `/api/execution/history` ([README](../README.md)).

## Core routes (FastAPI)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/system/health` | Status, version, live flag, provider config |
| GET | `/api/providers/status` | Provider health and job status; shows what is actually configured |
| GET | `/api/market/snapshot?provider=binance&symbol=BTCUSDT` | Quote with `data_status` (fresh/delayed/stale/invalid) |
| GET | `/api/market/order-book?symbol=&depth=1..100` | Depth, spread, imbalance |
| GET | `/api/market/history?provider=binance&symbol=&interval=1h&limit=1..1000` | Normalised OHLCV with quality flags; used by the 3D view |
| GET | `/api/intelligence/traders` | Documented trader/method profiles |
| GET | `/api/intelligence/council?symbol=` | Specialist analysis with risk veto |
| GET | `/api/intelligence/forecast?symbol=&horizon=` | Forecast; persisted forecasts are also written to the append-only ledger |
| POST | `/api/intelligence/forecast/score` | Score pending forecasts against a realised price |
| GET | `/api/risk/evaluate` | Demo evaluation of the risk engine |
| POST | `/api/trading/order` | **Key required.** Risk-gated order |
| POST | `/api/trading/reconcile` | **Key required.** Reconcile open orders with the broker |
| GET | `/api/paper-trading/{positions,portfolio,journal,history}` | Paper state |
| POST | `/api/system/{mtm-run,reconcile-run}` | **Key required.** Run jobs once |

### Order request

```json
{"provider":"binance","environment":"paper","symbol":"BTCUSDT","side":"buy","qty":0.01,
 "order_type":"limit","limit_price":50000,"thesis":"optional"}
```

`environment` is `paper`, `testnet` or `live`. Equity, open positions, PnL, drawdown and data age fields in the body are **deprecated and ignored**: the server derives them. The response includes the risk decision and `risk_inputs.source = "server"`.

```bash
curl -X POST $HOST/api/trading/order -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  -d '{"provider":"binance","environment":"paper","symbol":"BTCUSDT","side":"buy","qty":0.01}'
```

## Credentials and placeholders

All integrations are optional and read from the environment (`.env.example` is the placeholder template). Missing credentials make the provider report `not_configured`/`unavailable`; ETI never fakes a connection.

| Integration | Variables |
|---|---|
| Alpaca (paper by default) | `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER` |
| Binance (testnet by default) | `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `BINANCE_TESTNET_ENABLED` |
| Macro / news | `FRED_API_KEY`, `NEWSAPI_KEY` |
| Investor disclosures | `QUIVER_API_KEY` (research only, never execution) |
| Liquid | `LIQUID_API_KEY`, `LIQUID_API_BASE_URL` (only a URL you verified) |
| Execution engine | registered via `POST /api/execution/accounts`, stored encrypted with `EXECUTION_VAULT_KEY` |

Never request withdrawal permission on any key.

## Extending ETI

Read the existing module first and mirror its conventions and tests.

- **New exchange / broker**: add a client under `app/integrations/` and, for order routing, an adapter under `app/execution/adapters/`. Orders must keep flowing through `RiskEngine`; do not add a path that submits without it.
- **New strategy**: add to `app/strategies/` (see [STRATEGY_LIBRARY.md](STRATEGY_LIBRARY.md)). New strategies must pass the validation lab (out-of-sample, costs included) before paper use, and paper results before anything live.
- **New market / asset class**: extend `app/markets/` ([MARKETS.md](MARKETS.md)). Mark it analysis-only until an execution adapter and tests exist.
- **New API router**: create `app/api/<name>.py` with `router` and add it to the defensive loader list in `app/main.py`. `tests/test_repo_integrity.py` checks main keeps its routers.
- **New tables**: add models, import the module in `init_db()` (`app/database.py`) and add an Alembic revision that keeps a single head.
- **New AI model**: put it behind the council/specialist interface (`app/intelligence/`) so its output is a scored, attributable input and never a direct order.

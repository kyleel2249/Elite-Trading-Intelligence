# Testing

## What CI runs (`.github/workflows/ci.yml`)

Python job (3.12):

```bash
pip install -r requirements.txt
python -m compileall -q app tests
PYTHONPATH=. LIVE_TRADING_ENABLED=false ALPACA_PAPER=true BINANCE_TESTNET_ENABLED=true \
  BINANCE_LIVE_TRADING_ENABLED=false python -m pytest -q --tb=short
PYTHONPATH=. python -c "from app.main import app; print(app.title)"
```

Worker job (Node 22): `npm ci` then `npm run check` (unit tests with `node --test`, then a `wrangler deploy --dry-run` bundle check).

Run the same locally before pushing.

## Isolation

`tests/conftest.py` points `DATABASE_URL` at a fresh temp SQLite file and forces paper-safe flags (`LIVE_TRADING_ENABLED=false`, Alpaca paper, Binance live off). Tests that use `TestClient(app)` without a `with` block skip the lifespan, so no WebSockets or background jobs start. Keep it that way: tests must never reach a live broker.

## Where the coverage is

| Area | Tests |
|---|---|
| Risk engine and live gates | `test_risk_engine.py`, `test_risk_context.py`, `test_risk_rules_7_14_15.py`, `test_live_broker_gates.py`, `test_pretrade.py` |
| Paper engine and API | `test_paper_engine.py`, `test_paper_service.py`, `test_paper_sql_store.py`, `test_paper_api.py` |
| Execution engine / protective orders | `test_protective_execution.py`, `test_order_request.py`, `test_reconciler_unit.py` |
| Strategies and validation | `test_strategy_library.py`, `test_backtest.py`, `test_significance.py` |
| Market data and markets | `test_providers.py`, `test_market_quality.py`, `test_markets.py` |
| Signals / intelligence | `test_signals.py`, `test_council.py`, `test_predictive.py`, `test_knowledge*.py` |
| Prediction ledger | `test_prediction_ledger.py`, `test_prediction_ledger_ops.py`, `test_forecast_accuracy.py` |
| Alpha | `test_alpha_*.py` |
| Auth and security | `test_auth.py`, `test_no_risk_gateway.py` |
| Pages / integrity | `test_pages.py`, `test_repo_integrity.py`, `test_market3d_page.py` |

`test_repo_integrity.py` guards against forked Alembic heads and `app/main.py` losing routers. Add a migration only with a `down_revision` that keeps a single head.

## Adding tests for new work

- Risk and execution changes need a test for the **refusal** path as well as the approval path.
- Use fixed inputs; do not call live exchanges from tests. Stub providers.
- Anything that displays market data needs a test that stale or missing data is labelled, not shown as live.

## Manual verification before any live use

1. `GET /api/system/health` and `/api/providers/status` report what you expect (no provider shown connected without credentials).
2. Place a paper order, confirm it appears in the journal, then confirm a kill-switch order is refused (`KILL_SWITCH=true`).
3. Run the `testnet-verify` workflow or equivalent against exchange **testnets** with trade-only keys.
4. Confirm an order without `API_KEY` configured, or without live confirmation, is refused in a live configuration.
5. Run paper trading long enough, after fees and slippage, to have a statistically meaningful sample.

Automated tests cannot prove a strategy is profitable; they prove the safeguards and arithmetic behave as specified.

# Global Market Intelligence / Quant Engine

Adds a scanner, fair-value engine, mispricing detector, sentiment aggregator, opportunity ranker,
Kelly sizing and an idempotent execution engine on top of the existing ETI stack. Nothing existing
was replaced; predictions are written to the **existing** append-only prediction ledger.

## Safety changes to existing code
* `RiskEngine` now enforces a hard **6% single-position allocation cap** server-side
  (`qty * reference_price / equity`). Config can lower it, never raise it (clamped in `Settings`).
  Live orders with no reference price are rejected. Orders that only close an opposite position are exempt.
* `TradingService.place_order` and `/api/risk-gateway/preflight` now pass the reference price, so the cap
  applies on `/api/trading/order`, the preflight and the new execution path.
  **Behaviour change:** a paper order above 6% of equity is now rejected.
* Stop-loss risk per trade stays capped separately (`DEFAULT_RISK_PER_TRADE_PCT`, default 1%).

## New settings (all optional)
`MAX_POSITION_ALLOCATION_PCT` (<=6), `KELLY_FRACTION` (0.25-0.50), `MAX_TOTAL_EXPOSURE_PCT`,
`MAX_SECTOR_EXPOSURE_PCT`, `SCAN_ENABLED` (default false), `SCAN_INTERVAL_SECONDS` (600),
`SCAN_BINANCE_TOP_N` (1000), `SCAN_EQUITY_SYMBOLS` (comma list, needs Alpaca keys).

## Endpoints (`/api/quant/*`, page at `/quant`)
`GET overview | coverage | mispricing | fair-values | ledger | performance | execution/metrics | execution/orders | controls | scan/status`;
`POST kelly`; API-key protected: `POST evaluate | execute | scan/run | universe/reload | controls/kill-switch`.

## Design notes
* Kelly: `f* = (b*p - q)/b` with costs in `b`; `p` is replaced by a Wilson lower bound; fractional Kelly 0.25 default;
  the Kelly fraction is *capital at risk*, converted to notional via the stop distance, then
  `min(kelly, 6% cap, portfolio, sector, correlation, liquidity)`.
* Fair value: DCF, DDM, peer multiples, historical multiple (equity/ETF); protocol-revenue, NVT, TVL (crypto);
  carry / interest-parity (commodity/FX/futures). Models not valid for an asset class are dropped; fewer than two
  valid models, or large disagreement, => `supported=false`, no fair value.
  **Inputs must be supplied from a licensed data source via `/evaluate`; no fundamentals provider is wired in.**
* Mispricing > 8% is only a flag. `confirmed` requires every verification check to pass; unknown = not confirmed.
* Execution: idempotent `signal_id`, kill switch, auto-suspend (stale data, abnormal rejects), live gated by
  `LIVE_TRADING_ENABLED` + `API_KEY`, limit orders for live, states SUBMITTED/ACKNOWLEDGED/PARTIALLY_FILLED/FILLED/REJECTED/CANCELLED/FAILED.
  Provider bracket orders are not implemented: stop/TP are recorded and flagged `not_attached`.

## Verification status (be honest)
* Verified in an isolated sandbox: Kelly, mispricing, fair value, sentiment, scoring, controls, scanner, execution logic (76 tests,
  fixture providers). Fixture runs of 1,000 and 2,000 instruments complete; this proves logic, **not** provider throughput.
* Written but NOT executed here (no network, no FastAPI/SQLAlchemy in the sandbox): DB models, Alembic 0003, API router,
  scan job wiring, dashboard, Binance/Alpaca adapters, `tests/test_quant_risk_and_db.py`. Run `pytest` in CI first.
* Not done: real-provider load tests (use `scripts/scan_loadtest.py`), testnet execution runs, live news/social/on-chain
  sentiment connectors, options/derivatives data, Cloudflare Worker changes, bracket orders.
* Binance spot alone yields roughly 400-700 liquid USDT pairs; reaching 1,000-2,000 needs equities (Alpaca) or more providers.

# Futures (BUY / SELL / SHORT / COVER) — Binance USD-M **testnet only**

**Scope.** Perpetual-futures shorting is implemented against `https://testnet.binancefuture.com` (hard-coded; there is no live-futures path). Spot margin borrowing/shorting is **not** implemented. Spot `SELL` remains inventory-only.

## Actions (one-way position mode)
| Action | Meaning | Order |
|---|---|---|
| BUY | open/increase a long | limit, needs stopPrice |
| SELL | reduce/close a long | limit, **reduceOnly** |
| SHORT | open/increase a short | limit, needs stopPrice |
| COVER | reduce/close a short | limit, **reduceOnly** |

A plain order against an open position is rejected (`opposing_order_must_be_reduce_only`), so a SELL can never silently flip into a short. Hedge mode is rejected.

## Endpoints
* `GET /api/futures/status` – configuration flags (public).
* `GET /api/futures/positions` (bearer) – live positions with mark, exchange liquidation price, **liquidation distance %** and level (`warning` < 15 %, `critical` < 8 %). Point-in-time snapshot; the protective-stop monitor (below) also checks liquidation distance every minute.
* `GET /api/futures/reconcile` (bearer) – exchange positions and open orders compared with the ETI audit log; lists positions with no audited ETI futures order.
* `POST /api/futures/orders` (bearer) – gateway. Body: `symbol, side, quantity, limitPrice, leverage, reduceOnly, stopPrice, clientOrderId, riskConfirmed:true, executionSource, intent?`.
* `GET|POST /api/agents/futures/analyze` (bearer) – Commander analysis plus a `futuresPlan` (action, costs, liquidation estimate, blockers).
* `POST /api/agents/futures/execute` (bearer) – forwards the plan's ticket to the gateway only if the plan is eligible. Body adds `execution: { clientOrderId, riskConfirmed: true }`.
* `GET /api/futures/monitor` and `POST /api/futures/monitor/run` (bearer) – last protective-stop monitor result / run it now. `GET /agents/futures` is the read-only control page.

## Enabling (all required)
Worker secrets `BINANCE_FUTURES_API_KEY` / `BINANCE_FUTURES_SECRET_KEY` (testnet keys, **trade permission only, never withdrawal**), `ETI_EXECUTION_TOKEN`, the `ETI_EXECUTION_LOG` KV, optional `ETI_DUPLICATE_WINDOW_SECONDS` (default 60), `ETI_FUTURES_MAX_NOTIONAL_USD`, optional `ETI_FUTURES_MAX_LEVERAGE` (default 3, hard cap 5), and finally `ETI_FUTURES_ENABLED=true`. Without the flag every futures order returns 423.

## Controls (deterministic, final)
Kill switch; bearer token; audit log required; duplicate-order protection (a `clientOrderId` is used once; an identical rapid order is refused); account state, position, funding and mark price must all load; `canTrade`; leverage ≤ cap; order and total notional ≤ cap; limit within 2 % of mark; margin used ≤ 50 % of available balance; stop on the correct side; **estimated liquidation must lie beyond the stop by at least the entry-to-stop distance** (exchange-reported liquidation used when a position exists); extreme adverse funding (> 0.1 % / 8 h) rejected; existing positions must be isolated and at the same leverage. Margin type is set to ISOLATED and leverage set only when opening a new position.

**Exit policy.** SELL/COVER are risk-reducing. They skip entry-sizing vetoes (event hazard, open-risk budget, caps on leverage/notional) but still require the kill switch off, fresh market data, an existing opposite position, quantity ≤ position and a price near mark. Entries (BUY/SHORT) additionally need Commander consensus **and** Risk Manager approval, net reward:risk ≥ 2 after costs, and exchange-filter compliance.

**Costs.** Assumed 0.05 % taker fee per side, 5 bps slippage per side, 24 h hold; funding counted only when it is a cost. These are assumptions, not account-specific rates.

## Protective stops
The entry order does not carry a stop. The monitor (`worker/futures-monitor.ts`, every-minute cron, or on demand) places a `STOP_MARKET` (`closePosition`) for a position **ETI itself opened**, using the `stopPrice` stored with its audited entry order, and raises alerts instead of acting when no such record exists, the stop is already breached, open orders can't be read, or the kill switch is on. It never opens, increases or closes positions. See `docs/FUTURES_MONITOR.md`. There can be up to a minute between a fill and its stop, and a fast move can pass the stop level first.

## Known limits
* No external risk service is involved: every futures-specific limit (leverage, notional, margin, liquidation distance, funding) is enforced in-process in the Worker, together with duplicate protection and the kill switch. Refused orders never reach the exchange and are recorded under `reject:` in the audit log; executed orders under `order:`.
* Liquidation estimate uses a flat 0.5 % maintenance-margin rate; real tiers differ.
* Analysis uses spot candles/order book; funding and mark come from the futures venue.
* Equity is the futures wallet balance; daily PnL and drawdown are not derived.
* Binance testnet quirks (endpoint versions, rate limits, `closePosition` handling) were not verified against a live testnet account.

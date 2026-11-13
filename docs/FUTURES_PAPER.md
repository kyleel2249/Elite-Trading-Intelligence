# Futures / perpetuals paper simulation

Simulation only. It never reaches an exchange account. Every route needs `X-API-Key`; the global kill switch blocks new positions.

```
POST /api/futures-paper/accounts                         {account_id, starting_balance}
GET  /api/futures-paper/accounts/{id}                    wallet, margin, available, unrealized P&L, equity, open positions
POST /api/futures-paper/accounts/{id}/orders             {symbol, direction, capital_usdt, leverage 1-150, stop_price?, take_profit_price?}
POST /api/futures-paper/accounts/{id}/positions/{symbol}/close
POST /api/futures-paper/accounts/{id}/mark              re-price, charge funding, trigger stop / TP / liquidation
GET  /api/futures-paper/accounts/{id}/positions?status=open|closed|all
GET  /api/futures-paper/accounts/{id}/events            append-only audit log
```

Tables: `futures_paper_accounts`, `futures_paper_positions`, `futures_paper_events` (Alembic `0010_futures_paper`). Money is stored as exact decimal strings.

## Rules built in

- **Server-side prices only.** Binance USD-M `premiumIndex` mark price. The request cannot carry a price. If the feed is down, or Binance refuses the server's region, the call fails with 502; nothing is guessed.
- **Capital protection.** Leverage above 20x requires a stop-loss. The calculator's checks apply (stop on the wrong side, stop beyond liquidation, insufficient balance, take-profit on the wrong side). 150x is allowed but warned.
- **Isolated margin, one-way mode**, one open position per account and symbol (also enforced by a partial unique index). Cross margin is not simulated.
- **Liquidation** loses exactly the isolated margin. The wallet cannot go negative.
- **Accounting invariant** (tested): `wallet = starting + realized_gross - fees - funding`.
- **Optimistic concurrency** on the account row: concurrent writers get 409 rather than a lost update.

## What is estimated, not real

- Fills: mark price +/- 5 bps slippage, 5 bps taker fee per side (assumptions, not your exchange fee tier).
- Liquidation price: standard maintenance-margin model with a 0.5% default rate; real exchange tiers differ.
- Stops, take-profits and liquidations are checked only when `/mark` runs. A move between checks fills at the next observed price, which can be worse than the stop.
- Funding: charged for each 00/08/16 UTC boundary crossed since the last charge, using the feed's last funding rate at check time. Not charged (and reported) if the rate is unavailable.
- Quantities use a 0.000001 step; real instruments have their own filters.

Nothing runs `/mark` automatically yet: call it (or schedule a call) to keep positions current.

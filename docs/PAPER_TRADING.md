# Internal paper trading (no exchange credentials)

ETI can run simulated BUY/SELL trading with **no exchange API key, secret or separate risk service**. It is on by
default and is the dashboard's *Paper Trading* tab. Live trading stays disabled and is never a fallback.

## Modes (always labelled, never switched silently)

| Mode | What it is |
|---|---|
| **INTERNAL PAPER** (default) | Simulated by ETI against live Binance *public* order books. No credentials. No order ever leaves ETI. |
| **EXCHANGE TESTNET** | Optional. Orders go to an exchange sandbox through a registered execution account (credentials you supplied, see `docs/EXECUTION_ENGINE.md`). Market and limit only. |
| **LIVE TRADING** | Not available through this API. `mode=live` returns HTTP 403. |

If you request `exchange_testnet` and no testnet account/credentials exist, ETI serves the order with INTERNAL
PAPER and the response says so (`downgraded: true`, `reason`). Nothing is sent to an exchange.

## How fills are simulated

- A fresh order book is fetched for every order (stale >5 s, crossed, empty or spread >50 bps books are refused: no verified price, no fill).
- Market orders walk the book level by level (real slippage), capped at 50% of visible depth; any remainder is cancelled and the order is marked with a note. Extra 1 bps slippage is added.
- Limit orders that cross the book fill as taker (never worse than the limit); the rest rests and fills later as maker when the book reaches the price, again depth-capped, so partial fills are real.
- Stop-loss triggers when the bid <= stop and then sells at the market (gaps fill at the gap price). Take-profit triggers when the bid >= price and fills at or above it. Stop + take-profit can be placed as one OCO bracket. Triggers never fire on stale data.
- Fees: 10 bps taker and maker by default (`PAPER_TAKER_FEE_BPS`, `PAPER_MAKER_FEE_BPS`).

## Accounting

Average-cost, fee-inclusive. `equity - starting_cash == realized + unrealized` always holds (tested). Unrealized is marked at the best bid. Open buy limits reserve cash; open sells reserve holdings (an OCO pair reserves once). SELL can never exceed available holdings; BUY can never exceed available cash.

## Safety

Server-side validation; per-order, per-position and open-position limits; client-order-id idempotency and an identical-order window; `KILL_SWITCH` blocks new orders (cancel and flatten still work); every accepted/rejected order, fill, trigger and cancel is written to the append-only `paper_events` table. State is persisted per account (versioned JSON aggregate in `paper_accounts`) and survives restarts.

## API (`/api/paper`)

`GET /mode`, `GET /account`, `GET /quote?symbol=`, `POST /preview`, `POST /orders`, `POST /orders/bracket`, `DELETE /orders/{id}`, `POST /orders/cancel-all`, `GET /orders?status=open|closed`, `GET /fills`, `GET /events`, `POST /tick`, `POST /flatten` (confirm `FLATTEN <account>`), `POST /reset` (confirm `RESET <account>`).
Mutating routes use ETI's own `X-API-Key` where `APP_ENV` is production-like; that is not an exchange key.

## Autopilot (optional)

`PAPER_AUTOPILOT_ENABLED=true` scans `PAPER_AUTOPILOT_SYMBOLS` every `PAPER_AUTOPILOT_INTERVAL_SECONDS` with the Trading Council and places simulated trades (1% risk against a 2% stop, +4% take-profit bracket, only when confidence >= `PAPER_AUTOPILOT_MIN_CONFIDENCE` and no risk veto). A resting-order tick job always runs.

## Limits

- Key-free pricing covers Binance spot symbols (e.g. BTCUSDT). Equities/forex need a data provider with credentials and are refused rather than invented.
- Simulation is not a promise of live fills: no queue position, no hidden liquidity, no latency model beyond the 1 bps add-on.
- The older `/api/trading/order` (paper) path and its journal are unchanged; the dashboard now uses `/api/paper`.

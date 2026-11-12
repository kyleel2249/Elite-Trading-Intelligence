# Futures calculator (1x-150x)

A read-only, Decimal-arithmetic calculator and validator for leveraged perpetual / futures positions. Page: `/static/futures_calc.html`. API: `/api/futures-calc/*`. Code: `app/futures/calc.py`, `app/api/futures_calc.py`.

**It places no orders.** It has no broker, exchange or database dependency (a test enforces this). Existing futures execution is unchanged: Binance USD-M **testnet only**, leverage cap 3 (hard cap 5), see [FUTURES.md](FUTURES.md). Raising those caps or adding a live futures path is a separate, deliberate decision that needs verified exchange documentation, testnet evidence and its own tests; this change does not make it.

## Capital, margin, notional, quantity

| Term | Meaning |
|---|---|
| Capital | Funds you choose to allocate |
| Initial margin | Collateral committed = notional / leverage, **after** rounding quantity down to the order step (so margin <= capital) |
| Notional | Leveraged exposure = quantity x contract size x price (linear) |
| Quantity | Contracts actually orderable after step / contract rounding |

$1,000 at 20x on a $100,000 entry: notional $20,000, quantity 0.2, a 1% favourable move = $200 gross (20% on margin), not $20,000.

## Formulas

Linear: `gross = sign x (exit - entry) x base_qty`. Inverse (coin-margined): `gross = sign x notional_usd x (1/entry - 1/exit)` in coin, never the linear formula.
Net = gross - entry fee - exit fee - slippage - funding. Return on margin = net / initial margin. Slippage applies to taker sides only. Funding uses entry notional (constant-notional assumption) and is a cost to longs when the rate is positive.

Liquidation (isolated, one-way), with wallet balance WB = initial margin + added margin and maintenance rate/offset from the supplied tier (or flat rate):

- Linear long: `(N - WB - cum) / (qty x (1 - mmr))`; short: `(N + WB + cum) / (qty x (1 + mmr))`
- Inverse long: `N(1 + mmr) / (WB + N/entry)`; short: `N(1 - mmr) / (N/entry - WB)`

Cross margin needs `cross_wallet_balance`; without it the liquidation price is reported **unavailable**. Cross results assume other positions stay static.

**All liquidation figures are estimates and are labelled `authoritative: false`.** The exchange's own engine governs. If no tiers or rate are supplied a 0.5% maintenance rate is assumed and flagged.

## Rules checked (returned as `violations`; any one makes `valid: false`)

Leverage above the lowest of platform (150), exchange, account, policy or risk-tier limit (names which one); quantity/notional below minimums; prices not on the tick size (never silently rounded); liquidation at or beyond entry; stop on the wrong side or not triggering before liquidation; take-profit on the wrong side; policy minimum liquidation distance / risk-reward; insufficient balance for margin plus entry fee. If the exchange maximum leverage is not supplied, a `leverage_unverified` warning says the value is not checked against the exchange.

Risk class (low / moderate / high / extreme) is the worse of the leverage band (>=10 / >=50 / >=100) and the liquidation distance (<10% / <3% / <1%). 100x and above always carries the `extreme_leverage` warning.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/futures-calc/presets` | Leverage / movement / exposure presets |
| POST | `/api/futures-calc/preview` | Single position: sizing, P&L at target / stop / take-profits, costs, liquidation, risk, scenario table |
| POST | `/api/futures-calc/portfolio` | Up to 20 legs: totals, balance check, exposure by `correlation_group` |
| POST | `/api/futures-calc/allocate` | Equal / percentage / manual / risk-weighted split (never exceeds the total) |
| POST | `/api/futures-calc/exposure` | Conservative 10% / moderate 25% / aggressive 50% / maximum / custom of available balance |

Responses return numbers as exact decimal **strings**. Fees are in bps, funding and maintenance rates in percent. Example:

```bash
curl -X POST $HOST/api/futures-calc/preview -H 'Content-Type: application/json' \
  -d '{"direction":"long","capital":"1000","leverage":20,"entry_price":"100000","move_pct":"1",
       "taker_fee_bps":"0","slippage_bps":"0","limits":{"exchange_max_leverage":50}}'
```

## What this does NOT do (honest scope against the full specification)

Not implemented here: loading instruments, tiers, fees or funding history from an exchange; dated-futures contract specs beyond multiplier/value/tick/step; order placement, order types, fills and reconciliation for futures beyond the existing testnet gateway; changing leverage or margin mode on a live position; adding/removing isolated margin; paper-trading simulation of futures positions, funding, liquidation and partial fills; persistence (positions, orders, margin, funding, risk-event tables, migrations); portfolio, risk-manager and trade-journal synchronisation; AI-recommended allocation; correlation estimation; live futures trading; the full Futures Trading workspace with chart overlays, order book and position tables. Each needs exchange-specific verification and its own tests before being claimed.

## Tests

`tests/test_futures_calc.py` checks every formula against independently computed references (fractions / hand arithmetic): all preset leverages, long/short, fees, slippage, funding, rounding, tiers, isolated/cross/inverse liquidation, 150x, stops, scenarios, allocation, portfolio, API behaviour, and that no order route or broker import exists.

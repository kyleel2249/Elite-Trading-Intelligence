# Profit & leverage calculator and chart trading

## Profit & leverage calculator
`POST|GET /api/calc/position` (and the **Profit & Leverage Calculator** panel on the dashboard) estimate a USDT-margined linear
contract trade with isolated margin. It is read-only and never places an order.

Inputs: side (long/short), entry, optional target and stop, leverage 1-150x, size by **margin**, **quantity** or **risk % of balance**
(risk sizing includes fees and requires a stop), taker fee (bps, default 5), maintenance margin % (default 0.5), optional funding.

Outputs: quantity, notional, margin, estimated liquidation price and distance, break-even including fees, entry and round-trip fees, and
for the target and stop: gross P&L, fees, funding, net P&L, ROI on margin and net reward/risk. Warnings are raised for leverage above
20x, a stop beyond the liquidation price, margin above the stated balance, reward/risk below 1 and fee drag.

Formulas: `notional = quantity x entry`, `margin = notional / leverage`; long liquidation `entry x (1 - 1/leverage + mmr)`, short
`entry x (1 + 1/leverage - mmr)`; net P&L = gross - fees on both legs - funding. **Liquidation is an estimate** (no fees paid, funding
accrued or tiered maintenance margins). Confirm with the exchange's own calculator. Leverage magnifies losses as well as profits.

The calculator can draw entry, target, stop and liquidation lines on the live chart, and "Send size to chart ticket" copies the
computed quantity and entry price into the chart ticket. ETI orders themselves remain unleveraged paper/testnet spot orders.

## Trading from the live chart
Click (or tap) the chart to pick a price; the price scale is read from the chart itself and a dashed line marks it. The **Trade from the
chart** ticket then offers Buy/Sell limit at that price and Buy/Sell market. A price can also be typed for keyboard use; Escape clears it.

These buttons fill the Order Execution fields and call the same `submitOrder` path: operator ID, preview, explicit confirmation, then
`POST /api/orders` with every in-Worker safeguard (kill switch, validation, limits, balance/holdings, duplicate protection, audit log).
Paper and testnet only; no real-money route exists. A buy limit below (or sell limit above) the market waits; the other way round it fills at
the market price, and the ticket says so.

## Verification
`worker/calc.test.ts` covers the maths, validation, HTTP behaviour and the dashboard wiring. The chart click -> price mapping, ticket ->
order body and calculator -> chart lines flows were additionally driven in jsdom against the real handlers (not committed: jsdom is not a
project dependency). Not verified: pixel layout on real devices and behaviour against the live exchange endpoints.

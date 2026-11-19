# Spot and futures profit-target calculator

The dashboard calculator supports both spot and linear futures/perpetual planning.

## Target-driven calculation

Choose either:
- **Net profit amount** in the account/quote currency; or
- **Net return (%)** on invested spot capital or allocated futures margin.

With a target amount or percentage, the calculator derives the required exit price and favourable price movement from the entry price, position size, leverage, fees, slippage and funding assumptions. It also displays estimated net P&L and the return on margin/capital.

## Spot versus futures

- **Spot:** long-only, unleveraged (1x). A percentage target is measured against invested capital. No liquidation or funding is applied.
- **Futures / perpetual:** long or short, configurable leverage. A percentage target is measured against allocated margin. The calculation includes the configured fees, slippage and funding assumptions, plus the existing estimated liquidation and risk checks.

Use the fee and slippage rates that apply to the selected exchange, account tier, pair and order type. Funding is an estimate based on the total funding percentage supplied; it can change before execution. The calculator does not fetch or guarantee current exchange fee tiers, order-book slippage, tick/quantity increments, or funding rates automatically.

## Execution boundary

The target calculator is a planning tool. Its shortcut can populate and submit only through the existing spot paper/testnet order flow; it explicitly blocks Futures mode and Bitget Live. It does not submit live orders or guarantee fills. The main order ticket remains a separate workflow with its own live-order safeguards. Use the dedicated futures order workflow for futures execution, and verify venue tick size, quantity step, minimum notional, margin mode and leverage limits before submitting.

All results are estimates. Actual fills, fees, slippage, funding, rounding and exchange risk rules can change realised P&L.

# Quiver Quant + Liquid integration notes

## Quiver Quant

- **Base:** `https://api.quiverquant.com`
- **Auth:** `Authorization: Bearer <QUIVER_API_KEY>`
- **Role in ETI:** research / disclosure intelligence only
- **Never:** place orders, override Helena Frost, treat delayed filings as live books

### Implemented paths

| Path | Method |
|------|--------|
| `/beta/live/congresstrading` | live congress |
| `/beta/historical/congresstrading/{ticker}` | hist congress |
| `/beta/live/governmentcontracts` | contracts |
| `/beta/live/lobbying` | lobbying |
| `/beta/historical/lobbying/{ticker}` | hist lobbying |
| `/beta/historical/insiders/{ticker}` | insiders (plan-gated) |
| `/beta/live/congress/politicians` | politicians |
| `/beta/live/congress_stock_holdings` | holdings estimates |

403 responses mean plan restriction — ETI surfaces `plan_restricted`, does not invent data.

### ETI routes

- `GET /api/data-intelligence/status`
- `GET /api/data-intelligence/quiver/congress`
- `GET /api/data-intelligence/quiver/contracts`
- `GET /api/data-intelligence/quiver/lobbying`
- `GET /api/data-intelligence/ticker/{ticker}`
- `POST /api/data-intelligence/monitor/scan` (requires API key)

## Liquid

Public research did **not** confirm a currently supported Quoine/Liquid *exchange* trading API suitable for automatic order routing in ETI.

ETI therefore:

1. Does **not** invent order/book endpoints.
2. Accepts optional `LIQUID_API_BASE_URL` + `LIQUID_API_KEY` for a **user-validated** probe only.
3. Sets `trading_supported: false` until endpoints are verified by the operator.
4. Never requests withdrawals.

Do not confuse with Liquid AI (`api.liquid.ai`) or Blockstream Liquid Network.

## Elite desk integration

- Adrian Cole — synthesis when alt-data attached to council
- Claire Bennett — monitor/audit
- Helena Frost — still absolute veto on orders
- Historical profiles (Soros, Buffett, Burry, …) inform **watchlist labels**, not copy-trading

# Quiver Quant & Liquid integration notes

## Quiver Quant (implemented)

- Base: `https://api.quiverquant.com`
- Auth: `Authorization: Bearer <QUIVER_API_KEY>`
- Docs: https://api.quiverquant.com/docs/authentication
- Probe: `GET /beta/live/congresstrading`
- Ticker history: `GET /beta/historical/congresstrading/{TICKER}`
- 401 = bad/missing key; 403 = plan does not include dataset
- **Research only** — never auto-trade from Quiver alone

Env: `QUIVER_API_KEY=`

## Liquid (status-only)

Research did **not** confirm an operational public **Liquid.com exchange** trading API comparable to Alpaca/Binance for ETI order routing.

Public products named "Liquid" include Liquid AI, Blockstream Liquid Network, and various DeFi APIs — **not** silently substituted.

Env (optional probe only):

```
LIQUID_API_BASE_URL=
LIQUID_API_KEY=
```

`trading_supported` remains `false` until endpoints are verified from official docs you provide.

**No withdrawal permissions** are ever requested.

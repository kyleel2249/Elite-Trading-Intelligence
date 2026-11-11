# Multi-market intelligence

`app/markets` gives ETI one modular layer that understands **forex, precious metals, crypto, stocks,
indices, commodities, futures and options**, and adapts sizing, costs and risk to each market's
trading hours, liquidity, volatility and transaction costs.

Surface: dashboard at `/markets`, API under `/api/markets/*`, and a hook inside the `RiskEngine`
so the limits apply to every real order, not just to the planning screen.

## What is real today (and what is not)

| Market | Classify, sessions, costs, sizing | Live quote | Order execution |
|---|---|---|---|
| Crypto (BTC, ETH, SOL, XRP, BNB, DOGE, 1000SATS, DeFi, memes, unknown tokens) | yes | Binance | Binance spot (testnet/paper; live stays gated) |
| US stocks / ETFs | yes | Alpaca (needs keys) | Alpaca (paper; live stays gated) |
| Metals (XAU, XAG, XPT, XPD) | yes | via ETF proxy (GLD/SLV/PPLT/PALL) | via ETF proxy only |
| Indices (SPX, NDX, DJI, FTSE, DAX, N225 ...) | yes | via ETF proxy where one exists (SPY/QQQ/DIA/IWM/EWU/EWG/EWJ) | via ETF proxy only |
| Commodities (crude, gas, grains, softs) | yes | via ETF proxy where one exists | via ETF proxy only |
| Forex (majors, minors, exotics) | yes | **no adapter** | **no adapter** |
| European / Asian / African stocks | yes | **no adapter** | **no adapter** |
| Futures, options | yes | **no adapter** | **no adapter** |

"No adapter" means ETI will classify the instrument, tell you whether the market is open, estimate costs
and size a position, and then report `verdict: analysis_only`. It will not invent a quote or pretend an
order can be placed. To add a market, register a `ProviderCapability` in `providers.py` and add a client under
`app/integrations`.

**ETF proxies are not the underlying.** GLD is not spot gold and USO is not WTI (roll decay). Proxy routes are
labelled `etf_proxy`, quotes carry `is_proxy: true`, and sizing for a proxy gives a notional to divide by the ETF
price, never a quantity in the underlying's units. Futures are never routed to ETFs (contracts are not shares).

## How ETI adapts to each market

* **Sessions** (`sessions.py`): each market has its own clock in its own time zone, converted with `zoneinfo`
  so US and EU daylight-saving dates are handled. Models forex Sun 17:00-Fri 17:00 New York, the 17:00-18:00
  metals/Globex break, Tokyo and Hong Kong lunch breaks, Egypt's Sunday-Thursday week, US extended hours and
  early closes, and 24/7 crypto.
* **Liquidity by time of day**: forex/metals liquidity follows which centres (Sydney, Tokyo, London, New York)
  are active; equities flag opening-volatility and closing-flow; crypto notes weekend thinning. Spreads are scaled
  by that liquidity unless you pass a measured spread.
* **Profiles** (`profiles.py`): spread, commission, slippage, typical daily move, gap risk and risk posture for
  each tier (forex major/minor/exotic, gold, silver, BTC/ETH, large cap, DeFi, meme, emerging, new listing,
  US mega-cap, developed, emerging and frontier stocks, indices, crude, gas, grains, softs, options).
  A token listed under 30 days (pass `listing_age_days`) is treated as a new listing; a thin US stock
  (pass `avg_daily_volume_usd`) is downgraded.
* **Sizing** (`assessment.py`): position size is the smallest of the risk budget, the market-adjusted notional
  cap and (if supplied) a share of daily volume. It handles pip/quote-currency conversion, futures and option
  multipliers, and reports when the minimum order is larger than your account allows.
* **Risk integration** (`app/risk/engine.py`): per-market multipliers only **tighten** the global limits
  (`MAX_POSITION_NOTIONAL_PCT`, `DEFAULT_RISK_PER_TRADE_PCT`); they never loosen them. A provider that cannot trade
  an asset class is rejected, live orders are rejected while the market is closed, and a failure in the market layer
  rejects the order (fail-closed). Unclassifiable or heuristic classifications warn but never hard-block.

## Honest limits

* Profile numbers are **planning defaults** (`source: planning_default`), not measured data. Real spreads, fees and
  volatility depend on your broker, venue, size and regime. Supply `measured_spread_bps`, `atr`, and
  `avg_daily_volume_usd` where you have them; replace the defaults with your broker's schedule before sizing for real.
* Holiday calendars exist only for NYSE and LSE (2026). Other markets report `holiday_calendar: not_applied`.
  Hours marked `schedule_confidence: approximate` (African exchanges, ASX, JSE, ICE softs, grains ...) are reference
  hours to verify with the exchange. Use `register_holidays()` to add calendars.
* African exchanges (JSE, NGX, GSE, EGX, NSE Kenya) are modelled for classification, hours, costs and risk. There is
  no data or trading access to them in this repository.
* `account_equity` in `/api/markets/assess` is a planning input only. Order approval still derives equity server-side.
* The Cloudflare Worker dashboard (`worker/`) is **not** extended by this change; it remains Binance-only. The market
  layer lives in the Python/FastAPI service.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/markets/overview` | Capability matrix, catalog counts, every market clock |
| `GET /api/markets/instruments?asset_class=&tier=&q=` | Curated catalog |
| `GET /api/markets/classify?symbol=` | Classify any symbol (`EUR/USD`, `XAUUSD`, `1000SATS`, `VOD.L`, `NGX:DANGCEM`, `CLZ6` ...) |
| `GET /api/markets/sessions?symbol=` or `?session_id=` | Market state, regime, next open/close |
| `GET /api/markets/profile?symbol=` | Liquidity, volatility, cost and risk profile |
| `GET /api/markets/assess?symbol=&price=&stop_price=&atr=...` | Full plan: verdict, costs, size, route, warnings |
| `GET /api/markets/snapshot?symbol=` | Live quote from the provider that can serve it (proxies labelled) |

Verdicts: `ready`, `caution`, `wait_for_session`, `analysis_only`, `blocked`. Nothing here submits an order.
`POST /api/pretrade/check` (a dry run of the in-process risk engine) additionally returns `market_context` and `warnings`.

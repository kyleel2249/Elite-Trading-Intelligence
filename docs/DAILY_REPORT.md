# ETI Daily Intelligence Report (ETI GLOBAL MARKET INTELLIGENCE)

A structured report for every trading day, served by the Worker.

| Route | Purpose |
|---|---|
| `GET /api/daily-report` | Today's report as JSON (16 sections, opportunity table, data quality, markdown copy). Cached 5 minutes. |
| `GET /api/daily-report?format=markdown` | Same report as markdown (`text/plain`). |
| `GET /api/daily-report?refresh=1` | Regenerate (at most once per 60 s; otherwise the cached copy is returned and `cache.refreshLimited` is true). |
| `GET /api/daily-report?date=YYYY-MM-DD` | A stored past report (needs the `ETI_EXECUTION_LOG` KV binding; kept 14 days). |
| `GET /api/daily-report/status` | Which inputs are connected, limits, schedule. |
| `GET /daily` | Page that renders the report. |

The report is read-only. It never places an order.

## Format

Sections 1-16 follow the specified order: global market conditions, major economic developments, upcoming announcements, forex, gold and commodities, crypto, stocks, best researched opportunities, assets to avoid, expected volatility, liquidity, session recommendations, high-risk periods, strongest validated strategy candidates, portfolio risk, final market-readiness verdict. The opportunity table has the columns Asset, Direction, Setup, Risk, ETI verdict for EUR/USD, XAU/USD, BTC/USD and a selected stock.

## Where the data comes from

| Asset | Source | Needs |
|---|---|---|
| BTC/USD | ETI Precision engine (hard risk gates) and Readiness engine on BTCUSDT spot (Binance/Bybit/OKX public APIs). USDT is a proxy for USD. | nothing |
| EUR/USD | Readiness engine + signal engine on candles from the operator FX adapter | `ETI_FX_CANDLES_URL` (optional `ETI_FX_QUOTE_URL`, `ETI_FX_DATA_TOKEN`) |
| XAU/USD | Same FX adapter asked for symbol `XAUUSD`; readiness is market level (forex schedule + USD calendar) | `ETI_FX_CANDLES_URL` |
| Stock | Readiness engine + signal engine on Alpaca IEX candles; best of the watchlist | `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`; `ETI_DAILY_STOCKS` (default `AAPL,MSFT,NVDA`) |
| Announcements | Operator-configured calendar | `ETI_EVENT_FEED_URL` and/or `ETI_EVENTS_JSON` |

Without a source the asset shows `N/A` and the report says why. ETI never invents prices, events or statistics, and a missing calendar caps the final verdict at UNCERTAIN. Other commodities (silver, oil, gas, copper) are reported as not assessed.

## What "validated" means

Only a validated setup may show BUY or SELL; everything else shows NO TRADE (or N/A when there is no data).

* Crypto: the Precision engine's `decision.tradeable` (all hard risk gates passed, net reward-to-risk after costs).
* Forex, gold, stocks: signal-engine conviction HIGH (|score| at least 55), latest candle no older than 3 hours, walk-forward replay with at least 20 resolved samples and a win rate above 50%. Replay excludes fees and slippage, and the report says costs are not included.
* In every case the asset's readiness verdict must not be HIGH RISK or AVOID TRADING.

The final verdict follows the most cautious assessed asset and is capped at UNCERTAIN when an asset could not be fully assessed or the calendar is unverified. Portfolio risk uses a planning risk per trade (`ETI_DAILY_RISK_PCT`, default 0.5%) and flags same-direction USD exposure across EUR/USD and XAU/USD.

## Scheduling and storage

The Worker's non-minute cron ticks run `runDailyReportCycle`: on UTC weekdays, from `ETI_DAILY_HOUR_UTC` (default 6), it generates and stores one report per day in `ETI_EXECUTION_LOG` (keys `daily:report:YYYY-MM-DD` and `daily:report:latest`). Set `ETI_DAILY_ENABLED=false` to turn it off.

## Subrequest budget

Each generation makes many upstream calls. Cloudflare limits subrequests per invocation (50 on the Free plan, 1000 on paid). The collector plans against `ETI_DAILY_SUBREQUEST_BUDGET` (default 44): calendar 1, BTC 19, EUR/USD 10, XAU/USD 2, each stock 10. With the default, one stock is evaluated and the other watchlist symbols are listed as deferred. Raise the budget on a paid plan to evaluate the whole watchlist. The estimates are conservative guesses, not measurements. CPU limits on the Free plan may also be too tight for the signal-engine replay.

## Tests

`npm test` runs `worker/daily.test.ts` (report assembly, setup validation rules, API, caching, KV storage, scheduler, route wrapper, offline degradation).

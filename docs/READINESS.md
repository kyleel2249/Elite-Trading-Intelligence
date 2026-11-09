# ETI Market Readiness Engine

Answers one question before any signal is considered: **is trading advisable at all** - now, in the next two hours,
in a given hour, in a session, today or tomorrow. "Do not trade" is a first-class answer.

Read-only and analytical. It never places orders and never grants itself permission to trade.

## Verdicts

`FAVOURABLE` / `SELECTIVELY FAVOURABLE` / `UNCERTAIN` / `HIGH RISK` / `AVOID TRADING`

Every verdict lists its reasons and a recommendation. A favourable verdict is **never an entry signal**: the
recommendation always requires a valid, confirmed setup. No session is assumed to be profitable.

### Decision rules
* Any *severe* factor (market closed, inside a high-impact blackout, abnormal market regime) -> `AVOID TRADING`.
* Any *adverse* factor (extreme volatility, unusable order book, nearby high-impact event, negative recorded expectancy) -> `HIGH RISK`.
* Two or more *caution* factors -> `UNCERTAIN`; one -> `SELECTIVELY FAVOURABLE`; none and >= 4 supportive factors with >= 7 of 12 evaluated -> `FAVOURABLE`.
* **A factor that cannot be measured is "not evaluated" and lowers the verdict, it is never assumed safe:**
  * no economic calendar connected -> capped at `SELECTIVELY FAVOURABLE`;
  * no live volatility / spread data for a live window -> capped at `UNCERTAIN`;
  * fewer than 5 of 12 factors evaluable -> capped at `UNCERTAIN`.
* Data outages only ever lower the verdict.

### The 12 factors
1 economic announcements - 2 expected volatility - 3 liquidity - 4 market structure - 5 current trends - 6 technical setups -
7 fundamental developments - 8 geopolitical risks - 9 correlations - 10 spreads and execution - 11 upcoming closures -
12 historical strategy performance in similar conditions.

### Event danger zones (high impact)
| Distance from release | Severity |
|---|---|
| within 30 min before/after | blackout (`AVOID TRADING`) |
| within 2 h before/after | `HIGH RISK` |
| within 4 h before/after | caution |

Medium impact: 15 min = high risk, 45 min = caution. For sessions and days (> 2 h), one high-impact release is a caution
that names the blackout hours; two or more releases, or any central-bank decision, make the window `HIGH RISK`.

## What is measured, and what is not

| Market | Price data | Evaluated |
|---|---|---|
| Crypto | Binance/Bybit/OKX public APIs (always on) | all 12 factors: ATR/regime volatility, order-book spread and slippage, 1h/4h/1d trend, validated setup, BTC/ETH correlation, ~40 days of hourly history for session/hour/weekday behaviour |
| US stocks / ETFs | **Alpaca Market Data (IEX feed)** when `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` are set; pass a US ticker as `symbol` | all factors except order-book depth (top-of-book spread only), SPY (QQQ for SPY) as correlation reference; NYSE hours, holidays and early closes |
| Forex | **operator-configured adapter** (`ETI_FX_CANDLES_URL`, optional `ETI_FX_QUOTE_URL`); pass a pair as `symbol` | volatility, trend, structure, setups and history from candles; spread only with the quote URL; no order-book depth; no correlation reference |
| Forex / equities without a feed (or without `symbol`) | none | FX-week open/close, sessions, holidays, closures, calendar events only. Verdict cannot be better than `UNCERTAIN` while open |

Notes on the non-crypto sources:
* **IEX volume is a fraction of consolidated volume.** Ratios are relative to the same symbol's own baseline, so they remain meaningful, absolute volumes do not.
* Equities are assessed against **regular NYSE hours only**; pre-market and after-hours are treated as closed.
* Many FX feeds carry no volume. Volume is then treated as *unknown* (never invented): liquidity is "not evaluated" and per-asset session ratings are `insufficient_data`.
* If the newest candle is stale, or the market is open but live data is missing, the verdict cannot be better than `UNCERTAIN`.
* Alpaca's free plan, rate limits and the exact response fields were implemented from its documented API and have only been exercised against mocks here.

Session/hour/weekday statistics are **measured activity** (range and volume relative to the asset's own weekday baseline,
directional efficiency) with sample sizes. They say nothing about profitability. Forex session fit is *structural*
(where each currency's home market trades) and is labelled as not measured.

Market clock rules (DST for US/UK/Sydney, NYSE and LSE holidays and early closes, Easter-based dates, FX week) are
computed from published rules, with unit tests at the switch instants. Rule-derived holidays cannot know one-off
closures; Tokyo public holidays are not built in.

## Configuration

| Name | Type | Purpose |
|---|---|---|
| `ETI_EVENT_FEED_URL` | Worker variable | HTTPS URL returning the event JSON below |
| `ETI_EVENT_FEED_TOKEN` | **Worker secret** | optional bearer token for the feed |
| `ETI_EVENTS_JSON` | Worker variable | inline events JSON (small lists, or for manual entry) |
| `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` | **Worker secrets** (existing) | also used read-only for US stock candles and quotes |
| `ETI_FX_CANDLES_URL` | Worker variable | HTTPS candle endpoint template using `{symbol}`, `{interval}` (1m,5m,15m,30m,1h,4h,1d,1w) and `{limit}` |
| `ETI_FX_QUOTE_URL` | Worker variable | optional HTTPS quote template using `{symbol}`; returns `{ "bid": n, "ask": n, "time": iso-or-epoch }` |
| `ETI_FX_DATA_TOKEN` | **Worker secret** | optional bearer token for both FX URLs |
| `ETI_EXECUTION_LOG` | KV binding (existing) | holds strategy evidence under `readiness:evidence:<SYMBOL>:<strategy>` |

ETI contains **no** calendar data and never invents events. Without a feed the calendar is reported as unverified.
The engine does not choose a calendar vendor for you; point `ETI_EVENT_FEED_URL` at a source you are licensed to use.

Event JSON (array, or `{ "events": [...] }`):
```json
[{ "title": "US CPI", "time": "2026-11-12T13:30:00Z", "impact": "high",
   "category": "economic", "currency": "USD" }]
```
`impact`: low|medium|high. `category`: economic, central_bank, geopolitical, fundamental, earnings, other.
Optional scoping: `currency`/`currencies`, `market(s)`, `symbol(s)`; unscoped events apply to everything. Malformed
rows are counted and rejected, never repaired. For USD-quoted crypto, USD events apply.

Geopolitical and fundamental factors read only `category: geopolitical|fundamental|earnings` items from this feed;
without a feed they are "not evaluated". Unscheduled shocks cannot be anticipated.

### Strategy evidence (factor 12)
The engine never fabricates a track record. Publish recorded trades from the replay lab:
```bash
node scripts/readiness-evidence.mjs --symbol BTCUSDT --strategy intraday --days 120 --out evidence.json
npx wrangler kv key put --binding ETI_EXECUTION_LOG "readiness:evidence:BTCUSDT:intraday" --path evidence.json
```
Results are bucketed by session and regime. Below 30 matching trades no win rate or expectancy is shown.

## API

```
GET /api/readiness?market=crypto&symbol=BTCUSDT&scope=now
GET /api/readiness?market=forex&symbol=EURUSD&scope=day&day=tomorrow
GET /api/readiness?market=crypto&scope=session&session=london
GET /api/readiness?market=crypto&scope=hour&hour=14          (UTC)
GET /api/readiness?...&format=text                            plain-text "ETI MARKET READINESS REPORT"
GET /api/readiness/sessions?market=crypto&symbols=BTCUSDT,ETHUSDT
GET /api/readiness/status
```
`session`: asian, london, new_york, london_ny_overlap, sydney. `day`: today, tomorrow or YYYY-MM-DD (up to 14 days ahead;
UTC day). Future windows use schedule, events and typical behaviour only; live conditions are not applied to them.

## Verification status
Covered by `worker/readiness.test.ts` (calendar rules, event zones, decisions, fail-safe behaviour, API with mocked
market data). **Not verified:** behaviour against live exchange, Alpaca and FX-provider responses and a real calendar feed (no
keys or network access to them from the build environment; only mocks were exercised), and Workers Free CPU headroom in production (about 3-4 ms for a full-day
report measured locally in Node).

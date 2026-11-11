# Multi-market intelligence

`app/markets` gives ETI one modular layer that understands **forex, precious metals, crypto, stocks,
indices, commodities, futures and options**, and adapts sizing, costs and risk to each market's
trading hours, liquidity, volatility and transaction costs.

Surface: dashboard at `/markets`, API under `/api/markets/*`, and a hook inside the `RiskEngine`
so the limits apply to every real order, not just to the planning screen.

## What is real today (and what is not)

Status vocabulary: **implemented** = code exists and is unit-tested against fakes; **verified live** = exercised against the
real provider. **Nothing here has been verified live**: the build environment could not reach Binance, Alpaca or OANDA, so
every provider adapter is tested against a fake HTTP transport (request shape, parsing, error handling), not a real account.
Do a paper/practice-account smoke test before trusting any of them.

| Market | Classify, sessions, costs, sizing | Live quote | Order execution |
|---|---|---|---|
| Crypto (BTC, ETH, SOL, XRP, BNB, DOGE, 1000SATS, DeFi, memes, unknown tokens) | yes | Binance | Binance spot (testnet/paper; live stays gated) |
| US stocks / ETFs | yes | Alpaca (needs keys) | Alpaca (paper; live stays gated) |
| US equity options (OCC symbols) | yes | Alpaca options snapshot (**format unverified**) | Alpaca (needs an options-approved account) |
| Forex (majors, minors, exotics) | yes | **OANDA** (needs token + account id) | OANDA practice = paper; live double-gated |
| Metals (XAU, XAG, XPT, XPD) | yes | OANDA spot; ETF proxy (GLD/SLV/PPLT/PALL) as second route | OANDA spot; ETF proxy |
| Indices (SPX, NDX, DJI, FTSE, DAX, N225, HSI, ASX200, Nifty ...) | yes | OANDA **CFD**; ETF proxy where one exists | OANDA CFD; ETF proxy |
| Commodities (crude, Brent, gas, corn, wheat, soy, sugar) | yes | OANDA **CFD**; ETF proxy where one exists | OANDA CFD; ETF proxy |
| Coffee, cocoa, cotton | yes | none (OANDA lists no CFD) | none |
| European / Asian / African stocks | yes | **no adapter** | **no adapter** |
| Futures | yes | **no adapter** | **no adapter** |

A route can exist in code yet be unusable until you add credentials. Every route reports `setup.configured`; when no
route's provider is configured the verdict is **`needs_setup`** and names the missing variables (`OANDA_API_TOKEN`,
`OANDA_ACCOUNT_ID`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`). "No adapter" means ETI classifies the instrument, says whether the
market is open, estimates costs, sizes a position, and reports `analysis_only`. It will not invent a quote or pretend an
order can be placed.

**OANDA** (`app/integrations/oanda`): v20 REST. The practice host is used for `environment=paper`; the live host is reachable
only for `environment=live` *and* `OANDA_LIVE_TRADING_ENABLED=true` (default false), on top of the RiskEngine's normal live
gates. Units and price precision come from the account's own `/instruments` list; a market the account does not list is
refused rather than guessed (CFDs are not offered to US accounts). A fill-or-kill order that OANDA cancels or rejects raises
an error and is never journaled as filled; only real fill prices are recorded; a non-tradeable quote becomes
`market_closed`, which the RiskEngine rejects for live orders. Orders are reconciled by client order id.

**CFD and ETF routes are not the underlying.** An OANDA index/commodity CFD tracks the underlying with financing costs and
OANDA's own hours. GLD is not spot gold and USO is not WTI (roll decay). Routes are labelled `cfd` / `etf_proxy`, quotes from a
proxy carry `is_proxy: true`, and sizing for a proxy gives a notional to divide by the ETF price, never a quantity in the
underlying's units. Futures are never routed to ETFs (contracts are not shares).

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

## Live calibration

`GET /api/markets/calibrated-assess` (and the "Use live calibration" box on `/markets`) replaces static baselines with
measured inputs from the routed provider: the quote price, **ATR(14, Wilder) on daily candles**, **spread from best
bid/ask**, and **average daily USD volume** (crypto and stocks). The `calibration` block lists what was used and what was
skipped and why. It never guesses: ETF-proxy routes are skipped (the ETF's volatility is not the underlying's), forex/CFD
volume is skipped (OANDA volume is a tick count, not turnover), unconfigured or failing providers fall back to baselines,
and any value you pass yourself wins. Alpaca stock bars use the IEX feed on free plans, so volume understates the market.

## Holiday calendars

Calendars live in `app/markets/data/holidays.json`, each entry with its source and a verification level, and are loaded
at import (a malformed file degrades to "no calendar", never to an error). `GET /api/markets/calendars` lists coverage.

| Market | Years | Verification |
|---|---|---|
| NYSE (incl. 13:00 early closes) | 2026-27 | official |
| Xetra | 2026-27 | official |
| TSE | 2026-27 | official |
| ASX (incl. 14:10 early closes on 24/31 Dec) | 2026-27 | official |
| SIX Swiss Exchange (from SIX's 2026 market-data availability table; not cross-checked against its trading-calendar PDF) | 2026 | secondary: verify |
| Ghana Stock Exchange (Interior Ministry declarations as reported; 6 Mar confirmed on mint.gov.gh; Boxing Day substitute not included) | 2026 | secondary: verify |
| Nairobi Securities Exchange (Eid dates from gazetted declarations; fixed holidays per the Act, not re-confirmed) | 2026 | secondary: verify |
| NSE India / BSE (weekday holidays; Muhurat session not modelled; moon-sighting dates can shift) | 2026 | official |
| Euronext: common closures only (Amsterdam, Brussels, Dublin, Lisbon, Paris); no venue-specific closures or 24/31 Dec half days | 2026-27 | official |
| LSE (12:30 early closes) | 2026-27 | secondary: verify |
| JSE | 2026 secondary, 2027 derived from statute rules and Easter | verify with the JSE |
| HKEX | 2026 | secondary: verify |
| **NGX, EGX, Milan/Madrid, SSE, KRX, CME/ICE** | none | `not_applied`: may be closed on a holiday ETI does not know |

EGX and NGX holidays are announced one event at a time (Islamic dates by moon sighting), so no reliable calendar exists to load. SSE and KRX official pages were not reachable from the build environment and only third-party lists turned up, which are not loaded.

`applied` = official, `partial` = secondary/derived. The JSE's official notice could not be fetched (robots.txt) and was
not circumvented. Add your own with `register_holidays()`.

## Cloudflare Worker

`worker/markets.ts` is a TypeScript port of the classifier, session engine, profiles, routing, sizing, assessment and risk
review, served at `/api/markets/{overview,instruments,classify,sessions,calendars,profile,assess,review}` (GET only).
Data tables are exported from Python (`python scripts/export_markets.py` -> `worker/markets.generated.json`), and the port
is checked against **Python-computed golden vectors** (`worker/markets.golden.json`: 70+ classifications, every session at 22
DST/holiday instants, 108 assessments, 24 risk reviews). `tests/test_markets_worker_sync.py` fails when those files are stale;
rerun the exporter after changing `app/markets`.

Not on the Worker: `/snapshot`, `/calibrated-assess`, the `/markets` page, and any OANDA/Alpaca-market-data adapter. Its order
path (Alpaca paper / Binance testnet / internal paper) now runs the market review before contacting a broker: a pairing the
broker cannot trade (a London stock on Alpaca, a stock on Binance) is refused with `market_review_rejected`, and warnings
(closed market, high-risk token) are stored on the audit record. Closed-market blocking applies only to live, which the Worker
does not offer. Its `setup.configured` flags only say whether the matching secrets exist in the Worker environment.

CME/ICE holiday calendars are not modelled: CME's published schedule is per product with early halts and its own page was not
machine-readable or self-consistent enough to encode safely.

## Honest limits

* Profile numbers are **planning defaults** (`source: planning_default`), not measured data. Use calibration, or pass
  `measured_spread_bps`, `atr`, `avg_daily_volume_usd`, and replace the defaults with your broker's schedule before sizing for real.
* **Nothing is verified against a live provider** (see top). OANDA, Alpaca-options and Binance paths are tested with fakes only.
* Non-US stocks (Europe, Asia, Africa) and futures have **no data or execution adapter**; they stay `analysis_only`.
  Access to African exchanges (JSE, NGX, GSE, EGX, NSE Kenya) needs a broker or data licence this repository cannot supply.
* NGX hours are 09:00-16:00 WAT since 27 April 2026 (earlier builds used 10:00-14:30, which was wrong), taken from the exchange's announcement relayed by Mondo Visione; auctions are not modelled.
* Hours marked `schedule_confidence: approximate` (African exchanges, ASX, JSE, ICE softs, grains ...) are reference hours to
  verify with the exchange; CME holiday schedules are not modelled.
* Forex sizing notional in the RiskEngine is computed as `qty x price`; for USD-base pairs (USDZAR) that is in the quote
  currency, so the cap is stricter than intended (safe direction, but conservative).
* `account_equity` in `/api/markets/assess` is a planning input only. Order approval derives equity server-side.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/markets/overview` | Capability matrix, catalog counts, every market clock |
| `GET /api/markets/instruments?asset_class=&tier=&q=` | Curated catalog |
| `GET /api/markets/classify?symbol=` | Classify any symbol (`EUR/USD`, `XAUUSD`, `1000SATS`, `VOD.L`, `NGX:DANGCEM`, `CLZ6` ...) |
| `GET /api/markets/sessions?symbol=` or `?session_id=` | Market state, regime, next open/close |
| `GET /api/markets/profile?symbol=` | Liquidity, volatility, cost and risk profile |
| `GET /api/markets/assess?symbol=&price=&stop_price=&atr=...` | Full plan: verdict, costs, size, route, warnings |
| `GET /api/markets/calibrated-assess?symbol=` | `assess` using measured price, ATR, spread and volume (see Live calibration) |
| `GET /api/markets/calendars` | Holiday-calendar coverage and provenance, plus markets with none |
| `GET /api/markets/snapshot?symbol=` | Live quote from the provider that can serve it (CFD/proxy labelled) |

<<<<<<< HEAD
Verdicts: `ready`, `caution`, `wait_for_session`, `analysis_only`, `blocked`. Nothing here submits an order.
`POST /api/pretrade/check` (a dry run of the in-process risk engine) additionally returns `market_context` and `warnings`.
=======
Verdicts: `ready`, `caution`, `wait_for_session`, `needs_setup`, `analysis_only`, `blocked`. Nothing here submits an order.
`POST /api/risk-gateway/preflight` additionally returns `market_context` and `warnings`.
>>>>>>> 053ecb9 (Add live calibration, Alpaca bars/options quote, and Cloudflare Worker market intelligence)

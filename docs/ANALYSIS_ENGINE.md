# ETI Advanced Market Analysis Engine

Independent analysis engines publish `EngineReport`s to a central intelligence layer. Everything lives in
`worker/analysis/` and runs on the Cloudflare Worker. **It is analytical and read-only: no endpoint can place an
order, and every response carries `submitsOrder: false`.** Scores are heuristic *evidence* measures, not probabilities of profit.

## Engines

| Module | What it does |
|---|---|
| `candlesticks.ts` | 20 context-qualified patterns (a hammer needs a prior decline; the same shape after an advance is a hanging man) |
| `structure.ts` | Confirmed (non-repainting) pivots, HH/HL/LH/LL, BOS/CHoCH, support/resistance clusters, supply/demand zones, trendlines (>= 3 touches), breakouts, false breakouts, retests |
| `smc.ts` | Displacement, fair value gaps (with fill tracking), liquidity pools and sweeps, order blocks (explicit methodology string `ORDER_BLOCK_METHOD`) |
| `volume-profile.ts` | POC, value area, HVN/LVN (OHLCV approximation; no tick data) |
| `fibonacci.ts` | Retracements/extensions on the latest significant leg, reported with confluence against other levels |
| `momentum.ts` | RSI/MACD/ROC momentum, volatility regime and percentile, relative strength vs a benchmark (aligned by timestamp) |
| `technical.ts` | Combines the above into one per-timeframe report with an explicit additive rubric (`WEIGHTS`) |
| `mtf.ts` | 1Y, 1M, 1w, 1d, 4h, 1h, 30m, 15m, 5m, 1m. Context (1Y-1d), setup (4h/1h), execution (30m-1m). Closed candles only. Disagreement yields `conflicted`, never an average |
| `fundamental.ts` | FX (rate/real-rate/yield/growth/employment differentials, policy bias, dollar trend, event risk), stocks (growth, margins, cash flow, balance sheet, valuation, insiders/institutions, moat proxies), crypto (tokenomics, unlocks, holders, liquidity, listings, on-chain, security, governance, adoption, development, regulatory) with a **legitimacy gate** |
| `sentiment.ts`, `news-feeds.ts` | RSS/Atom ingestion, timestamp+source validation, de-duplication, freshness decay, outdated detection, correction/denial and conflict detection, manipulation indicators, social claims unverified until corroborated |
| `intelligence.ts` | Weighs the engines by reliability, reports conflicts, applies vetoes |

## Central intelligence rules

* Weights depend on asset class and strategy (short horizons lean technical, long horizons lean fundamental) and are scaled by each engine's confidence; they always re-normalise over the engines that actually have data.
* Engines that disagree (both |score| >= 20, opposite stance) produce an explicit conflict; strong conflicts with a weak net score give `CONFLICTED`.
* **Crypto legitimacy veto:** `high_risk` fundamentals force `AVOID`. `unverified` (too little data to establish real value) caps a bullish verdict at `NEUTRAL`. A bullish chart never overrides this.
* Manipulation risk >= 35/60 down-weights sentiment to 60%/30%.
* Fewer than two evidence domains gives `INSUFFICIENT_DATA`.
* The existing Swift/Gainz Omnisignal engine can be run as an independent cross-check (`include=omnisignal`); disagreement is surfaced as a conflict.

## Endpoints

`GET` fetches data server-side: crypto candles via the existing exchange failover, stock and FX candles via Yahoo Finance's public chart endpoint. `POST` analyses data you supply (use it if you have a better data source). Add `detail=lite` to `/technical`, `/mtf` and `/intelligence` to skip the heaviest detectors (see Compute).

| Endpoint | Notes |
|---|---|
| `GET /api/analysis` | Catalog and which credentials are configured (booleans only) |
| `GET|POST /api/analysis/technical?symbol=&timeframe=` | POST body `{candles:[[t,o,h,l,c,v],...], benchmark?:{symbol,candles}}` |
| `GET|POST /api/analysis/mtf?symbol=&strategy=` | POST body `{candles:{"1d":[...],"1h":[...]}}` |
| `GET|POST /api/analysis/fundamental?symbol=&class=` | POST body `{assetClass, data}` (see the interfaces in `fundamental.ts`) |
| `GET|POST /api/analysis/news?symbol=` | POST body `{items:[{id,title,source,sourceType,publishedAt,...}]}` |
| `GET|POST /api/analysis/intelligence?symbol=&strategy=&detail=&include=omnisignal` | POST accepts `candles`, `fundamental`, `news` together. Response includes `technicalDetail` (per-timeframe table) |
| `GET|POST /api/analysis/calibrate?symbol=&timeframe=&horizon=&maxSamples=` | Walk-forward hit rates per score bucket with 95% intervals vs the baseline (technical engine only) |

Input limits: 2 MB body, 5000 candles per timeframe, 500 news items, strict candle sanity checks, best-effort per-isolate rate limiting.

## Data sources and what each cannot provide

| Source | Used for | Needs | Cannot provide |
|---|---|---|---|
| Exchange REST (Binance/Bybit/OKX, existing) | Crypto candles | nothing | Stocks, FX |
| Yahoo Finance chart endpoint | Stock/FX candles (1m-1mo; 4h built from 1h; 1Y from monthly) and the latest price | nothing | Unofficial and may rate-limit or change. Stock candles are regular hours only; FX has no volume (volume evidence is disabled and said so) |
| CoinGecko | Crypto supply, FDV, volume, venues, dev activity | optional `COINGECKO_API_KEY` | Team, holder concentration, unlock schedules, audits, governance, regulatory. Without them legitimacy is `unverified`; POST them or add a provider |
| SEC EDGAR | Stock statements and **Form 4 insider transactions** (open-market buys/sales, 10b5-1 sales discounted; last 180 days, up to 8 filings) | `SEC_USER_AGENT` | Institutional ownership (13F needs a bulk pipeline or paid provider). Market cap is derived as Yahoo price x cover-page shares (multi-class companies may be understated) |
| FRED | Currency macro. USD and EUR series are well established; GBP/JPY/CAD/AUD/NZD/CHF use FRED's OECD naming pattern | `FRED_API_KEY` | Those OECD IDs are unverified and some mirrors are no longer updated (the staleness check flags this); override with `FRED_SERIES_JSON`. Non-USD GDP is not configured. **Policy bias is derived from the 6-month policy-rate change** and labelled as such, not read from central-bank guidance. Economic events come from the operator-configured calendar (`ETI_EVENT_FEED_URL` / `ETI_EVENTS_JSON`, shared with the Market Readiness Engine); with none configured, event risk is reported as *unverified*, never as clear |
| Event calendar (`worker/readiness/events.ts`) | Scheduled-event risk for FX pairs, and high-impact events matching a stock or crypto symbol within 24h | `ETI_EVENT_FEED_URL` or `ETI_EVENTS_JSON` | Nothing is invented. Token unlock schedules: the Tokenomist adapter lives in the Python backend and is not callable from the Worker, so feed unlocks as events or POST `unlocks` |
| RSS/Atom feeds | News | optional `NEWS_FEEDS_JSON` | Default feed URLs are marked `unverifiedUrl` until confirmed from your deployment; per-feed status is returned |

Fundamentals and news are cached at the edge (15 and 5 minutes); failures are never cached. Missing data is reported under `missing`, lowers `completeness` and `confidence`, and is never defaulted.

## Calibration

Scores are heuristic until calibrated on real history. `calibrateTechnical` walks forward bar by bar using only data visible at each bar (a test proves that changing future candles cannot change earlier scores), spaces samples at least `horizon` bars apart, and reports for each score bucket the hit rate with a Wilson 95% interval against the unconditional baseline. It says "no demonstrable edge" when that is the finding, and "insufficient sample" below 30 observations.

```bash
npm run calibrate -- BTCUSDT 1h 10                         # downloads history from Binance's public market-data host
npm run calibrate -- --file candles.json 1d 10             # your own data
```

No real-market calibration has been run: the build sandbox has no market-data access. Run it for several markets and timeframes before relying on any score, and distrust a lone positive result (multiple-comparison risk).

## Compute and plan limits

Measured in Node, warm: one timeframe ~1 ms; a full 10-timeframe run ~30-45 ms; the same run with `detail=lite` ~7-8 ms. The Workers **Free** plan allows 10 ms CPU per request, so on Free use `detail=lite` (skips supply/demand zones, sweeps, order blocks, FVG, volume profile and Fibonacci; the output says so) and expect `/calibrate` to need the Paid plan. Full detail needs **Workers Paid**. Analysis is capped to the latest 250 candles per timeframe. Type safety: `npm run typecheck:analysis` runs strict TypeScript over `worker/analysis` and is part of `npm run check`.

## Limitations that remain

* Live endpoints (Yahoo, CoinGecko, SEC, FRED, RSS) were not reachable from the build sandbox. Parsers and the end-to-end flow are tested against mocked responses shaped like the real services, but verify each live source after deployment: the endpoints report per-source failures and the catalog shows which credentials are configured.
* Lexicon sentiment is coarse, not ML. Manipulation indicators are risk flags, not proof.
* Volume profile approximates tick distribution from OHLCV.
* Order blocks, supply/demand zones and liquidity sweeps are explicit, testable definitions, not evidence that institutions placed orders.
* Crypto team, holder, unlock and audit data have no keyless source; legitimacy stays `unverified` until supplied.
* Rate limiting is per Worker isolate (a burst limiter, not a global quota).

## Tests

`npm test` runs `worker/analysis.test.ts` (69 tests: detectors on hand-built candle fixtures, vetoes, parsers, mocked-network end-to-end flows, calibration look-ahead guard, validation, API) alongside the existing suites.

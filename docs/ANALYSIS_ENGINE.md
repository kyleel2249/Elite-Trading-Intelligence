# ETI Advanced Market Analysis Engine

Independent analysis engines publish `EngineReport`s to a central intelligence layer (`worker/analysis/`, running on the Cloudflare Worker).
**It is analytical and read-only: no endpoint can place an order, and every response carries `submitsOrder: false`.** Scores are heuristic *evidence*
measures, not probabilities of profit.

## Engines

| Module | What it does |
|---|---|
| `candlesticks.ts` | 20 context-qualified patterns (a hammer needs a prior decline; the same shape after an advance is a hanging man) |
| `structure.ts` | Confirmed (non-repainting) pivots, HH/HL/LH/LL, BOS/CHoCH, S/R, supply/demand zones, trendlines (>= 3 touches), breakouts, false breakouts, retests |
| `smc.ts` | Displacement, fair value gaps (fill tracking), liquidity pools and sweeps, order blocks (explicit methodology string) |
| `volume-profile.ts`, `fibonacci.ts`, `momentum.ts` | POC/value area (OHLCV approximation), Fibonacci with confluence, momentum, volatility regime, relative strength |
| `technical.ts`, `mtf.ts` | Per-timeframe report with an explicit additive rubric; 10 timeframes (1Y..1m), context vs execution layers on closed candles; disagreement yields `conflicted`, never an average |
| `fundamental.ts` | FX, stocks, crypto (with a **legitimacy gate**; established assets are recognised by market-structure evidence) |
| `sentiment.ts`, `sentiment-model.ts`, `sentiment-ai.ts`, `news-feeds.ts` | RSS/Atom ingestion, timestamp+source validation, de-duplication, freshness, corroboration, conflict and manipulation detection, rule-based sentiment model v2, optional AI second opinion |
| `intelligence.ts` | Weighs the engines by reliability, reports conflicts, applies vetoes |

## Free-plan setup (default)

`ETI_ANALYSIS_PLAN` defaults to **`free`** (also set in `wrangler.jsonc`). A Worker cannot measure its own CPU, so the limits are static caps chosen to stay inside
Workers Free (10 ms CPU, 50 subrequests per request):

| | Free (default) | Paid (`ETI_ANALYSIS_PLAN=paid`) |
|---|---|---|
| Detail | `lite` always (a request for `detail=full` is downgraded and the response says so) | `full` by default |
| Candles analysed per timeframe | 160 | 250 |
| News items scored | 60 | 500 |
| Form 4 filings read / AI headlines | 5 / 8 | 8 / 12 |
| `/calibrate` | refused with instructions (`npm run calibrate` locally) | up to 300 samples |

`lite` skips supply/demand zones, sweeps, order blocks, FVG, volume profile and Fibonacci, and the output says so. Responses are slimmed (per-timeframe summaries; the full
analysis objects are opt-in with `include=analysis`). SEC data is fetched per XBRL concept (tens of KB each) instead of the multi-MB `companyfacts` file, DeFiLlama is read
head-only, and `ticker.txt` replaces `company_tickers.json`, all to keep parsing cheap.

Measure it yourself: `node scripts/cpu-budget.ts` (6 batches of 20 warm calls per path; it judges the best batch and flags noise). On the build machine the **best / worst batch medians were: technical 1.1 / 3.2 ms, 10-timeframe MTF 6.1 / 9.2 ms, news 1.2 / 2.4 ms, full intelligence 6.6 / 8.3 ms** against the 10 ms budget: inside it, but the MTF and intelligence paths have little headroom, and shared machines vary by about +-30%.
Cold first requests on a new isolate include JIT time (9-50 ms here), so an occasional first request on Free may still hit the limit. Node is a proxy for workerd and these requests exclude the real network fetches (I/O waits are not CPU, but parsing the responses is): confirm with the Cloudflare dashboard's CPU-time metrics after deploying, and set `ETI_ANALYSIS_PLAN=paid` if you see error 1102.

## Central intelligence rules

* Weights depend on asset class and strategy and are scaled by each engine's confidence; they always re-normalise over engines that have data.
* Opposite engines (both |score| >= 20) produce an explicit conflict; strong conflicts with a weak net score give `CONFLICTED`.
* **Crypto legitimacy veto:** `high_risk` fundamentals force `AVOID`; `unverified` caps a bullish verdict at `NEUTRAL`. A bullish chart never overrides this.
* Manipulation risk >= 35/60 down-weights sentiment to 60%/30%. Fewer than two evidence domains gives `INSUFFICIENT_DATA`.
* The Swift/Gainz Omnisignal engine can run as an independent cross-check (`include=omnisignal`).

## Endpoints

`GET` fetches data server-side (crypto via exchange failover, stocks/FX via Yahoo Finance); `POST` analyses data you supply.

| Endpoint | Notes |
|---|---|
| `GET /api/analysis` | Catalog, plan and limits, which credentials/bindings are configured (booleans only) |
| `GET\|POST /technical`, `/mtf` | `?symbol=&timeframe=&strategy=&detail=lite\|full&include=analysis` |
| `GET\|POST /fundamental` | `?symbol=&assetClass=`; POST `{assetClass, data}` |
| `GET\|POST /news` | POST `{items:[{id,title,source,sourceType,publishedAt}]}` |
| `GET\|POST /intelligence` | `?symbol=&strategy=&detail=&include=omnisignal`; response includes `technicalDetail` |
| `GET /institutional?symbol=&sharesOutstanding=` | 13F aggregate from D1 (stocks) |
| `GET\|POST /calibrate` | Walk-forward hit rates per score bucket (paid plan) |

## Data sources and their limits

| Source | Provides | Needs | Cannot provide / caveats |
|---|---|---|---|
| Exchange REST (existing) | Crypto candles | none | Stocks, FX |
| Yahoo Finance chart API | Stock/FX candles, latest price | none | Unofficial; regular-hours stock bars; FX has no volume |
| CoinGecko | Supply, FDV, volume, venues, rank, age, contract addresses, repo URL | optional key | Team, holders, audits, governance |
| **GoPlus** (keyless) | **EVM tokens:** top holders (burn/locked/labelled wallets excluded; a *lower bound*), honeypot, hidden owner, mintable, proxy, taxes, DEX liquidity, LP locks | none | **EVM chains only (not Solana/native L1s)**; automated static analysis, not an audit |
| **DeFiLlama** (keyless) | Audits and audit links, TVL (read head-only for CPU) | none | Only DeFi protocols; "audited" means listed, not verified |
| **GitHub** | Commits (13 weeks), last push, contributors | optional `GITHUB_TOKEN` (60 req/h unauthenticated) | Says nothing about team identity |
| **Tokenomist (native TS port)** | 90-day unlock events, insider share | `TOKENOMIST_API_KEY` (Pro) | Credit reserve enforced via KV; **licence: personal/non-commercial, no redistribution, so the Worker returns only derived metrics (counts, % of circulating, insider share), never the raw schedule** |
| **Operator profiles** `CRYPTO_PROFILES_JSON` | **Team identity, regulatory status, verified audits, unlocks** | you maintain it | Only whitelisted, type-checked fields are read; these are *your* assertions, labelled as such |
| SEC EDGAR | Statements (per-concept), **Form 4 insiders** | `SEC_USER_AGENT` | |
| **13F pipeline + D1** | **Institutional ownership %, QoQ change, holder count, top filers** | run the pipeline (below) | A lower bound (>= $100M managers, long only), 6 weeks to ~4.5 months stale; aggregates above 100% of shares outstanding are rejected as double counting |
| FRED | Currency macro (USD, EUR well established; OECD-pattern IDs for the rest, unverified) | `FRED_API_KEY` | Policy bias derived from the 6-month rate change, labelled as derived |
| Event calendar (`ETI_EVENT_FEED_URL` / `ETI_EVENTS_JSON`) | Scheduled-event risk | operator | None configured means "unverified", never "clear" |

**Team identity has no free source anywhere**; it is the one crypto fact that always needs a human. Without a curated profile it is reported as unknown and
(with other gaps) legitimacy stays `unverified`, except for *established assets* (top-25 by market cap, >= 4 years old, >= 3 tier-1 venues, >= $100M daily volume), where legitimacy rests on stated market-structure evidence.
The Python Tokenomist adapter is not bridged: the Worker deliberately has no Python origin, so the client was ported to TypeScript instead.

## Institutional ownership (13F) pipeline

13F data is reported per *filer*, so per-stock ownership needs an aggregation that cannot run inside a Worker. The offline pipeline does it and loads D1:

```bash
# 1. download two consecutive quarters from https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets (public domain)
# 2. aggregate and resolve tickers (OpenFIGI; ~40 min unauthenticated for 4000 CUSIPs, ~5 min with OPENFIGI_API_KEY; results are cached/resumable)
node scripts/13f-build.ts --current 2026q3_form13f.zip --period 2026-09-30 --previous 2026q2_form13f.zip --previous-period 2026-06-30 --out 13f.sql
# 3. load
npx wrangler d1 migrations apply eti-portfolio-db --remote
npx wrangler d1 execute eti-portfolio-db --remote --file 13f.sql
```
`docs/examples/13f-refresh.workflow.yml` automates this as a manual GitHub Action. Handled: restatement vs "new holdings" amendments, other periods and 13F-NT notices ignored, puts/calls, bonds and preferreds excluded, split rows merged, holders counted per filing. The pipeline was verified on synthetic SEC-format data, a real SQLite database and the real migration; **it has not been run on a real SEC data set from the build sandbox (no access)**. First run: check `inst_meta` (filing/row counts) against the SEC's own totals, and that the SEC's `VALUE` units match (`--value-multiplier`; filings before 2023 are in thousands).

## Sentiment model

`sentiment-model.ts` is a transparent **rule model** (not a trained classifier): weighted phrases, negation, intensifiers (before or after the verb), hedging, questions, routine-event cues, clause structure ("despite"/"but"), adverse nouns ("unemployment *falls*" is good), market-reaction cues, asset-class-aware policy news (a hike helps a currency, hurts equities) and **FX pair orientation** (news about the quote currency counts against the pair).

Measured on hand-written, labelled headlines (positive / negative / neutral impact), the old word-list lexicon vs v2:

| Set | Old lexicon | v2 model |
|---|---|---|
| Dev set (87; used while writing the rules) | 51.7% | 96.6% (**overfit, not a generalisation estimate**) |
| **Frozen held-out set (78; written after the rules were final)** | **44.9%** | **76.9%** (macro-F1 0.74; recall positive 0.69, negative 0.80, neutral 0.91) |

Read the held-out column. The 20-point gap to the dev score is what tuning on your test data looks like. Integrity notes: the first draft of the held-out set was discarded as contaminated because its items were studied while the rules were designed (it became part of the dev set); one bug found by a unit test ("fall *sharply*") was fixed after the held-out run without changing either score; all headlines were written by the engine's author, so this is a regression guard, not an independent evaluation. `node scripts/sentiment-eval.ts --heldout` reproduces it.

**Optional AI second opinion** (`SENTIMENT_AI=on` plus a Workers AI binding): add `"ai": { "binding": "AI" }` to `wrangler.jsonc` (not enabled by default because `wrangler dev` then requires a Cloudflare login). One batched call per request for the highest-weight headlines, cached 24 h. Because headlines are untrusted: they are sent as JSON data (never spliced into instructions), replies are schema-validated, the AI's weight is capped at 40% and shrinks further when it contradicts a confident rule score (a hostile model can soften a clear signal but not erase or flip it), disagreement lowers confidence, and any failure falls back to the rule model with a warning. **The AI path has only been tested against fake bindings; the model id (`SENTIMENT_AI_MODEL`) and its real behaviour are unverified from the build sandbox**, and no accuracy claim is made for it.

## Calibration

`calibrateTechnical` walks forward bar by bar (a test proves future candles cannot change earlier scores), spaces samples >= `horizon` apart and reports hit rates with Wilson 95% intervals against the baseline, saying "no demonstrable edge" or "insufficient sample" when that is the finding. Run `npm run calibrate -- BTCUSDT 1h 10`. **No real-market calibration has been run** (no market-data access in the build sandbox): the scores stay uncalibrated until you run it for several markets and timeframes.

## Remaining limitations

* Live endpoints (Yahoo, CoinGecko, GoPlus, DeFiLlama, GitHub, Tokenomist, SEC, FRED, RSS, OpenFIGI, Workers AI) were not reachable from the build sandbox: parsers and flows are tested against mocked responses shaped like the real services. Verify each live source after deployment: endpoints report per-source failures.
* GoPlus covers EVM only; holder concentration is a lower bound; DeFiLlama audit status is a listing, not verification.
* The 13F figure is a lower bound and lagged; unresolved CUSIPs have no ticker.
* Sentiment accuracy is ~77% on the author's held-out set; rule models fail on sarcasm, novel phrasing and headlines needing outside knowledge. Manipulation indicators are risk flags, not proof.
* Volume profile approximates tick distribution from OHLCV. Order blocks/zones/sweeps are explicit definitions, not evidence of institutional intent.
* Rate limiting is per Worker isolate (a burst limiter, not a global quota). Cold first requests may exceed the Free CPU limit.

## Tests and gates

`npm run check` = all tests (analysis 100+, 13F pipeline, sentiment, plus the repo's own), the strict type-check of `worker/analysis` (`npm run typecheck:analysis`) and the Worker build. Safeguards (vetoes, credit guard, holder exclusions, honeypot flag, 13F filters/amendments, double-count guard, AI schema/caps/gates) are mutation-tested: deliberately breaking each one makes a test fail.

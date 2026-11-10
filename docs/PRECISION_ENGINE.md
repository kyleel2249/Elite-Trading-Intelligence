# ETI PRECISION SIGNAL ENGINE

A read-only analytical engine that evaluates one crypto spot pair at a time and answers **BUY**, **SELL** or **NO TRADE**
with a complete, auditable trade plan. It lives in `worker/precision/` and runs inside the Cloudflare Worker.

It composes the existing ETI primitives (`worker/algo/`: multi-timeframe analysis, regime classifier, levels, order-book
liquidity, independent validation) and adds net-of-cost reward-to-risk, a configurable 0-100 opportunity score, hard risk
gates, and calibration-aware confidence. **It cannot place or authorise an order.**

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/precision/signal?symbol=BTCUSDT&strategy=intraday[&provider=binance]` | One signal. Strategies: `scalp` (5m), `intraday` (15m), `swing` (4h), `position` (1d). |
| `GET /api/precision/markets` | Supported markets and strategies. |
| `GET /api/precision/config` | Effective configuration, its status (`default`, `override_applied`, `override_rejected`) and fingerprint. |
| `GET /api/precision/calibration?strategy=intraday` | Whether a calibration model exists, whether it is usable, and exactly why not. |
| `PUT /api/precision/admin/fundamentals/{BASE}` | Supply fundamentals for an asset (token required). |
| `PUT /api/precision/admin/news/{BASE or _market}` | Supply news / event-calendar data (token required). |
| `PUT /api/precision/admin/expectancy/{strategy}` | Supply measured strategy expectancy (token required). |
| `POST /api/precision/admin/calibration/fit?strategy=...` | Fit and validate a calibration model from recorded outcomes (token required). |

Only crypto spot is supported today (Binance, Bybit, OKX public data with failover, plus an order book). ETI's Readiness engine has
optional US-equity (Alpaca) and forex (operator-supplied feed) price sources in `worker/readiness/sources.ts`; they are **not yet wired
into this engine**, so equities, forex and commodities are rejected (`422 unsupported_market`) rather than approximated. Supporting them
needs per-market cost models (no crypto order book, session hours, different fee structures) and is a separate piece of work.

## What a signal contains

Every field in the specification is present on every response. `NO TRADE` publishes no entry, stop or targets, but still
explains the analysis and lists every failed check.

| Requirement | Field |
|---|---|
| Asset, pair / ticker, market | `asset`, `tradingPair`, `ticker`, `market` |
| Direction | `direction`: `BUY`, `SELL`, `NO TRADE`; `decision.reasons` lists why not |
| Entry price / zone | `entry`, `entryZone` |
| Stop-loss | `stopLoss` |
| TP1 / TP2 / TP3 | `takeProfits[]` (gross `rewardRisk`, net `netRewardRisk`, `closeFraction`); `tp3.included` and `tp3.reason` |
| Risk-to-reward | `riskReward.grossToFinalTarget`, `riskReward.netToFinalTarget` |
| Estimated transaction costs | `transactionCosts` (fees, spread, slippage, round trip in bps / price / R, what is excluded) |
| Setup timeframe, higher-timeframe direction | `setupTimeframe`, `higherTimeframeDirection` |
| Technical / fundamental justification | `technicalJustification[]`, `fundamentalJustification` |
| Relevant news | `relevantNews` (events, blackout flag, source, as-of time) |
| Liquidity, volatility | `marketLiquidity`, `volatility` |
| Invalidation, expiry | `invalidation[]`, `expiresAt`, `validForBars` |
| Data timestamp | `dataTimestamp`, `dataTimestamps` (fetch time, latest candle, order book) |
| Confidence | `confidence` (calibrated probability **or** qualitative; see below) |
| Supporting evidence, attribution | `supportingEvidence[]`, `strategyAttribution[]` |
| Score and risk checks | `opportunityScore`, `riskChecks[]`, `riskCheckSummary` |

`TP3` is included only when it is at least `tp3MinRewardRisk` gross and `minNetRewardRisk` net, otherwise it is omitted with the reason.

## Opportunity score (0-100)

Ten components, each mapped to 0-100 from real evidence, combined with configurable weights:

| Component | Default weight | Evidence |
|---|---|---|
| Trend alignment | 15 | EMA 20/50/200 + adaptive bands, blended with higher-timeframe trend |
| Market structure | 10 | Swing structure bias |
| Technical confirmation | 12 | Multi-timeframe consensus, volume flow, independent evidence families |
| Fundamental alignment | 8 | Supplied fundamentals only |
| Liquidity | 12 | Order-book imbalance, spread, large resting orders |
| Volatility suitability | 8 | Volatility class vs strategy, regime, stop size |
| News risk | 8 | Supplied news / event calendar only |
| Historical strategy expectancy | 10 | Supplied measured expectancy (needs at least 30 outcomes) |
| Execution costs | 7 | Round-trip costs in units of risk |
| Risk-to-reward | 10 | Net reward-to-risk at the final target |

| Score | Interpretation |
|---|---|
| 90-100 | Exceptional candidate, subject to all risk checks |
| 80-89 | Strong candidate |
| 70-79 | Potential opportunity |
| 50-69 | Weak or incomplete setup |
| Below 50 | Avoid |

These are research-priority bands, **not probabilities**. Rules that keep the score honest:

- **Missing evidence is not neutral.** A component with no evidence (no fundamentals supplied, no news feed, no measured
  expectancy, no order book) is reported as `unavailable`, removed, and the remaining weights are renormalised.
- **Incomplete evidence is capped.** While any component is unavailable the score cannot exceed `incompleteDataCap` (79),
  so a setup can only reach the Exceptional band when every component has real evidence behind it.
- **A strong score never overrides a failed risk check** (next section).

## Risk gates

Every gate is evaluated on every signal. **Any single failed gate forces `NO TRADE`, regardless of score.** A gate that lacks
the evidence to judge is `not_evaluated`; it is reported and never counted as a pass.

Instrument supported, data fresh, candle history complete, directional multi-timeframe evidence, regime permits entries,
order book available and healthy, spread within limit, no nearby liquidity trap, stop distance, net reward-to-risk after
costs (TP1 and final target), costs not consuming the reward, no high-impact news blackout, strategy expectancy not
negative, independent validation has no hard failure, signal valid for at least one full bar, score at or above the
configured minimum, and account-level risk limits when a verdict is supplied.

**Account-level risk (equity, exposure, daily loss, drawdown) is not evaluated by this engine** and is reported as
`not_evaluated`. Any order still has to pass the server-side risk preflight in the execution gateway.

## Confidence and calibration

`confidence.type` is one of:

- `qualitative` (the default): a `low` / `moderate` / `high` research-priority level, with `calibration.reasons` saying why no
  probability is given. No number is invented.
- `calibrated_probability`: emitted **only** when a stored model passes every check, on every request:
  fitted on recorded outcomes with isotonic regression on a chronological split; validated on the held-out later data
  (Brier skill versus the base rate, expected calibration error); enough samples overall, held out, and per score block;
  fitted on the **same scoring-configuration fingerprint** and engine version currently in force; for the same strategy; and
  not older than `maxAgeDays`. The response includes the Wilson 95% interval, the outcome definition and the validation metrics.

Changing weights, bands, the cap or cost assumptions changes the fingerprint and silently returns confidence to
`qualitative` until a new model is fitted. A model that fails validation is still stored so its metrics can be inspected,
but is never used.

Fit a model from recorded outcomes (score at entry, whether the trade closed positive after costs):

```bash
curl -X POST "https://<worker>/api/precision/admin/calibration/fit?strategy=intraday" \
  -H "Authorization: Bearer $ETI_PRECISION_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"outcomeDefinition":"Closed positive after fees and slippage","samples":[{"score":78.4,"win":true,"time":1790000000000}]}'
```

`GET /api/precision/calibration?strategy=intraday` reports usability and monitors why a model was rejected. Re-fit regularly:
calibration describes past behaviour and degrades when markets or execution change.

## Configuration

Set the optional Worker variable `ETI_PRECISION_CONFIG` to a JSON object that overrides any subset of `weights`, `bands`,
`incompleteDataCap`, `expiryBars`, `gates`, `costs`, `context` or `calibration`. Defaults are in `worker/precision/config.ts`.

- Unknown keys, wrong types, or out-of-range values (for example a 0 bps spread limit, or a calibration error limit above
  0.1) reject the **whole** override; the defaults stay in force and `engine.configStatus` is `override_rejected`.
- `GET /api/precision/config` shows the effective configuration and `configHash`.

Transaction costs: fees are a **configured assumption** (default 10 bps per side), not your account's tier. Slippage is
estimated by walking the visible order book for a reference notional (default 10,000 quote), or assumed (default 5 bps) when
the book cannot be used. Funding / borrow costs, rebates, gaps and market impact beyond the visible book are excluded and
listed in `transactionCosts.excludes`.

## Supplying fundamentals, news, expectancy

ETI does not infer fundamentals or news from price and has no automated ingestion for them yet. They are supplied through
the admin routes into an optional KV namespace, validated on write and again on read, and judged for age:

```bash
curl -X PUT "https://<worker>/api/precision/admin/fundamentals/BTC" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"asOf":"2026-11-09T08:00:00Z","source":"my-research-feed","factors":[{"name":"Network activity","bias":0.6,"weight":2,"note":"rising"}]}'
curl -X PUT "https://<worker>/api/precision/admin/news/_market" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"asOf":"2026-11-09T08:00:00Z","source":"macro-calendar","events":[{"title":"FOMC decision","time":"2026-11-10T19:00:00Z","impact":"high","scheduled":true}]}'
curl -X PUT "https://<worker>/api/precision/admin/expectancy/intraday" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"expectancyR":0.18,"samples":120,"asOf":"2026-11-09T08:00:00Z","source":"paper ledger"}'
```

Defaults: fundamentals older than 168 h, news older than 12 h, expectancy older than 45 days are not used and are reported as
`stale`. A high-impact event inside the window (60 min before to 30 min after) triggers a news blackout, and a signal's expiry is
shortened so it never outlives the start of a blackout. `bias` is -1 (bearish) to +1 (bullish) for the asset; ETI does not verify supplied data.

### Cloudflare setup

1. Create a KV namespace and bind it as `ETI_PRECISION_DATA` in `wrangler.jsonc` (use the id Cloudflare gives you).
2. Set the secret: `npx wrangler secret put ETI_PRECISION_ADMIN_TOKEN` (at least 16 random characters). Without it the admin routes return 403.
3. Optional: set the `ETI_PRECISION_CONFIG` variable.

Without the KV binding the engine still works: fundamentals, news, expectancy and calibration are simply `unavailable`, the
score is capped, and confidence is qualitative.

## Using a signal with the execution gateway

The signal is analytical. To trade one, submit through `POST /api/orders` (paper / testnet) and pass the signal's `signalId` in
`executionSource.signalId` so the audit record links the order to the signal. The order still passes the server-side risk
preflight, kill switch, and caps. Do not treat `signal.tradeable` as authorisation.

## Verification and known limits

- `npm test` runs the engine's unit and integration tests (scoring, gates, costs, context, calibration, API, admin, route wiring)
  alongside the existing suite; `npm run check` also bundles the Worker.
- Tests use deterministic synthetic data and a mocked exchange. They prove the logic and the invariants (for example, a failed
  gate always yields `NO TRADE`); they do **not** prove the strategy is profitable. No live-market performance is claimed.
- No calibration model ships with ETI. Until you record enough outcomes and fit one, confidence is qualitative by design.
- No cross-provider price reconciliation (`providerCrossCheck: "not_performed"`); the order book is a REST snapshot.
- The dashboard UI does not yet render this engine; it is consumed through the API.

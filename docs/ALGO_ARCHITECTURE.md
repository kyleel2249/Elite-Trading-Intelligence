# ETI algorithmic intelligence: what is authoritative

One signal path, one metrics definition, one trade-management rule set, one evidence store. Everything below lives in `worker/algo/`.

## Signal path (single)

```
loadSignalInputs (market-inputs.ts)           candles for the strategy's timeframes + REST order book
  -> swiftEngine (swift.ts) + gainzEngine (gainz.ts)      independent engines, shared contract in engine.ts
  -> fuseEngines (fusion.ts)                  agreement / disagreement settled by independent evidence, not a vote
  -> validateSignal (validation.ts)           0-100 score, 13-question checklist, hard failures no score can override
  -> runOmnisignal (omnisignal.ts)            BUY | SELL | HOLD | REJECTED | DATA_UNRELIABLE   (never submits an order)
```

| Route | What it is |
|---|---|
| `GET /api/omnisignal` | The decision and trade plan. |
| `GET /api/algo/signal` | Calls the handler above and only **decorates** its answer with the `EARLY / CONFIRMED / HIGH_CONVICTION` class and flat fields (`action`, `entry`, `stopLoss`, `takeProfits`, `riskReward`). It cannot drift from `/api/omnisignal` because it does not recompute anything. |

`signal.ts` (`buildSignal`) is the earlier single-engine reference pipeline. It is kept, tested and importable, but no route uses it.

## Building blocks (shared by every engine)

`indicators.ts` (volume-weighted momentum, dual EMA, ATR, adaptive bands, EMA filter, ADX; causal `*Series` variants),
`regime.ts` (10 regimes), `timeframes.ts` (eight-timeframe analysis and weighted consensus), `liquidity.ts` (order book),
`levels.ts` (entry / stop / TP1-3, `manageStop`: stops only tighten), `trade-walk.ts` (walk a position through bars).

## Measuring results: three layers, three different claims

| Layer | Module | Rules used | What it can claim |
|---|---|---|---|
| Parametric screen | `backtest.ts`, `GET /api/algo/backtest` | **Simplified** (EMA + bands + flow + ADX gate) | Which parameter regions are not fragile. **Cannot validate the live engines.** Never feeds the validator. |
| Historical replay | `replay.ts`, `scripts/replay.mjs` | The **real** chain, through the paper engine | Backtested expectancy of the live engines (`expectancyForValidator`, once >= 30 trades). |
| Paper / live outcomes | `paper.ts`, `performance.ts` | The real chain, real clock | Paper-trading and (later) verified live performance. |

Keep the three labels apart in every UI and report. A backtested win rate is not a paper win rate and neither is a verified live win rate.

### Shared definitions (so numbers are comparable)

* **Metrics:** `performance.ts` `computeReport`. The screen builds its `report` field with it. Rates and ratios are withheld below `MIN_SAMPLE` (30) trades; Wilson intervals are always shown.
* **Trade management:** `trade-walk.ts` `walkPosition`, built on `levels.ts` `manageStop`. The screen simulator, the journal outcome evaluator and `PaperEngine` follow the same rules: partials 40/30/30, break-even at entry plus round-trip fees after TP1, trailing at 1.7 x the initial risk after TP2, stop-first when a bar touches both. `parity.test.ts` runs identical bars through the screen and `PaperEngine` and requires identical R.
* **Expectancy fed to the validator:** only from the evidence store below. `null` means "unproven" and caps conviction; it is never assumed positive.

### Known, documented divergence

Through a price gap the screen and the journal fill the stop at the gap price (conservative) while `PaperEngine` fills it at the stop price
(optimistic). A test pins the difference and asserts the screen is never the more optimistic of the two.

## Measured evidence: the expectancy store

`expectancy.ts` (KV key `algo:expectancy:v1:<strategy>`) is the only way measured evidence reaches the validator.

* Accepts only `replay` or `paper` sources, at least 30 trades, evidence no older than 30 days (a stale record, positive or negative, reverts to *unproven*).
* A **positive** claim needs a bootstrap 95% interval above zero. Positive but indistinguishable from zero stays *unproven*.
* A non-positive estimate is passed through and blocks the setup. Blocking is the safe direction.
* Several sources: the most conservative wins; a symbol-specific record beats a strategy-wide one.
* Read (one KV read, never throws: any problem means *unproven*) by `/api/omnisignal`, `/api/algo/signal`, `/api/omnisignal/scan`, the paper cycle and evaluation, the testnet bridge, and the Precision engine.
* Gates **new entries only**. `manage.ts` re-evaluates open positions and is deliberately not given the evidence: strategy-level evidence must not force-close a position that already exists.

Routes: `GET|POST /api/algo/expectancy`, `POST /api/algo/expectancy/refresh-paper` (writes need the bearer token).

## Signal journal

`journal.ts` (KV keys `algo:journal:*`) records every analytical decision, including HOLD and REJECTED, one entry per symbol, strategy and execution candle, with hypothetical outcomes (filled / missed move / expired / invalidated, R gross of fees) resolved by `POST /api/algo/journal/resolve` against closed bars (1-minute bars for recent signals, execution-timeframe bars otherwise).

* Recording from the public signal routes is **off** unless `ETI_JOURNAL_ENABLED=true` (KV writes are limited). Listing uses KV metadata, so it needs no per-entry reads.
* Rates are withheld below 30 resolved signals. Outcomes are hypothetical: not trades, not paper results, not live results.
* `GET /api/algo/journal`, `/entry?id=`, `/stats?days=`.
* This is the **signal** journal. The append-only, hash-chained **trade** journal (`worker/journal/*`) records executions and is a separate system.

## Related subsystems (separate, not modified by this work)

* `optimizer.ts` and `params.ts`: walk-forward search over a whitelist of bounded validator-weight profiles, champion/challenger promotion and rollback. A recommendation is never applied automatically; promotion needs a named human approver. `degradationStep` automatically restores the last human-approved configuration when recent paper results breach the thresholds.
* `alerts.ts` / `alert-rules.ts`: alert delivery and the rules that raise them.
* `paper.ts` / `paper-api.ts` / `performance.ts`: simulated execution, audit trail and rolling windows (24h / 7d / 30d / 90d / all).
* `worker/precision/*` (Precision engine): its own record of expectancy (`/api/precision/admin/expectancy`) still exists, but `loadContext` now also consults the shared store, which can only make the answer **more** conservative: negative shared evidence always wins and validated shared evidence caps an optimistic record.
* `worker/alpha/*` (Global Alpha), `worker/agents/*`, `worker/readiness/*`: independent subsystems that consume this engine's building blocks.

## Safety boundaries (unchanged)

No route in this folder submits a live order. Paper orders require the in-process safeguards and fail closed. No route can withdraw or move funds.

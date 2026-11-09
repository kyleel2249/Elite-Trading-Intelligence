# ETI algorithmic intelligence: what is authoritative

One signal path, one metrics definition, one trade-management rule set. Everything below lives in `worker/algo/`.

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
| `GET /api/algo/signal` | The **same** decision through a thin adapter (`api.ts`) that adds the `EARLY / CONFIRMED / HIGH_CONVICTION` class from the validator and flat fields (`action`, `entry`, `stopLoss`, `takeProfits`, `riskReward`). A test asserts both routes agree. |

`signal.ts` (`buildSignal`) is the earlier single-engine reference pipeline. It is kept, tested and importable, but no route uses it.

## Building blocks (shared by every engine)

`indicators.ts` (volume-weighted momentum, dual EMA, ATR, adaptive bands, EMA filter, ADX; causal `*Series` variants),
`regime.ts` (10 regimes), `timeframes.ts` (eight-timeframe analysis and weighted consensus), `liquidity.ts` (order book),
`levels.ts` (entry / stop / TP1-3, `manageStop`: stops only tighten).

## Measuring results: three layers, three different claims

| Layer | Module | Rules used | What it can claim |
|---|---|---|---|
| Parametric screen | `backtest.ts`, `GET /api/algo/backtest` | **Simplified** (EMA + bands + flow + ADX gate) | Which parameter regions are not fragile. **Cannot validate the live engines.** Never feeds the validator. |
| Historical replay | `replay.ts`, `scripts/replay.mjs` | The **real** chain, through the paper engine | Backtested expectancy of the live engines (`expectancyForValidator`, once >= 30 trades). |
| Paper / live outcomes | `paper.ts`, `performance.ts` | The real chain, real clock | Paper-trading and (later) verified live performance. |

Keep the three labels apart in every UI and report. A backtested win rate is not a paper win rate and neither is a verified live win rate.

### Shared definitions (so numbers are comparable)

* **Metrics:** `performance.ts` `computeReport`. The screen builds its `report` field with it. Rates and ratios are withheld below `MIN_SAMPLE` (30) trades; Wilson intervals are always shown.
* **Trade management:** `levels.ts` `manageStop`. The screen simulator and `PaperEngine` both call it: partials 40/30/30, break-even at entry plus round-trip fees after TP1, trailing at 1.7 x the initial risk after TP2, stop-first when a bar touches both. `parity.test.ts` runs identical bars through both and requires identical R.
* **Expectancy fed to the validator:** only from replay or paper results. `null` means "unproven" and caps conviction; it is never assumed positive.

### Known, documented divergence

Through a price gap the screen fills the stop at the gap price (conservative) while `PaperEngine` fills it at the stop price
(optimistic). A test pins the difference and asserts the screen is never the more optimistic of the two.

## Related subsystems (separate, not modified by this reconciliation)

* `optimizer.ts`: walk-forward search over a **whitelist of bounded validator-weight profiles**, champion/challenger promotion and rollback. A recommendation is never applied automatically; promotion needs a named human approver. It owns "model versioning and rollback" for the validator, so nothing else should re-implement it.
* `paper.ts` / `paper-api.ts` / `performance.ts`: simulated execution, audit trail and rolling windows (24h / 7d / 30d / 90d / all).
* `worker/alpha/*` (Global Alpha), `worker/agents/*`, `worker/readiness/*`: independent subsystems that consume this engine's building blocks.

## Safety boundaries (unchanged)

No route in this folder submits a live order. Paper orders require the risk-gateway preflight and fail closed. No route can withdraw or move funds.

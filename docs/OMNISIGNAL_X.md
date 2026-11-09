# ETI Omnisignal X

Analytical dual-engine signal system with a **simulated** paper-trading layer. Live trading is not available through
any of these routes, and no route can withdraw, transfer or move funds.

## Components (`worker/algo/`)

| Module | Role |
|---|---|
| `swift.ts` | Volume-weighted momentum, dual EMA, ATR, adaptive trailing bands, EMA filter, eight-timeframe consensus |
| `gainz.ts` | EMA 9/21/50, RSI intelligence (extremes are context, never reversal calls), breakout / failed-breakout / sweep / squeeze, adaptive threshold, quality gates |
| `fusion.ts` | Seven-outcome agreement detector. Disagreements are settled by independent evidence (higher timeframes, structure, volume, order book, regime), never a majority vote. The rejected engine and the reason are recorded |
| `validation.ts`, `omnisignal.ts` | Independent validation with hard rejections that no score can override. Final: BUY / SELL / HOLD / REJECTED / DATA_UNRELIABLE |
| `paper.ts` | Simulated fills, fees, slippage, TP1/TP2/TP3 partials, break-even and trailing (stops only tighten), kill switch, loss limits, idempotent orders |
| `performance.ts` | Expectancy, profit factor, Sharpe/Sortino (per trade), drawdown, Wilson intervals, calibration. Withheld below 30 trades |
| `replay.ts`, `replay-io.ts` | Historical replay lab with no lookahead, in/out-of-sample split, bootstrap CI, engine comparison |

Confidence is an **uncalibrated evidence score**, not a probability of profit.

## HTTP API

Read-only, public: `GET /api/omnisignal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz`

Authenticated (`Authorization: Bearer $ETI_EXECUTION_TOKEN`), all paper/simulated:

| Route | Purpose |
|---|---|
| `GET /api/paper/status` | Equity, open positions, kill switch, gateway configured |
| `POST /api/paper/evaluate` `{symbol, strategy, execute?}` | Analyse; with `execute:true` open a paper position **only if the risk gateway approves** |
| `POST /api/paper/tick` `{symbol}` | Advance an open position with closed 1-minute bars (each bar applied once) |
| `POST /api/paper/kill` `{on}` | Engage/release the paper kill switch (`ETI_KILL_SWITCH=true` also blocks, with HTTP 423) |
| `GET /api/paper/performance` | 24h/7d/30d/90d/all windows, per engine, per regime, calibration |
| `GET /api/paper/audit?limit=100` | Decision trail (90-day TTL) |

### Required configuration (Worker secrets / bindings)

`ETI_EXECUTION_TOKEN`, `ETI_EXECUTION_LOG` (KV), `ETI_RISK_GATE_URL`, `ETI_RISK_GATE_TOKEN`. Without the gateway settings
every order is rejected (fail closed). Orders are preflighted as `provider=binance, environment=paper, order_type=limit`
against the existing Python `POST /api/risk-gateway/preflight`.

### Scheduled paper cycle (Cron Trigger, every 5 minutes)

`wrangler.jsonc` registers `*/5 * * * *`; the Worker's `scheduled` handler runs one pass. It is **off by default**.

| Variable | Effect |
|---|---|
| `ETI_PAPER_SYMBOLS` | Comma list (max 3 per run, validated). Unset = the cycle only manages already-open positions, otherwise does nothing |
| `ETI_PAPER_STRATEGY` | `scalp` \| `intraday` (default) \| `swing` \| `position` |
| `ETI_PAPER_AUTOEXECUTE` | Only the exact string `true` lets the cycle open positions. Otherwise it analyses only |

Each pass: manage every open position first (always, even under a kill switch or after a symbol is removed), then evaluate the
configured symbols. New entries still need gateway approval and are blocked by `ETI_KILL_SWITCH` or the API kill switch
(recorded as `SKIPPED`). One symbol failing never stops the others. The last pass is visible at
`GET /api/paper/status` -> `scheduler.lastRun`. The 3-symbol cap exists because the Workers free plan allows about
50 subrequests per invocation and one symbol costs about 10.

### Known limits

* State lives in KV, which is not transactional: send paper requests one at a time (a Durable Object would remove this limit).
* Position management uses closed 1-minute bars; the partial minute containing the fill is unmonitored.
* Order-book depth is a REST snapshot; providers are not cross-checked.

## Historical replay

```bash
node scripts/replay.mjs --symbol BTCUSDT --strategy intraday --days 180 --compare --out report.json
node scripts/replay.mjs --csv btc_15m.csv --tf 15m --symbol BTCUSDT --strategy intraday
```

Needs Node >= 22.18 and (without `--csv`) access to `data-api.binance.vision`. Replay has no historical order book,
uses flat fee/slippage, stubs the risk gateway, and is **not** a forecast.

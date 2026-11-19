# ETI chart layer: how the signal engine is reflected in every chart

Every chart on the Cloudflare dashboard (`GET /`) draws the **engine's own per-candle output**. Nothing is
re-derived in the browser: `GET /api/signals` returns a `chart` payload and the dashboard only draws it.

## API

`GET /api/signals?symbol=BTCUSDT&interval=1h&window=120[&provider=binance]`

| Parameter | Default | Range | Notes |
|---|---|---|---|
| `window` | 120 | 30-500 | Number of most recent candles in the `chart` payload. Invalid values return `400 invalid_window`. |

New response fields (existing fields are unchanged):

- `components[]`: signed points per scoring factor (`trend`, `macd`, `rsi`, `breakout`, `breakdown`, `volume`, `adx`, `bearStack`), each with its `max`. Their sum, clamped to +/-100, is `score`.
- `chart`: per-candle series aligned by `times` (candle open, ms): `ema20/50/200`, `bbUpper/Middle/Lower`, `rsi`, `macd`, `macdSignal`, `macdHistogram`, `adx`, `atr`, `volumeRatio`, `breakoutHigh/Low`, `score`, `direction`, `conviction` (final, after the method-disagreement downgrade), `regime` (trend / range / transition), `supporting` / `opposing` (active documented methods for and against the lean), `downgraded` (conviction lowered one tier because more methods opposed than supported), plus `markers[]` (label flips and first high-conviction bars), `replay[]` (walk-forward trades with outcome) and `levels` (entry, stop, TP1-3, 20-candle range).

The last element of every series equals the value in `indicators` / `score` / `conviction` / `regime` of the same response, and the value at any
earlier bar equals what the engine returns when given only the history up to that bar (no look-ahead). Both are
pinned by tests in `worker/signals.test.ts`.

## What each chart shows

| Chart | Engine data drawn |
|---|---|
| Price chart | EMA 20/50/200, Bollinger bands, prior 20-candle high/low, entry/stop/TP1-3 with reward/risk boxes, per-candle BUY/SELL ribbon (opacity = abs(score)), flip and high-conviction markers with score, walk-forward replay trades (win/loss/unresolved), volume bars highlighting the 1.25x relative-volume rule |
| RSI pane | RSI 14 with the engine's +10 (52-70) and -10 (30-48) zones |
| MACD pane | Histogram sign (the +/-14 rule), MACD and signal lines |
| ADX pane | ADX 14 with the 20 threshold (+/-6 rule), the 25 trend line, and a per-candle regime strip (blue trend, amber range, grey transition) showing when breakouts or reversals are suppressed |
| Score pane | Score per candle, +/-30 and +/-55 conviction thresholds, opacity = final conviction, amber dot where method disagreement lowered it |
| Cumulative depth | Price-axis depth with entry/stop/targets (edge arrows with % distance when outside the visible book) and a book-vs-signal alignment note |
| Gauge | Score, thresholds, and the *reachable* range of the current rule set |
| Score breakdown | Points contributed by each factor vs its limit |
| Trade ladder | Stop/entry/TP1-3 in R multiples with current price |

Hover any price or pane chart for a shared crosshair and a tooltip with OHLC, EMAs, Bollinger range, RSI, MACD,
ADX, relative volume, score, conviction, regime and method for/against counts for that candle. Layer chips above the chart toggle each overlay.

## Behaviour notes

- If candles come from a different provider than the signal (failover), the dashboard re-requests the signal with `provider=` and shows a notice if they still differ.
- A new candle on the live stream triggers a debounced signal refresh; candles newer than the last signal simply have no engine overlay.
- Overlays follow the same fail-closed rule as the signal: if the signal is unavailable, charts draw plain candles and say so.
- The score is a heuristic confluence score, not a probability. The replay excludes fees, slippage and funding.

## Known property of the scoring rule (unchanged, now visible on the gauge)

The positive factors sum to +74 while the negative factors sum to -110 (clamped to -100), so the BUY side of the
score can never reach +100. The BUY gate (55) is reachable, but BUY and SELL conviction are not symmetric. This was
left unchanged on purpose; changing it would alter live signals and the historical replay.


## Chart annotation interpretation and trader guidance

The Pro Terminal includes a live **Chart Signal Interpretation** panel. It summarises the selected symbol, venue, market and timeframe using the terminal's current signal, Liquidity-FVG result, SMC structure, order-flow snapshot and independent Omnisignal result. It explains whether the signal is tradeable, blocked, expired or unavailable and gives the next safe action. The panel is read-only.

The expandable glossary covers every chart annotation family emitted by the current terminal and technical overlay: ORDER, ENTRY/CE ENTRY, STOP/SL, TP1-TP3, BSL/SSL, sweeps and estimated sweep reach, FVG, order blocks, BOS/CHoCH, support/resistance, EMA, VWAP, Bollinger Bands, RSI, MACD, ADX, ATR, volume/RVOL, order-book walls/imbalance, delta/CVD/footprint, spread/microprice, funding/open interest, volume-profile POC/VAH/VAL and ETI score/conviction/BUY/SELL/HOLD.

**ORDER safety rule:** a chart label or horizontal line named ORDER is only an annotation/reference unless it can be matched to authenticated venue order data, an order ID and an exchange status. The chart label alone must never be treated as evidence that an order was placed or filled. Liquidity pools, order blocks and estimated sweep reach are analytical approximations, not proof of institutional orders or guaranteed resting liquidity.

Each glossary item explains what it means, why it matters and what the trader should do. When source data is missing, stale or unverified, the panel says so and recommends waiting rather than inventing a market reading.


## Main dashboard Central Market Intelligence and chart explanations

The root dashboard (`/`) surfaces the existing `/api/analysis/intelligence` engine as **Central Market Intelligence** and automatically runs it after validated chart-signal refreshes. It refreshes when the symbol, timeframe, strategy, venue or market changes and no more frequently than once per five minutes for the same selection unless manually refreshed. The selected exchange, spot/futures market and contract category are passed through to multi-timeframe candle loading. The adjacent Chart Signal Interpretation panel explains the current chart signal, CMI verdict, liquidity/FVG qualification, entry/no-entry conditions, exits, invalidation and data-quality state. Its searchable expandable glossary covers ORDER, entry/CE, stop, targets, BSL/SSL, sweeps, estimated sweep reach, FVG, order blocks, BOS/CHoCH, support/resistance, EMA, VWAP, Bollinger Bands, RSI, MACD, ADX, ATR, volume, order book, delta/CVD, spread/microprice, funding/open interest and volume profile. ORDER remains an unverified annotation unless matched to authenticated exchange order ID/status. The UI is read-only and never submits orders.

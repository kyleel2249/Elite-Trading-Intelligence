# Signal Intelligence (`/api/analysis/signal-intel`)

An additive, read-only layer that fuses a full indicator suite with ETI's existing SMC and order-flow engines. It does not replace GainzAlgo, the SMC/FVG layers, the risk engine or any execution path. Every response carries `submitsOrder:false`, `liveExecutionAllowed:false`, `canTriggerTrade:false`.

## Modules
- `worker/analysis/indicator-suite.ts`: EMA 20/50/200, RSI, MACD, ADX/DI, Ichimoku (cloud, 26-bar projection, Chikou), Supertrend, session VWAP, Bollinger, ATR, CCI, OBV, MFI, candle-CVD proxy, swing Fibonacci. All causal.
- `worker/analysis/derivatives-intel.ts`: Bybit public v5 open-interest and funding history, OI regime (long/short build-up, short covering, long liquidation), funding extremes, estimated liquidation zones.
- `worker/analysis/signal-intel.ts`: regime-adaptive weighted fusion, conflict detection, false-signal filters, MTF confluence, walk-forward validation, capped confidence, plan via `computeLevels`.
- `worker/ui/signal-intel-layer.ts`: chart overlays and the explanation panel.

## How a signal is decided
1. Votes (trend / momentum / volatility / volume / structure / order-flow groups). In trending regimes (ADX>=22) trend votes weigh more and oscillators are read as momentum; in ranges (ADX<18) oscillators are read as mean reversion.
2. Fusion score -100..100; direction needs |score|>=30, no material conflict, and at least 3 independent groups agreeing.
3. Blocking filters: stale data, regime forbids entries, conflict, group agreement, minimum confirmations, higher-timeframe opposition (unless a confirmed CHoCH), over-extension (>2.5 ATR from EMA20), extreme volatility, reward/risk < 1.5, negative walk-forward expectancy.
4. Downgrade filters (cap confidence, do not block): small validation sample, wide spread, derivatives crowding.
5. Confidence = evidence quality, capped at 60 without a sufficient walk-forward sample (30+), 72 with one, 90 only if the 95% Wilson lower bound beats breakeven. It is not a probability of profit.

## No repainting
Only closed candles are used. Each marker is computed from data up to its own bar, so later candles never move or remove it (proved by a truncation-invariance test).

## Honest limits
- Candle CVD is a proxy (candles carry no taker side). Exchange-trade delta uses a short recent-trade sample.
- Open interest and funding are Bybit futures only. Bybit has no public REST liquidation history, so liquidation zones are an ESTIMATE from 10/25/50/100x leverage on swing entries; they are labelled as such.
- Validation measures the indicator core only (not SMC/order flow, which lack deep history) with next-bar entry and 12 bps costs.
- Overlays draw on the canvas chart; the optional advanced (lightweight-charts) view is not overlaid.
- Free plan limits candle depth via `planOf`; CPU cost in Workers was not measured here.

## Request
`GET /api/analysis/signal-intel?symbol=BTCUSDT&timeframe=1h&market=futures[&provider=bybit|bitget]`, or `POST` with `candles` (offline analysis, no exchange data).

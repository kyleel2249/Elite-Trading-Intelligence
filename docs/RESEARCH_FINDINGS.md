# Real-data research findings

Source: GitHub Actions workflow "ETI Research", run 42718942068 on commit dab93a8, public Binance candles for BTC, ETH, SOL, BNB and XRP (USDT), trailing 365 days to 2026-11-09. Replay rules: closed candles only, fills at the next bar's open, 0.1% fee and 5 bps slippage per side, cost-aware validator gate on. Reproduce with Actions -> ETI Research -> Run workflow.

## Pooled expectancy across the five symbols (bootstrap 95% interval of mean R per trade)

| Strategy | Variant | Trades | Mean R | 95% interval |
|---|---|---|---|---|
| intraday | swift_only | 432 | -0.081 | -0.19 to +0.03 |
| intraday | gainz_only | 343 | -0.120 | -0.24 to +0.00 |
| intraday | combined | 435 | -0.085 | -0.20 to +0.03 |
| swing | swift_only | 113 | -0.351 | -0.54 to -0.16 |
| swing | gainz_only | 99 | -0.424 | -0.61 to -0.22 |
| swing | combined | 116 | -0.336 | -0.53 to -0.15 |

## Reading
- No variant shows a positive expectancy. Intraday pooled is about -0.08R with an interval that includes zero (consistent with no edge after costs). Swing pooled is about -0.34R with an interval entirely below zero: **swing should not be enabled for paper auto-execution** on current logic.
- Earlier single-symbol positives (e.g. ETH Swift-only +0.05R on one window) did not hold on a re-run a day later with a shifted window. They were noise, which is why single results are not used.
- Strategies lost far less than buy-and-hold over this falling market (every symbol was down 18-56%), but a mostly-flat strategy beating a long-only benchmark in a bear year is not evidence of an edge.
- Limits: one year, one regime (falling), flat fees, no historical order book, risk gateway stubbed. Not a forecast. Confidence scores remain uncalibrated.

## Regime filter: tested on a holdout and not supported (not built)
Hypothesis: skip entries in poorly performing regimes. Procedure fixed in advance: choose regimes from the first half of 435 pooled intraday trades (5 symbols), score on the second half (run 42719680629). Result: after the cost gate, 71% of trades occur in high_volatility (about -0.09R train, -0.13R test); every regime that looked bad in the first half had fewer than 10 trades and did not repeat in the second half (e.g. weak_bearish -0.64R then +0.25R). The earlier "ranging" loss largely disappeared because the cost gate now blocks most of those entries. A filter would have fitted noise, so none was added.

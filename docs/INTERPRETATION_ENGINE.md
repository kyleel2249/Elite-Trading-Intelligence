# ETI Analytical Signal Interpretation Engine

The central Analysis Intelligence response now includes `tradingAdvice`, a deterministic interpretation of the existing technical, fundamental, sentiment, multi-timeframe and Omnisignal evidence.

## Decision states

- `DO_NOT_TRADE`: neutral, conflicted, insufficient, vetoed, or cross-check-disagreeing evidence. No new entry is recommended.
- `WAIT_FOR_BULLISH_CONFIRMATION`: evidence favours a bullish case, but the trader must wait for a completed-candle trigger and retest.
- `WAIT_FOR_BEARISH_CONFIRMATION`: evidence favours a bearish case, but the trader must wait for a completed-candle trigger and retest.

The interpretation explains why the state was selected, entry prerequisites, conditions to avoid, exit/management conditions and invalidation. It explicitly marks exact price levels as unavailable in this layer; it does not fabricate entries, stops or targets from a directional thesis.

## API and dashboard

Use `GET /api/analysis/intelligence?symbol=BTCUSDT&strategy=intraday&detail=full&include=omnisignal`. The existing Analysis Intelligence panel renders the new ETI Trader Guidance section.

The read-only Precision API is mounted at `/api/precision/*`. Its documented scope remains crypto spot; its entry, stop and target prices must not be assumed available for FX, equities or futures.

## Entry rules explained to the trader

A directional thesis is not an entry trigger. The guidance requires a completed setup-timeframe candle, directional structure confirmation (BOS/CHoCH), a controlled retest/retracement into a relevant FVG/order block/level when available, momentum/volume confirmation, no unresolved timeframe conflict, fresh data, acceptable liquidity/spread and positive net reward-to-risk after costs.

## Exit and invalidation guidance

The trader is told to respect the preplanned stop and structural invalidation, take profit at planned liquidity/structure targets, trail only after continuation confirmation, and reassess on opposing structure shifts, stale data, setup expiry or high-impact event risk.

## Safety boundaries

This layer is deterministic and read-only. It does not submit, authorise or trigger orders. Evidence scores remain evidence-quality measures, not probabilities of profit. Missing data is not treated as neutral or as a pass. Actual order placement remains subject to the independent execution and risk preflight.

# ETI Intelligence Roadmap: Phases 4–10

This release adds read-only analytical endpoints. They are currently **input-driven**: callers supply candle, wallet-flow, account-risk, depth and component data. Except where the existing ETI collector already handles a source, these modules do not claim to independently fetch that data. None of the endpoints places orders.

## Phase 4 — Predictive scenarios

`POST /api/forecast/scenarios`

Payload:
```json
{
  "symbol": "BTCUSDT",
  "candles": [{"time": 1760000000000, "open": 100, "high": 102, "low": 98, "close": 101, "volume": 1000}],
  "horizons": ["1h", "4h", "1d"]
}
```

- Candle array: 20–500 OHLCV records, increasing timestamps in milliseconds.
- Horizons: `1h`, `4h`, `1d`; omitted defaults to all three.
- Output: expected price, statistical range, heuristic up/down/neutral scenario shares, directional bias, confidence, expiry and stale-input flag.
- Probability and confidence values are uncalibrated heuristics; not trade odds. No direct order or trade signal.

## Phase 5 — Wallet/whale flows

`POST /api/intelligence/whales`

Payload: `{"flows":[{"wallet":"wallet-or-label","amountUsd":250000,"direction":"inflow","timestamp":1760000000000,"exchange":true}]}`

- Validates and aggregates up to 1,000 supplied flow events from the previous seven days.
- Output includes per-wallet inflow/outflow/net flow, event count, accumulation/distribution/mixed label, exchange-flow totals, large-flow count and ranking.
- Data must be supplied from a verified on-chain source. Wallet labels are not identity verification.

## Phase 6 — Strategy replay lab

`POST /api/intelligence/backtest`

Payload: `{"candles":[{"time":1,"close":100},{"time":2,"close":101}],"options":{"fast":12,"slow":26,"feeBps":8,"slippageBps":5}}`

- 30–2,000 ordered close-price records.
- EMA crossover simulation; defaults fast=12, slow=26; fee and slippage are bounded input assumptions.
- Reports closed trades, win/loss count, win rate, net return, profit factor, maximum drawdown, average closed-trade return and final open position.
- This is a research baseline, not an execution-faithful venue simulator. Funding, partial fills, liquidation, spread/depth and market regimes are not modelled.

## Phase 7 — Capital guard

`POST /api/intelligence/risk`

Payload:
```json
{"equity":1000,"riskPct":0.5,"stopDistancePct":1,"price":100,"dailyLossPct":0,"drawdownPct":0,"leverage":1,"positions":[]}
```

- Advisory risk budget and position sizing from equity, risk percentage and stop distance.
- Veto reasons: daily loss, drawdown, exposure, leverage and position-count thresholds.
- Returns suggested notional and quantity when price is supplied. It does not change existing account risk settings or send orders.

## Phase 8 — Execution cost estimator

`POST /api/intelligence/execution-estimate`

Payload: `{"price":100,"sizeUsd":1000,"side":"buy","spreadBps":12,"depthUsd":50000,"feeBps":8}`

- Estimates spread, depth-based market impact, slippage, fees, total cost and average fill price.
- Missing depth is flagged and causes impact to be under-estimated; treat the result conservatively.
- This is an estimator, not an order book simulator or routing system.

## Phase 9 — Supervised agent gate

`POST /api/intelligence/agent-supervision`

Payload: `{"requestedAction":"live_trade","killSwitch":false,"riskApproved":true,"signalFresh":true,"userPermission":true,"confidence":80}`

- Outputs an advisory action and veto list.
- Live requests remain pending human approval; the route always reports `liveExecutionAuthorized:false`.
- It is not a replacement for the ETI order gateway, existing agent permissions or execution risk checks.

## Phase 10 — Intelligence fusion

`POST /api/intelligence/fusion`

Provide the computed component objects as `forecast`, `whales`, `signal`, `risk`, `execution`, and `agent`.

- Identifies missing inputs and stale forecasts.
- Consolidates direction, risk veto, agent restriction, negative wallet-flow flag and an indicative readiness score.
- Fusion score is a heuristic. It must not be interpreted as a signal probability or bypass risk controls.

## Shared behavior

- JSON POST endpoints, no-store responses and structured error responses.
- Input-driven calculations; API route wrappers do not fetch private credentials.
- New test files cover valid cases, invalid input and control behavior.
- Current scope is service/API functionality. A dedicated UI dashboard, automated upstream collection for every data source, cross-module persistence and integration into live agent/order flows remain separate follow-up work.

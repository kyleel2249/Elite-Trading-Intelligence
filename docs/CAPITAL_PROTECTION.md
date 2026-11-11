# ETI CAPITAL PROTECTION SYSTEM

Capital preservation is mandatory. Every order that could add risk — manual, strategy, automation, emergency —
passes the Capital Protection System (CPS) **and** the existing `RiskEngine` before any broker call. Both must approve.

```
request / strategy / agent
        │  (stop_loss, strategy_id, atr_pct are *inputs to be validated*, never overrides)
        ▼
TradingService.place_order ──► CapitalProtectionService.check_order ──► decision core (pure, no I/O)
        │                                  │  account state from the DATABASE only
        │                                  ▼
        │                         refuse → audit (hash-chained) → status "rejected"
        ▼
RiskEngine (env gates, live confirmation, data freshness) ──► broker
```

Broker-account execution (`app/execution`, modes 2 and 3) is gated too: its `risk_gate` evaluates the order with the
Capital Protection System on **live broker equity and positions**, and the execution supervisor runs an emergency tick that
calls the engine's own `emergency_flatten` when the emergency drawdown / daily-loss threshold is crossed. Stop-loss,
take-profit and `atr_pct` are read from `OrderIntent.meta` and validated (never trusted). Not tracked from broker data alone, so
**not enforced on that path**: weekly loss, consecutive-loss streak, and stop-breach liquidation of existing broker positions.
Manual live orders need a registered strategy (register one named `manual` through the admin route if you want them).

The live path is the same: the Cloudflare Worker's `/api/risk-gateway/preflight` call includes the CPS verdict
(`capital_protection` in the response), and any CPS violation sets `approved:false`.

## What it enforces

| Rule | Default (conservative) | Hard ceiling |
|---|---|---|
| Max risk per trade (volatility-adjusted) | 0.5 % of equity | 2 % |
| Max daily loss (realised + open losses) | 2 % | 5 % |
| Max weekly loss | 5 % | 10 % |
| Max portfolio drawdown (from persisted high-water mark) | 10 % | 25 % |
| Max open positions | 5 | 20 |
| Max correlated exposure (net, per correlation bucket) | 20 % | 50 % |
| Max leverage (gross / equity) | 1.0× | 3.0× |
| Max single-position notional | 6 % | 25 % |
| Consecutive-loss protection | pause after 3 losses for 240 min; size halved at n-1 | 10 |
| Emergency liquidation | drawdown ≥ 12 % or daily loss ≥ 4 % → halt + flatten | 30 % / 10 % |
| Stop-loss | required on every entry; 0.1 %–10 % from entry; not inside 0.5×ATR | — |
| Extreme volatility | no entries when ATR% ≥ 12 | 30 |
| Sessions | US equities only inside regular hours ± 15 min; custom UTC blocked windows | — |
| News | no entries ±30 min around high-impact events; live requires a calendar refreshed within 48 h | — |

Configure with `CPS_*` variables (see `.env.example`). Values are **clamped** to the ceilings above in
`app/risk/protection_policy.py`; invalid, `NaN` or out-of-range values fall back to safe values, and the response lists
which were clamped. The policy is a frozen dataclass whose fingerprint is recorded on every decision.

**Sizing** — `POST /api/capital-protection/size` returns the largest permitted quantity and the binding constraint
(risk, notional, leverage or correlation). Risk shrinks as ATR% rises above `CPS_TARGET_VOLATILITY_PCT`.

**Exits are never blocked.** An order that strictly reduces an existing position (verified against server-side
positions) is always allowed, even when halted. An order larger than the open opposite position is refused (submit the
close and the new entry separately).

**Stop-loss enforcement** — every sweep (after each mark-to-market cycle, and `POST /api/capital-protection/sweep`)
liquidates positions whose mark price crossed their stop, and attaches a protective default stop to any legacy
position that has none.

## Independence from the language model and signal engines

* The decision core (`protection.py`, `protection_policy.py`, `quarantine.py`, `data_integrity.py`) is standard-library
  only: no database, network, council, signal-engine or LLM imports. `tests/test_capital_protection_independence.py`
  parses the source to enforce this.
* The policy is built only from server settings. No request body, strategy output or agent message can construct or
  change it; order intents have no override field; `TradingService.place_order` has no bypass parameter, and it is the
  only code allowed to call a broker's `submit_order` (tested).
* Account state (equity, positions, PnL, drawdown, loss streak, halt) is read from the database, never from the caller.
* Any internal error is a **refusal** (fail closed).
* **Tightening needs no authority; loosening needs a human.** Halting, quarantining, sweeping and dry-run evaluation
  work with the general `X-API-Key`. Releasing a halt, registering a strategy, review/revalidation and refreshing the
  news calendar require `X-CPS-Admin-Key` = `CPS_ADMIN_KEY` — a separate secret (≥ 16 chars, must differ from `API_KEY`).
  Without it those routes return 503. Never give it to an AI agent, automation or the Worker.
* Every refusal, halt, release, quarantine and review step is written to a hash-chained audit table
  (`GET /api/capital-protection/audit` verifies the chain).

## Strategy elimination (quarantine)

A strategy is registered by a human with its **validated expectations** (win rate, profit factor, drawdown threshold,
slippage and reject tolerances, validated regimes/volatility range, and a reference to the validation report).
ETI then evaluates it continuously (`POST /api/capital-protection/strategies/{id}/evaluate`, and after every sweep) and
**quarantines** it when:

| Trigger | Test |
|---|---|
| Performance deteriorates | rolling 20-trade profit factor < 0.8 with negative expectancy |
| Live diverges from validation | one-sided win-rate z-test ≤ −2.33 (n ≥ 20), or PF < 50 % of validated and < 1 (n ≥ 30) |
| Drawdown breach | strategy drawdown ≥ its predefined threshold (no minimum sample) |
| Execution quality | average slippage above tolerance, or order failure rate above tolerance |
| Assumptions invalidated | regime / volatility outside validated range for 3 consecutive observations, or flagged assumptions |
| Data integrity | any flag: NaN, bad OHLC, duplicate/out-of-order bars, gaps, stale data |

A quarantined strategy cannot open positions (CPS refuses its orders; exits still work). Live orders must name a
registered, `ACTIVE` strategy. Release path (all human-authorised, each step audited):

`QUARANTINED → UNDER_REVIEW` (`/review`) `→ REVALIDATING` (`/approve-revalidation`, with root cause + notes) `→ ACTIVE`
(`/complete-revalidation`). While `REVALIDATING` the strategy may trade **paper/testnet only**. Release succeeds only if
fresh post-quarantine evidence (≥ 30 trades, PF ≥ 1.2, cooling-off ≥ 24 h) passes every quarantine test again; monitoring
then restarts from a fresh baseline so old losses cannot re-trigger it. A strategy cannot re-register itself around the gate.

## Known limits (honest)

* Correlation buckets are a static heuristic (all crypto together; equity sectors/indices), not a computed matrix.
* Live equity comes from `LIVE_ACCOUNT_EQUITY` (no broker sync yet); without it live entries are refused (fail closed).
* The news calendar is loaded by an operator/integration through the admin route; there is no built-in economic-calendar feed.
* Equity session logic covers regular US hours and weekends, not exchange holidays.
* The Cloudflare Worker's *paper* orders skip the preflight by design (upstream decision); only live orders are gated there.
* Strategy attribution requires callers to pass `strategy_id`; the built-in `StrategyRunner` does.

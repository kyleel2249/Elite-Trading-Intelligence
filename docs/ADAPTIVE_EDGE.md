# ETI Adaptive Edge Discovery & Evolution Engine

Independent authority that continuously:

1. Detects market regime changes (multi-label, probabilistic)
2. Raises early warnings via multi-evidence change detection (CUSUM, vol expansion, regime shift, strategy health)
3. Monitors per-strategy edge health (costs, sample size, alpha decay, regime fit)
4. Discovers new research hypotheses across technical, fundamental, institutional, sentiment, and cross-asset families
5. Prototypes, backtests, walk-forward and out-of-sample validates candidates in the Research Lab
6. Promotes only through staged gates (autonomous max = **PAPER_TRADING**)
7. Selects / rotates / suspends strategies with statistical thresholds
8. Proposes portfolio adaptations (cash is allowed; 6% single-name cap)
9. Competes strategies under comparable assumptions
10. Accumulates an auditable knowledge base of successes **and** failures

## Governance (hard rules)

- The Adaptive Edge Engine **may suspend** strategies and **propose** replacements.
- It **cannot** authorize its own live deployment (`StrategyPromotionAuthority.can_authorize_live() == False`).
- Every order must still pass the in-process `RiskEngine` inside the execution path (no separate gateway service exists).
- Max individual position allocation remains **6%** of bankroll.
- Live trading remains disabled by default (`LIVE_TRADING_ENABLED=false`).

## Live trading & brokers

- `KILL_SWITCH` halts all submissions.
- Live requires `LIVE_TRADING_ENABLED`, provider live flags, **limit** orders, and `live_confirmed=true`.
- Alpaca/Binance equity sync when `USE_BROKER_EQUITY_FOR_LIVE=true`.
- No withdraw/transfer endpoints.
- `GET /api/trading/broker-status` for readiness.

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/adaptive-edge/health` | Module health + governance flags |
| GET | `/api/adaptive-edge/dashboard` | Command-center aggregate |
| GET | `/api/adaptive-edge/events` | Audit trail |
| GET | `/api/adaptive-edge/promotion/policy` | Stage policy |
| POST | `/api/adaptive-edge/cycle` | Full adaptive cycle |
| GET | `/api/trading/broker-status` | Broker connectivity |
| POST | `/api/trading/order` | Risk-gated paper/live orders |
| POST | `/api/pretrade/check` | Dry-run of the in-process risk engine (never submits an order; no execution path depends on it) |

## Tests

```bash
pytest tests/test_adaptive_edge.py tests/test_live_broker_gates.py -q
```

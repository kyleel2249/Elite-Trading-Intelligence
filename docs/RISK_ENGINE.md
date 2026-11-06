# Risk Engine

The RiskEngine is the final authority on every order (paper, testnet, live).

## Checks

- Positive quantity and valid side
- Positive equity for sizing
- Max open positions
- Max daily loss %
- Max portfolio drawdown %
- Risk per trade % (default 1%)
- Live-only: data freshness and data status
- Environment / flag consistency (e.g. Alpaca paper flag vs live request)

## Usage

```python
from app.risk import RiskEngine, OrderProposal

engine = RiskEngine()
decision = engine.evaluate(OrderProposal(...))
if decision.approved:
    # submit to provider
    ...
else:
    # log decision.reasons and block
    ...
```

No order path (including future live paths) may bypass this engine.

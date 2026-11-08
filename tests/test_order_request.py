"""POST /api/trading/order input validation (schema level)."""
import pytest
from pydantic import ValidationError

from app.main import OrderRequest


def _base(**overrides):
    body = {"provider": "binance", "environment": "paper", "symbol": "BTCUSDT", "side": "buy", "qty": 0.01}
    body.update(overrides)
    return body


def test_valid_request_is_normalized():
    req = OrderRequest(**_base(provider=" Binance ", environment="PAPER", side="BUY", order_type="MARKET"))
    assert (req.provider, req.environment, req.side, req.order_type) == ("binance", "paper", "buy", "market")


@pytest.mark.parametrize("bad", [
    {"qty": 0}, {"qty": -1}, {"qty": float("inf")}, {"qty": float("nan")},
    {"environment": "mainnet"}, {"provider": "kraken"}, {"side": "hold"},
    {"symbol": ""}, {"symbol": "BTC USDT; DROP"}, {"order_type": "Market;"},
])
def test_invalid_requests_rejected(bad):
    with pytest.raises(ValidationError):
        OrderRequest(**_base(**bad))


def test_limit_order_requires_price():
    with pytest.raises(ValidationError):
        OrderRequest(**_base(order_type="limit"))
    assert OrderRequest(**_base(order_type="limit", limit_price=50000.0)).limit_price == 50000.0


def test_deprecated_client_risk_fields_still_accepted():
    req = OrderRequest(**_base(equity=1e12, current_open_positions=0, daily_realized_pnl_pct=0.0,
                               current_drawdown_pct=0.0, data_age_seconds=1.0, data_status="fresh"))
    assert req.equity == 1e12  # accepted for compatibility; the endpoint ignores it

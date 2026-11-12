"""USDT amount -> quantity conversion for POST /api/trading/order."""
import pytest
from pydantic import ValidationError

from app.main import OrderRequest
from app.trading.sizing import SizingError, quote_to_qty


def _base(**kw):
    body = {"provider": "binance", "environment": "paper", "symbol": "BTCUSDT", "side": "buy"}
    body.update(kw)
    return body


def test_converts_usdt_to_quantity():
    r = quote_to_qty(1000, 50000, "BTCUSDT")
    assert r["qty"] == 0.02 and r["estimated_notional_usdt"] == 1000.0 and r["quote_currency"] == "USDT"


def test_quantity_rounds_down_never_exceeding_the_amount():
    r = quote_to_qty(100, 30000, "BTCUSDT")      # 0.003333333...
    assert r["qty"] == 0.00333333
    assert r["estimated_notional_usdt"] <= 100


@pytest.mark.parametrize("amount,price,symbol", [
    (0, 100, "BTCUSDT"), (-5, 100, "BTCUSDT"), (10, 0, "BTCUSDT"), (10, None, "BTCUSDT"),
    (float("nan"), 100, "BTCUSDT"), (1e-12, 100000, "BTCUSDT"), (10, 100, "AAPL"), (10, 100, "EUR_USD"),
])
def test_bad_conversions_are_refused(amount, price, symbol):
    with pytest.raises(SizingError):
        quote_to_qty(amount, price, symbol)


def test_order_request_accepts_exactly_one_of_qty_or_quote_amount():
    assert OrderRequest(**_base(quote_amount=250.0)).quote_amount == 250.0
    assert OrderRequest(**_base(qty=0.01)).qty == 0.01
    with pytest.raises(ValidationError):
        OrderRequest(**_base())
    with pytest.raises(ValidationError):
        OrderRequest(**_base(qty=0.01, quote_amount=250.0))


@pytest.mark.parametrize("bad", [0, -1, float("inf"), float("nan")])
def test_invalid_quote_amount_rejected(bad):
    with pytest.raises(ValidationError):
        OrderRequest(**_base(quote_amount=bad))

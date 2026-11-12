from app.market.data_quality import validate_ohlc, assess_kline
from app.market.normalization import normalize_order_book


def test_valid_ohlc():
    assert validate_ohlc(10, 12, 9, 11) == []


def test_invalid_ohlc():
    issues = validate_ohlc(10, 9, 11, 10)
    assert "high_lt_low" in issues or "invalid_ohlc_relationship" in issues


def test_order_book_metrics():
    bids = [[100.0, 2.0], [99.5, 1.0]]
    asks = [[100.5, 1.5], [101.0, 3.0]]
    book = normalize_order_book("binance", "BTCUSDT", bids, asks, depth=10)
    assert book["best_bid"] == 100.0
    assert book["best_ask"] == 100.5
    assert book["spread"] == 0.5
    assert book["bid_volume"] == 3.0
    assert "imbalance" in book


def test_assess_kline_flags_invalid():
    k = {"open": 1, "high": 0.5, "low": 0.4, "close": 0.9, "close_time": 0}
    out = assess_kline(k)
    assert out["data_status"] == "invalid"


import pytest
from datetime import datetime, timezone, timedelta
from app.market.data_quality import assess_quote
from app.integrations.base import NormalizedQuote


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_ohlc_invalid(value):
    assert "non_finite_price" in validate_ohlc(10, 12, 9, value)


def _quote(price=100, bid=99, ask=101, ts=None):
    now = datetime.now(timezone.utc)
    return NormalizedQuote("binance", "BTCUSDT", "BTCUSDT", "crypto", price, bid, ask, None, now, ts or now, now, "fresh")


@pytest.mark.parametrize("field", ["price", "bid", "ask"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), 0, -1])
def test_invalid_quote_prices(field, value):
    q = _quote()
    setattr(q, field, value)
    assert assess_quote(q).data_status == "invalid"


def test_quote_timezone_is_converted_not_relabelled():
    ts = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5)))
    assert assess_quote(_quote(ts=ts)).data_status == "fresh"

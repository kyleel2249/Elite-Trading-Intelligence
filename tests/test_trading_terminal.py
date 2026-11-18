import pytest
from fastapi import HTTPException

from app.api.trading_terminal import INTERVALS, validate_category


def test_bybit_terminal_categories_are_exchange_specific():
    assert validate_category("bybit", "spot") == "spot"
    assert validate_category("bybit", "linear") == "linear"
    assert validate_category("bybit", "inverse") == "inverse"


def test_bitget_terminal_categories_are_exchange_specific():
    assert validate_category("bitget", "spot") == "spot"
    assert validate_category("bitget", "usdt-futures") == "usdt-futures"


@pytest.mark.parametrize(("exchange", "category"), [
    ("bybit", "usdt-futures"),
    ("bitget", "inverse"),
    ("bitget", "linear"),
])
def test_terminal_rejects_cross_exchange_categories(exchange, category):
    with pytest.raises(HTTPException) as exc:
        validate_category(exchange, category)
    assert exc.value.status_code == 422


def test_terminal_interval_mapping_covers_supported_timeframes():
    assert INTERVALS["1h"] == ("60", "1H")
    assert INTERVALS["1d"] == ("D", "1D")
    assert "1w" in INTERVALS

from decimal import Decimal

import pytest

from app.quant.binance_exits import (base_qty_after_fees, build_oco_params, fmt, parse_symbol_filters,
                                     plan_exit_oco, protective_from_oco, round_down)

FILTERS = dict(tick_size="0.01", step_size="0.001", min_qty="0.001", min_notional="5")


def test_formatting_and_rounding_never_use_scientific_notation():
    assert fmt(Decimal("0.00001000")) == "0.00001"
    assert fmt(1e-8) == "0.00000001"
    assert fmt("100.00") == "100"
    assert round_down(0.12399, "0.001") == Decimal("0.123")
    assert round_down(101.999, "0.01") == Decimal("101.99")


def test_commission_in_base_asset_reduces_sellable_quantity():
    fills = [{"commission": "0.0005", "commissionAsset": "BTC"}, {"commission": "0.3", "commissionAsset": "BNB"}]
    assert base_qty_after_fees(0.5, fills, "BTC") == Decimal("0.4995")
    assert base_qty_after_fees(0.5, [{"commission": "0.1", "commissionAsset": "USDT"}], "BTC") == Decimal("0.5")
    assert base_qty_after_fees(0.5, None, "BTC") == Decimal("0.5")


def test_plan_is_rounded_and_orders_prices_correctly():
    p = plan_exit_oco(qty=Decimal("0.4995"), take_profit=110.555, stop_price=95.004, last_price=100.0, **FILTERS)
    assert p["quantity"] == Decimal("0.499") and p["take_profit"] == Decimal("110.55")
    assert p["stop"] == Decimal("95.00") and p["stop_limit"] < p["stop"]


@pytest.mark.parametrize("tp,stop,last", [(99.0, 95.0, 100.0), (110.0, 101.0, 100.0), (110.0, 100.0, 100.0)])
def test_plan_refuses_prices_binance_would_reject_or_trigger_instantly(tp, stop, last):
    with pytest.raises(ValueError):
        plan_exit_oco(qty=Decimal("1"), take_profit=tp, stop_price=stop, last_price=last, **FILTERS)


def test_plan_refuses_dust_and_min_notional():
    with pytest.raises(ValueError):
        plan_exit_oco(qty=Decimal("0.0004"), take_profit=110, stop_price=95, last_price=100, **FILTERS)
    with pytest.raises(ValueError):
        plan_exit_oco(qty=Decimal("0.01"), take_profit=110, stop_price=95, last_price=100, **FILTERS)  # $0.95 < $5


def test_oco_params_use_new_order_list_form_for_a_sell_exit():
    p = plan_exit_oco(qty=Decimal("0.5"), take_profit=110, stop_price=95, last_price=100, **FILTERS)
    q = build_oco_params("btcusdt", p, 1700000000000, "eti-x")
    assert q["side"] == "SELL" and q["symbol"] == "BTCUSDT"
    assert q["aboveType"] == "LIMIT_MAKER" and q["abovePrice"] == "110"
    assert q["belowType"] == "STOP_LOSS_LIMIT" and q["belowStopPrice"] == "95" and q["belowTimeInForce"] == "GTC"
    assert Decimal(q["belowPrice"]) < Decimal(q["belowStopPrice"]) and q["listClientOrderId"] == "eti-x"
    assert "stopPrice" not in q and "price" not in q       # legacy single-leg fields are not used


def test_exchange_info_filters_parsed_and_missing_symbol_rejected():
    info = {"symbols": [{"baseAsset": "BTC", "quoteAsset": "USDT", "filters": [
        {"filterType": "PRICE_FILTER", "tickSize": "0.01"}, {"filterType": "LOT_SIZE", "stepSize": "0.00001", "minQty": "0.00001"},
        {"filterType": "NOTIONAL", "minNotional": "5.0"}]}]}
    f = parse_symbol_filters(info)
    assert f["base_asset"] == "BTC" and f["tick_size"] == "0.01" and f["min_notional"] == "5.0"
    with pytest.raises(ValueError):
        parse_symbol_filters({"symbols": []})


def test_attached_only_when_binance_returns_an_order_list():
    assert protective_from_oco({})["status"] == "requested_unconfirmed"
    ok = protective_from_oco({"orderListId": 7, "listOrderStatus": "EXECUTING", "orders": [{"orderId": 1}, {"orderId": 2}]})
    assert ok["status"] == "attached" and ok["orders"] == [1, 2]

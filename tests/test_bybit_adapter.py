import hashlib
import hmac
import json
from unittest.mock import AsyncMock

import pytest

from app.execution.adapters.bybit import BybitAdapter
from app.execution.domain import OrderType, Side, OrderStatus, Quote, InstrumentRules


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


def test_bybit_signature_matches_v5_hmac():
    transport = FakeTransport([(200, {"retCode": 0, "result": {"list": [{"bid1Price": "10", "ask1Price": "11"}]}})])
    adapter = BybitAdapter("key", "secret", testnet=True, transport=transport, clock_ms=lambda: 123)
    import asyncio
    asyncio.run(adapter.get_quote("BTCUSDT"))
    headers = transport.calls[0][2]["headers"]
    expected = hmac.new(b"secret", b"123key5000category=spot&symbol=BTCUSDT", hashlib.sha256).hexdigest()
    assert headers["X-BAPI-SIGN"] == expected
    assert transport.calls[0][1].startswith("https://api-testnet.bybit.com/")


@pytest.mark.asyncio
async def test_bybit_quote_and_order_book_normalize():
    transport = FakeTransport([
        (200, {"retCode": 0, "result": {"list": [{"bid1Price": "100", "ask1Price": "102", "lastPrice": "101"}]}}),
        (200, {"retCode": 0, "result": {"b": [["100", "2"]], "a": [["102", "3"]]}}),
    ])
    adapter = BybitAdapter("k", "s", transport=transport)
    q = await adapter.get_quote("BTCUSDT")
    book = await adapter.get_order_book("BTCUSDT")
    assert isinstance(q, Quote) and q.provider == "bybit" and q.mid == 101
    assert book.bids[0] == (100.0, 2.0)


@pytest.mark.asyncio
async def test_bybit_instrument_rules_use_lot_and_price_filters():
    transport = FakeTransport([(200, {"retCode": 0, "result": {"list": [{
        "lotSizeFilter": {"qtyStep": "0.001", "minOrderQty": "0.01", "minNotionalValue": "5"},
        "priceFilter": {"tickSize": "0.1"}}]}})])
    adapter = BybitAdapter("k", "s", category="linear", transport=transport)
    rules = await adapter.get_rules("BTCUSDT")
    assert rules == InstrumentRules(tick_size=0.1, step_size=0.001, min_qty=0.01, min_notional=5)


@pytest.mark.asyncio
async def test_bybit_order_is_idempotently_linked_and_testnet_only_by_default():
    transport = FakeTransport([(200, {"retCode": 0, "result": {"orderId": "abc", "orderLinkId": "eti-order-1"}})])
    adapter = BybitAdapter("k", "s", transport=transport)
    order = await adapter.submit_order(client_order_id="eti-order-1", symbol="BTCUSDT", side=Side.BUY,
                                       qty=0.01, order_type=OrderType.MARKET, limit_price=None)
    method, url, kwargs = transport.calls[0]
    payload = json.loads(kwargs["data"])
    assert url.startswith("https://api-testnet.bybit.com/")
    assert payload["orderLinkId"] == "eti-order-1"
    assert payload["marketUnit"] == "baseCoin"
    assert order.provider_order_id == "abc"
    assert order.status == OrderStatus.SUBMITTED


@pytest.mark.asyncio
async def test_bybit_linear_reduce_only_is_explicit():
    transport = FakeTransport([(200, {"retCode": 0, "result": {"orderId": "fut-1"}})])
    adapter = BybitAdapter("k", "s", category="linear", transport=transport)
    await adapter.submit_order(client_order_id="eti-order-2", symbol="BTCUSDT", side=Side.SELL,
                               qty=0.01, order_type=OrderType.LIMIT, limit_price=70000, reduce_only=True)
    payload = json.loads(transport.calls[0][2]["data"])
    assert payload["category"] == "linear"
    assert payload["reduceOnly"] is True
    assert payload["timeInForce"] == "IOC"


@pytest.mark.asyncio
async def test_bybit_unknown_order_outcome_is_not_blindly_retried():
    from app.execution.errors import UnknownOutcomeError
    class LostTransport:
        async def request(self, *args, **kwargs):
            raise UnknownOutcomeError("lost response")
    adapter = BybitAdapter("k", "s", transport=LostTransport())
    with pytest.raises(UnknownOutcomeError):
        await adapter.submit_order(client_order_id="eti-order-3", symbol="BTCUSDT", side=Side.BUY,
                                   qty=0.01, order_type=OrderType.MARKET, limit_price=None)

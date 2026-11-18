import json

import pytest

from app.integrations.bybit.websocket import BybitWebSocketManager


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))


@pytest.mark.parametrize("category", ["spot", "linear", "inverse"])
def test_manager_uses_category_specific_v5_stream(category):
    manager = BybitWebSocketManager(category=category)
    assert manager.base.endswith("/v5/public/" + category)


def test_manager_rejects_unknown_category():
    with pytest.raises(ValueError):
        BybitWebSocketManager(category="option")


def test_subscribe_is_deduplicated_and_ignores_invalid_symbols():
    manager = BybitWebSocketManager("linear")
    manager.subscribe(["BTCUSDT", "btcusdt", "ETH-USDT", ""])
    assert manager.status()["subscriptions"] == [
        "tickers.BTCUSDT", "publicTrade.BTCUSDT", "orderbook.1.BTCUSDT"
    ]


@pytest.mark.asyncio
async def test_new_symbols_are_subscribed_after_socket_is_already_connected():
    manager = BybitWebSocketManager("linear")
    socket = FakeSocket()
    manager._ws = socket
    manager.subscribe(["BTCUSDT"])
    await manager._sync_subscriptions()
    manager.subscribe(["ETHUSDT"])
    await manager._sync_subscriptions()
    assert len(socket.sent) == 2
    assert socket.sent[0]["op"] == "subscribe"
    assert socket.sent[1]["op"] == "subscribe"
    assert socket.sent[1]["args"] == [
        "orderbook.1.ETHUSDT", "publicTrade.ETHUSDT", "tickers.ETHUSDT"
    ]


@pytest.mark.asyncio
async def test_removed_symbols_are_unsubscribed_without_dropping_other_symbols():
    manager = BybitWebSocketManager("spot")
    socket = FakeSocket()
    manager._ws = socket
    manager.subscribe(["BTCUSDT", "ETHUSDT"])
    await manager._sync_subscriptions()
    manager.unsubscribe(["BTCUSDT"])
    await manager._sync_subscriptions()
    assert socket.sent[-1]["op"] == "unsubscribe"
    assert set(socket.sent[-1]["args"]) == {
        "tickers.BTCUSDT", "publicTrade.BTCUSDT", "orderbook.1.BTCUSDT"
    }
    assert set(manager.status()["subscriptions"]) == {
        "tickers.ETHUSDT", "publicTrade.ETHUSDT", "orderbook.1.ETHUSDT"
    }


def test_status_reports_connected_category_and_subscription_state():
    manager = BybitWebSocketManager("inverse", testnet=True)
    manager.subscribe(["BTCUSD"])
    state = manager.status()
    assert state["provider"] == "bybit"
    assert state["category"] == "inverse"
    assert state["testnet"] is True
    assert state["connected"] is False
    assert len(state["subscriptions"]) == 3


@pytest.mark.asyncio
async def test_large_watchlist_changes_are_split_into_bounded_topic_batches():
    manager = BybitWebSocketManager("linear")
    socket = FakeSocket()
    manager._ws = socket
    manager.subscribe(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"])
    await manager._sync_subscriptions()
    assert [len(message["args"]) for message in socket.sent] == [10, 2]
    assert all(message["op"] == "subscribe" for message in socket.sent)
    assert len(manager.status()["active_subscriptions"]) == 12

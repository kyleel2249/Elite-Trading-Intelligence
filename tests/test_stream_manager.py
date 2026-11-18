import pytest

from app.streaming import manager as stream_manager


def test_stream_hub_creates_spot_linear_and_inverse_bybit_streams():
    hub = stream_manager.StreamHub()
    assert set(hub.bybit_streams) == {"spot", "linear", "inverse"}
    assert hub.bybit is hub.bybit_streams["spot"]


def test_bybit_normalization_keeps_market_category_and_quote_fields():
    quote = stream_manager.StreamHub._normalize_bybit({
        "category": "linear", "topic": "tickers.BTCUSDT", "symbol": "BTCUSDT",
        "bid1Price": "99", "ask1Price": "101", "lastPrice": "100", "volume24h": "25",
    })
    assert quote["provider"] == "bybit"
    assert quote["category"] == "linear"
    assert quote["symbol"] == "BTCUSDT"
    assert quote["price"] == 100
    assert quote["bid"] == 99
    assert quote["ask"] == 101


def test_live_quote_lookup_can_select_spot_or_linear_for_the_same_symbol():
    hub = stream_manager.StreamHub()
    spot = {"provider": "bybit", "category": "spot", "symbol": "BTCUSDT", "price": 100,
            "bid": 99, "ask": 101, "ts": "2026-11-17T10:00:00+00:00"}
    linear = {**spot, "category": "linear", "price": 101, "bid": 100, "ask": 102}
    hub.bybit_quotes_by_market["spot:BTCUSDT"] = spot
    hub.bybit_quotes_by_market["linear:BTCUSDT"] = linear
    assert hub.get_live("BTCUSDT", provider="bybit", category="spot")["price"] == 100
    assert hub.get_live("BTCUSDT", provider="bybit", category="linear")["price"] == 101
    assert hub.get_live("BTCUSDT", provider="bybit")["category"] == "spot"


@pytest.mark.asyncio
async def test_subscription_uses_live_category_catalogue_not_a_small_static_allowlist(monkeypatch):
    async def fake_catalogue(provider, settings):
        assert provider == "bybit"
        return [
            {"symbol": "SOLUSDT", "market": "linear"},
            {"symbol": "BTCUSDT", "market": "spot"},
        ], {"status": "ok"}

    monkeypatch.setattr(stream_manager, "get_bybit_symbol_source", fake_catalogue)
    hub = stream_manager.StreamHub()
    result = await hub.subscribe(["SOLUSDT"], provider="bybit", category="linear")
    assert result["accepted"] == ["SOLUSDT"]
    assert result["rejected"] == []
    assert "SOLUSDT" in hub._bybit_symbols_by_category["linear"]
    assert "tickers.SOLUSDT" in hub.bybit_streams["linear"].status()["subscriptions"]


@pytest.mark.asyncio
async def test_subscription_rejects_a_symbol_not_listed_in_the_requested_category(monkeypatch):
    async def fake_catalogue(provider, settings):
        return [{"symbol": "BTCUSDT", "market": "spot"}], {"status": "ok"}

    monkeypatch.setattr(stream_manager, "get_bybit_symbol_source", fake_catalogue)
    hub = stream_manager.StreamHub()
    result = await hub.subscribe(["BTCUSDT"], provider="bybit", category="inverse")
    assert result["accepted"] == []
    assert result["rejected"] == [{"symbol": "BTCUSDT", "reason": "not_listed_in_category"}]


def test_status_exposes_each_bybit_category_separately():
    hub = stream_manager.StreamHub()
    status = hub.status()
    assert set(status["bybit_categories"]) == {"spot", "linear", "inverse"}
    assert status["bybit_categories"]["inverse"]["category"] == "inverse"

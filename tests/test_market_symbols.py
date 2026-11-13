"""Symbol discovery: Binance pairs, Alpaca stocks (config-gated), staleness and the public-history route."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.market import binance_hosts as bh
from app.market import symbols as sym

INFO = {"symbols": [
    {"symbol": "BTCUSDT", "status": "TRADING", "baseAsset": "BTC", "quoteAsset": "USDT", "isSpotTradingAllowed": True},
    {"symbol": "ETHBTC", "status": "TRADING", "baseAsset": "ETH", "quoteAsset": "BTC", "isSpotTradingAllowed": True},
    {"symbol": "NEWUSDT", "status": "TRADING", "baseAsset": "NEW", "quoteAsset": "USDT", "isSpotTradingAllowed": True},
    {"symbol": "OLDUSDT", "status": "BREAK", "baseAsset": "OLD", "quoteAsset": "USDT", "isSpotTradingAllowed": True},
    {"symbol": "MARGINONLYUSDT", "status": "TRADING", "baseAsset": "M", "quoteAsset": "USDT", "isSpotTradingAllowed": False},
]}
ASSETS = [{"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "tradable": True},
          {"symbol": "HALT", "name": "Halted Corp", "exchange": "NYSE", "tradable": False}]


def transport(payload, status=200):
    return httpx.MockTransport(lambda req: httpx.Response(status, json=payload))


@pytest.fixture(autouse=True)
def clear_cache(monkeypatch):
    monkeypatch.delenv("ETI_BINANCE_PUBLIC_HOSTS", raising=False)
    sym._cache.clear()
    bh.reset()
    yield
    sym._cache.clear()
    bh.reset()


def settings(**kw):
    return Settings(_env_file=None, **kw)


def test_binance_lists_only_tradable_spot_pairs():
    items = asyncio.run(sym._fetch_binance(transport(INFO)))
    assert [i["symbol"] for i in items] == ["BTCUSDT", "ETHBTC", "NEWUSDT"]
    assert items[1]["base"] == "ETH" and items[1]["quote"] == "BTC"


def test_symbol_list_survives_a_blocked_first_host_and_reports_which_host_served_it():
    def handler(req):
        if req.url.host == "api.binance.com":
            return httpx.Response(451, json={"msg": "restricted location"})
        return httpx.Response(200, json=INFO)
    items, meta = asyncio.run(sym.get_source("binance", settings(), transport=httpx.MockTransport(handler)))
    assert len(items) == 3 and meta["status"] == "ok" and meta["host"] == "https://api-gcp.binance.com"


def test_symbol_list_says_location_block_when_every_host_refuses():
    items, meta = asyncio.run(sym.get_source("binance", settings(), transport=transport({"msg": "no"}, 451)))
    assert items == [] and meta["status"] == "unavailable" and "location" in meta["message"]


def test_search_by_text_and_quote_prefers_prefix_matches():
    items = asyncio.run(sym._fetch_binance(transport(INFO)))
    assert [i["symbol"] for i in sym.search(items, "eth")] == ["ETHBTC"]
    assert [i["symbol"] for i in sym.search(items, quote="usdt")] == ["BTCUSDT", "NEWUSDT"]
    assert [i["symbol"] for i in sym.search(items, "BTC")] == ["BTCUSDT", "ETHBTC"]


def test_alpaca_is_not_configured_without_keys_and_never_fakes_a_list():
    items, meta = asyncio.run(sym.get_source("alpaca", settings(alpaca_api_key=None, alpaca_secret_key=None)))
    assert items == [] and meta["status"] == "not_configured"


def test_alpaca_lists_only_tradable_stocks_when_configured():
    s = settings(alpaca_api_key="k", alpaca_secret_key="s")
    items = asyncio.run(sym._fetch_alpaca(s, transport(ASSETS)))
    assert [i["symbol"] for i in items] == ["AAPL"] and items[0]["name"] == "Apple Inc."
    assert [i["symbol"] for i in sym.search(items, "apple")] == ["AAPL"]


def test_failure_without_cache_is_unavailable_and_with_cache_is_labelled_stale(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(sym, "_fetch_binance", boom)
    items, meta = asyncio.run(sym.get_source("binance", settings()))
    assert items == [] and meta["status"] == "unavailable"

    sym._cache["binance"] = {"items": [{"provider": "binance", "symbol": "BTCUSDT", "quote": "USDT"}], "at": 0.0}  # long expired
    items, meta = asyncio.run(sym.get_source("binance", settings()))
    assert len(items) == 1 and meta["status"] == "stale"


def test_fresh_cache_is_used_and_refresh_respects_the_minimum_interval(monkeypatch):
    calls = []

    async def fake(*a, **k):
        calls.append(1)
        return [{"provider": "binance", "symbol": "BTCUSDT", "quote": "USDT"}]
    monkeypatch.setattr(sym, "_fetch_binance", fake)
    asyncio.run(sym.get_source("binance", settings()))
    asyncio.run(sym.get_source("binance", settings()))
    asyncio.run(sym.get_source("binance", settings(), refresh=True))   # < 60s old: served from cache
    assert len(calls) == 1


@pytest.fixture()
def client():
    from app.main import app
    return TestClient(app)


def test_symbols_endpoint_filters_and_paginates(client, monkeypatch):
    async def fake(provider, settings=None, refresh=False, transport=None):
        rows = [{"provider": "binance", "symbol": f"T{i:03d}USDT", "base": f"T{i:03d}", "quote": "USDT", "name": None,
                 "asset_class": "crypto", "exchange": "BINANCE"} for i in range(250)]
        return rows, {"status": "ok", "count": len(rows), "message": None, "host": None, "fetched_at": None}
    monkeypatch.setattr(sym, "get_source", fake)
    r = client.get("/api/market/symbols", params={"provider": "binance", "limit": 100, "offset": 200}).json()
    assert r["total"] == 250 and len(r["items"]) == 50 and r["sources"]["binance"]["status"] == "ok"
    assert client.get("/api/market/symbols", params={"provider": "binance", "q": "T007"}).json()["total"] == 1
    assert client.get("/api/market/symbols", params={"limit": 501}).status_code == 422
    assert client.get("/api/market/symbols", params={"provider": "kraken"}).status_code == 422


KLINES = [[1700000000000 + i * 3600000, "1", "2", "0.5", "1.5", "10", 1700003599999 + i * 3600000, "0", 1, "0", "0", "0"]
          for i in range(3)]


def test_public_history_returns_candles_and_names_the_host_that_served_them(client, monkeypatch):
    async def fake(path, params=None, transport=None, timeout=15.0):
        assert path == "/api/v3/klines" and params["symbol"] == "BTCUSDT"
        return KLINES, "https://api1.binance.com"
    monkeypatch.setattr(bh, "get_json", fake)
    r = client.get("/api/market/public-history", params={"symbol": "btcusdt", "interval": "1h", "limit": 3})
    assert r.status_code == 200 and r.headers["x-binance-host"] == "api1.binance.com"
    j = r.json()
    assert len(j) == 3 and j[0]["close"] == 1.5 and j[0]["symbol"] == "BTCUSDT" and "data_status" in j[0]


def test_public_history_error_mapping(client, monkeypatch):
    assert client.get("/api/market/public-history", params={"symbol": "BTC USDT;"}).status_code == 422

    async def bad(*a, **k):
        raise bh.BinanceBadRequest(400)
    monkeypatch.setattr(bh, "get_json", bad)
    assert client.get("/api/market/public-history", params={"symbol": "NOPEUSDT"}).status_code == 404

    async def blocked(*a, **k):
        raise bh.BinanceUnavailable([("https://api.binance.com", "HTTP 451")])
    monkeypatch.setattr(bh, "get_json", blocked)
    r = client.get("/api/market/public-history", params={"symbol": "BTCUSDT"})
    assert r.status_code == 502 and "location" in r.json()["detail"]

    async def junk(*a, **k):
        return {"not": "a list"}, "https://api.binance.com"
    monkeypatch.setattr(bh, "get_json", junk)
    assert client.get("/api/market/public-history", params={"symbol": "BTCUSDT"}).status_code == 502


def test_binance_hosts_status_endpoint_excludes_binance_us(client):
    j = client.get("/api/market/binance-hosts").json()
    assert j["hosts"] and all("binance.us" not in h for h in j["hosts"]) and "binance.us" in j["excluded"]


def test_chart_page_uses_symbol_search_and_public_history_without_synthetic_data(client):
    js = client.get("/static/market3d.js").text
    assert "/api/market/symbols" in js and "/api/market/public-history" in js and "Math.random" not in js
    html = client.get("/static/market3d.html").text
    assert 'id="symlist"' in html and 'id="prov"' in html

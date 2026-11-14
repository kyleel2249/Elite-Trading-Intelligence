"""Bitget list, new-listing flags, and the multi-market /api/market/symbols + /api/market/public-history routes."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import market_symbols as ms
from app.config import Settings, get_settings
from app.market import history_extra as hx
from app.market import symbols as sym
from app.market import symbols_extra as ex


def run(coro):
    return asyncio.run(coro)


def S(**kw):
    return Settings(_env_file=None, **kw)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv("TWELVEDATA_API_KEY", raising=False)
    sym._reset_for_tests()
    ex._reset_for_tests()
    yield
    sym._reset_for_tests()
    ex._reset_for_tests()


# ------------------------------------------------------------------------------------------------ Bitget list

def test_bitget_lists_only_online_pairs():
    body = {"code": "00000", "data": [
        {"symbol": "BTCUSDT", "baseCoin": "BTC", "quoteCoin": "USDT", "status": "online"},
        {"symbol": "OLDUSDT", "baseCoin": "OLD", "quoteCoin": "USDT", "status": "offline"}]}
    items = run(sym._fetch_bitget(httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    assert [i["symbol"] for i in items] == ["BTCUSDT"] and items[0]["exchange"] == "BITGET" and items[0]["quote"] == "USDT"


@pytest.mark.parametrize("body", [{"code": "40001", "data": []}, {"code": "00000", "data": []}, ["nope"]])
def test_bitget_bad_payloads_are_failures_not_empty_lists(body):
    with pytest.raises(ValueError):
        run(sym._fetch_bitget(httpx.MockTransport(lambda r: httpx.Response(200, json=body))))


# ------------------------------------------------------------------------------------------------ new listings

def test_first_load_is_the_baseline_and_later_additions_are_flagged_new(monkeypatch):
    def row(s):
        return {"provider": "binance", "symbol": s, "base": s[:-4], "quote": "USDT", "name": None, "asset_class": "crypto", "exchange": "BINANCE"}
    lists = [[row("BTCUSDT")], [row("BTCUSDT"), row("NEWUSDT")]]
    n = {"i": 0}

    async def fake(transport=None):
        out = lists[n["i"]]
        n["i"] += 1
        return out
    monkeypatch.setattr(sym, "_fetch_binance", fake)
    first, _ = run(sym.get_source("binance", S()))
    assert not any(i["is_new"] for i in first)               # baseline: nothing is new
    sym._cache["binance"]["at"] = 0.0                        # expire the cache
    second, meta = run(sym.get_source("binance", S()))
    flags = {i["symbol"]: i["is_new"] for i in second}
    assert flags == {"BTCUSDT": False, "NEWUSDT": True} and meta["status"] == "ok"
    assert [i["symbol"] for i in sym.search(second, new_only=True)] == ["NEWUSDT"]
    assert next(i for i in second if i["symbol"] == "NEWUSDT")["first_seen_at"] is not None


# ------------------------------------------------------------------------------------------------ API

@pytest.fixture()
def client():
    from app.main import app
    app.dependency_overrides[get_settings] = lambda: S()
    yield TestClient(app)
    app.dependency_overrides.pop(get_settings, None)


def _meta(n, status="ok", message=None):
    return {"status": status, "count": n, "message": message, "host": None, "fetched_at": None}


def test_symbols_all_merges_every_source_filters_by_exchange_and_new(client, monkeypatch):
    rows = {
        "binance": [{"provider": "binance", "symbol": "BTCUSDT", "quote": "USDT", "exchange": "BINANCE", "is_new": False}],
        "bitget": [{"provider": "bitget", "symbol": "FRESHUSDT", "quote": "USDT", "exchange": "BITGET", "is_new": True,
                    "first_seen_at": "2026-11-14T00:00:00+00:00"}],
        "alpaca": [],
        "oanda": [{"provider": "oanda", "symbol": "EUR_USD", "quote": "USD", "exchange": "OANDA", "is_new": None}],
        "twelvedata": [{"provider": "twelvedata", "symbol": "SAP:XETR", "quote": "EUR", "name": "SAP SE", "exchange": "XETR"}],
    }

    async def core(provider, settings=None, refresh=False, transport=None):
        return rows[provider], _meta(len(rows[provider]), "not_configured" if provider == "alpaca" else "ok")

    async def extra(provider, settings=None, refresh=False, transport=None):
        return rows[provider], _meta(len(rows[provider]), message="partial list; could not load: XLON (HTTP 429)" if provider == "twelvedata" else None)
    monkeypatch.setattr(sym, "get_source", core)
    monkeypatch.setattr(ex, "get_source", extra)
    j = client.get("/api/market/symbols", params={"limit": 50}).json()
    assert j["total"] == 4 and set(j["sources"]) == {"binance", "bitget", "alpaca", "oanda", "twelvedata"}
    assert j["sources"]["alpaca"]["status"] == "not_configured" and "XLON" in j["sources"]["twelvedata"]["message"]
    assert [i["symbol"] for i in client.get("/api/market/symbols", params={"exchange": "xetr"}).json()["items"]] == ["SAP:XETR"]
    assert [i["symbol"] for i in client.get("/api/market/symbols", params={"new_only": "true"}).json()["items"]] == ["FRESHUSDT"]
    assert [i["symbol"] for i in client.get("/api/market/symbols", params={"provider": "twelvedata", "q": "sap"}).json()["items"]] == ["SAP:XETR"]
    assert client.get("/api/market/symbols", params={"provider": "kraken"}).status_code == 422


def test_credential_gated_markets_answer_503_with_a_reason_when_unconfigured(client):
    for provider in ("oanda", "alpaca"):
        r = client.get("/api/market/public-history", params={"provider": provider, "symbol": "EUR_USD"})
        assert r.status_code == 503 and "not configured" in r.json()["detail"]
    r = client.get("/api/market/public-history", params={"provider": "twelvedata", "symbol": "SAP:XETR"})
    assert r.status_code == 503 and "TWELVEDATA_API_KEY" in r.json()["detail"]


ROWS = [{"open_time": 1700000000000 + i * 3_600_000, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0,
         "close_time": 1700003599999 + i * 3_600_000} for i in range(3)]


def test_bitget_and_twelvedata_history_are_normalised_and_labelled(client, monkeypatch):
    async def bit(symbol, interval, limit, transport=None):
        assert symbol == "BTCUSDT" and interval == "1h"
        return ROWS

    async def td(symbol, interval, limit, key, transport=None):
        assert symbol == "SAP:XETR" and key == "k"
        return ROWS
    monkeypatch.setattr(hx, "fetch_bitget", bit)
    monkeypatch.setattr(hx, "fetch_twelvedata", td)
    monkeypatch.setattr(ex, "twelvedata_key", lambda: "k")
    r = client.get("/api/market/public-history", params={"provider": "bitget", "symbol": "btcusdt"})
    assert r.status_code == 200 and r.headers["x-data-source"] == "bitget" and len(r.json()) == 3 and "data_status" in r.json()[0]
    r = client.get("/api/market/public-history", params={"provider": "twelvedata", "symbol": "sap:xetr"})
    assert r.status_code == 200 and r.headers["x-data-source"] == "twelvedata"


def test_history_errors_keep_their_status_and_reason(client, monkeypatch):
    async def nope(*a, **k):
        raise hx.HistoryError(404, "unknown symbol or interval on Bitget")
    monkeypatch.setattr(hx, "fetch_bitget", nope)
    r = client.get("/api/market/public-history", params={"provider": "bitget", "symbol": "NOPEUSDT"})
    assert r.status_code == 404 and "Bitget" in r.json()["detail"]

    async def boom(*a, **k):
        raise RuntimeError("secret upstream detail")
    monkeypatch.setattr(hx, "fetch_bitget", boom)
    r = client.get("/api/market/public-history", params={"provider": "bitget", "symbol": "BTCUSDT"})
    assert r.status_code == 502 and "secret" not in r.text


def test_crypto_markets_reject_symbols_with_punctuation(client):
    for provider in ("binance", "bitget"):
        assert client.get("/api/market/public-history", params={"provider": provider, "symbol": "BTC:USDT"}).status_code == 422


def test_oanda_history_passes_through_the_market_service(client, monkeypatch):
    class Cfg:
        configured = True

    class Svc:
        def __init__(self, settings):
            pass

        async def get_history(self, provider, symbol, interval="1h", limit=100):
            assert (provider, symbol) == ("oanda", "EUR_USD")
            return [{**r, "data_status": "ok"} for r in ROWS]
    monkeypatch.setattr(ms, "OandaClient", lambda settings: Cfg())
    monkeypatch.setattr(ms, "MarketService", Svc)
    r = client.get("/api/market/public-history", params={"provider": "oanda", "symbol": "eur_usd"})
    assert r.status_code == 200 and r.headers["x-data-source"] == "oanda" and len(r.json()) == 3

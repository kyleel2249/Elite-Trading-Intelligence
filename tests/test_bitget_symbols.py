"""Bitget pair catalogue (Python origin): spot + USDT/USDC/coin-margined futures, partial-failure safety, minute sync."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app.config import Settings
from app.market import symbols as sym


def inst(symbol, base, quote, **extra):
    return {"symbol": symbol, "baseCoin": base, "quoteCoin": quote, **extra}


def world():
    return {
        "/api/v2/spot/public/symbols": [inst("BTCUSDT", "BTC", "USDT", status="online"), inst("ETHUSDT", "ETH", "USDT", status="online"),
                                        inst("OLDUSDT", "OLD", "USDT", status="offline")],
        "USDT-FUTURES": [inst("BTCUSDT", "BTC", "USDT", symbolStatus="normal", symbolType="perpetual"),
                         inst("ETHUSDT", "ETH", "USDT", symbolStatus="normal", symbolType="perpetual")],
        "USDC-FUTURES": [inst("BTCPERP", "BTC", "USDC", symbolStatus="normal", symbolType="perpetual")],
        "COIN-FUTURES": [inst("BTCUSD", "BTC", "USD", symbolStatus="normal", symbolType="perpetual"),
                         inst("ETHUSD_261225", "ETH", "USD", symbolStatus="normal", symbolType="delivery"),
                         inst("DEADUSD", "DEAD", "USD", symbolStatus="off", symbolType="perpetual")],
    }


def transport(data, down=()):
    def handler(req: httpx.Request) -> httpx.Response:
        key = req.url.params.get("productType") or req.url.path
        if key in down or (req.url.path.endswith("symbols") and "/api/v2/spot/public/symbols" in down):
            return httpx.Response(500, json={"code": "50000"})
        return httpx.Response(200, json={"code": "00000", "data": data[key]})
    return httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def fresh():
    sym._reset_for_tests()
    yield
    sym._reset_for_tests()


def run(coro):
    return asyncio.run(coro)


def test_bitget_covers_spot_and_all_three_futures_products_and_only_tradable_pairs():
    items, failed = run(sym._fetch_bitget_detailed(transport(world())))
    assert failed == []
    by = {(i["market"], i.get("product_type"), i["symbol"]) for i in items}
    assert ("spot", None, "BTCUSDT") in by and ("futures", "USDT-FUTURES", "BTCUSDT") in by
    assert ("futures", "USDC-FUTURES", "BTCPERP") in by and ("futures", "COIN-FUTURES", "ETHUSD_261225") in by
    assert not any(i["symbol"] in ("OLDUSDT", "DEADUSD") for i in items), "offline / off contracts are not tradable"
    assert {i["contract_type"] for i in items if i["market"] == "futures"} == {"perpetual", "delivery"}
    assert len(items) == 2 + 2 + 1 + 2


def test_a_failed_category_is_carried_forward_not_dropped():
    w = world()
    first, _ = run(sym._fetch_bitget_detailed(transport(w)))
    items, failed = run(sym._fetch_bitget_detailed(transport(w, down={"COIN-FUTURES"}), previous=first))
    assert failed == ["COIN-FUTURES"]
    assert {i["symbol"] for i in items if i.get("product_type") == "COIN-FUTURES"} == {"BTCUSD", "ETHUSD_261225"}
    assert len(items) == len(first)


def test_total_failure_raises_so_the_previous_list_is_kept_stale():
    with pytest.raises(Exception):
        run(sym._fetch_bitget_detailed(transport(world(), down={"/api/v2/spot/public/symbols", "USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"})))


def test_get_source_reports_partial_refresh_as_stale_and_retries_it():
    w = world()
    s = Settings()
    items, meta = run(sym.get_source("bitget", s, transport=transport(w)))
    assert meta["status"] == "ok" and meta["count"] == 7 and meta["partial_categories"] == []
    sym._cache["bitget"]["at"] -= 61
    items, meta = run(sym.get_source("bitget", s, transport=transport(w, down={"USDC-FUTURES"})))
    assert meta["status"] == "stale" and meta["partial_categories"] == ["USDC-FUTURES"] and meta["count"] == 7
    assert any(i["symbol"] == "BTCPERP" for i in items)
    sym._cache["bitget"]["at"] -= sym.PARTIAL_RETRY_SECONDS + 1            # a partial entry is retried before the 60 s TTL
    _, meta = run(sym.get_source("bitget", s, transport=transport(w)))
    assert meta["status"] == "ok" and meta["partial_categories"] == []


def test_spot_and_futures_with_the_same_symbol_name_are_tracked_separately_for_new_and_delisted():
    w = world()
    s = Settings()
    run(sym.get_source("bitget", s, transport=transport(w)))                  # baseline
    w["USDT-FUTURES"].append(inst("SOLUSDT", "SOL", "USDT", symbolStatus="normal", symbolType="perpetual"))
    w["/api/v2/spot/public/symbols"].append(inst("SOLUSDT", "SOL", "USDT", status="online"))
    w["USDC-FUTURES"].clear()                                                  # BTCPERP delisted
    sym._cache["bitget"]["at"] -= 61
    items, meta = run(sym.get_source("bitget", s, transport=transport(w)))
    new = {(i["market"], i["symbol"]) for i in items if i["is_new"]}
    assert new == {("spot", "SOLUSDT"), ("futures", "SOLUSDT")}, "a new futures listing must not hide behind an existing spot name"
    assert [(r["symbol"], r["market"]) for r in sym._removed] == [("BTCPERP", "USDC-FUTURES")]


def test_one_minute_sync_refreshes_bitget_with_bybit_and_records_the_result(monkeypatch):
    calls = []

    async def fake_get_source(provider, settings=None, refresh=False, transport=None):
        calls.append((provider, refresh))
        return [], {"status": "ok", "count": 7}
    monkeypatch.setattr(sym, "get_source", fake_get_source)
    out = run(sym.sync_once(Settings()))
    assert ("bitget", True) in calls and "bitget" in out
    st = sym.sync_status()
    assert st["runs"] == 1 and st["last_run_at"] and "bitget" in st["last_result"]


def test_sync_loop_runs_from_startup_and_stops_cleanly(monkeypatch):
    async def scenario():
        ran = asyncio.Event()

        async def fake_sync_once(settings=None):
            ran.set()
            return {}
        monkeypatch.setattr(sym, "sync_once", fake_sync_once)
        sym.ensure_sync_started(Settings())
        await asyncio.wait_for(ran.wait(), 2)
        assert sym.sync_status()["running"] is True
        await sym.stop_sync()
        assert sym.sync_status()["running"] is False
    run(scenario())


def test_symbols_api_filters_bitget_by_market_and_product_type(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    w = world()
    real = sym._fetch_bitget_detailed

    async def fetch(transport=None, previous=None):
        return await real(transport=globals()["transport"](w), previous=previous)
    monkeypatch.setattr(sym, "_fetch_bitget_detailed", fetch)
    with TestClient(app) as c:
        body = c.get("/api/market/symbols", params={"provider": "bitget", "market": "futures", "product_type": "COIN-FUTURES", "limit": 100}).json()
    assert {i["symbol"] for i in body["items"]} == {"BTCUSD", "ETHUSD_261225"}
    assert body["sources"]["bitget"]["status"] == "ok"

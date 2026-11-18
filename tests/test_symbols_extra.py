"""OANDA / Twelve Data symbol lists and the Bitget / Twelve Data candle fetchers (all network-free)."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app.config import Settings
from app.market import history_extra as hx
from app.market import symbols_extra as ex

KEY = "secretkey123"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv("TWELVEDATA_API_KEY", raising=False)
    monkeypatch.delenv("TWELVEDATA_EXCHANGES", raising=False)
    ex._reset_for_tests()
    yield
    ex._reset_for_tests()


def oanda_settings(**kw):
    return Settings(_env_file=None, oanda_api_token="tok", oanda_account_id="101-001-1-001", **kw)


OANDA = {"instruments": [
    {"name": "XAU_USD", "type": "METAL", "displayName": "Gold"},
    {"name": "EUR_USD", "type": "CURRENCY", "displayName": "EUR/USD"},
    {"name": "DE30_EUR", "type": "CFD", "displayName": "Germany 30"}]}


def test_oanda_is_not_configured_without_credentials():
    items, meta = run(ex.get_source("oanda", Settings(_env_file=None, oanda_api_token=None, oanda_account_id=None)))
    assert items == [] and meta["status"] == "not_configured"


def test_oanda_lists_forex_metals_and_cfds():
    def handler(req):
        assert req.url.path.endswith("/instruments") and req.headers["authorization"] == "Bearer tok"
        return httpx.Response(200, json=OANDA)
    items, meta = run(ex.get_source("oanda", oanda_settings(), transport=httpx.MockTransport(handler)))
    assert meta["status"] == "ok" and [i["symbol"] for i in items] == ["DE30_EUR", "EUR_USD", "XAU_USD"]
    by = {i["symbol"]: i for i in items}
    assert by["EUR_USD"]["asset_class"] == "forex" and by["EUR_USD"]["base"] == "EUR" and by["EUR_USD"]["quote"] == "USD"
    assert by["XAU_USD"]["asset_class"] == "metal" and by["DE30_EUR"]["asset_class"] == "cfd"


def test_oanda_failure_is_unavailable_then_stale_when_a_list_was_cached():
    bad = httpx.MockTransport(lambda r: httpx.Response(401, json={"errorMessage": "Insufficient authorization"}))
    items, meta = run(ex.get_source("oanda", oanda_settings(), transport=bad))
    assert items == [] and meta["status"] == "unavailable"
    ex._cache["oanda"] = {"items": [{"provider": "oanda", "symbol": "EUR_USD"}], "at": 0.0, "message": None}
    items, meta = run(ex.get_source("oanda", oanda_settings(), transport=bad))
    assert len(items) == 1 and meta["status"] == "stale"


def test_twelvedata_is_not_configured_without_a_key():
    items, meta = run(ex.get_source("twelvedata", Settings(_env_file=None)))
    assert items == [] and meta["status"] == "not_configured" and "TWELVEDATA_API_KEY" in meta["message"]


def test_exchange_list_is_validated_and_deduplicated(monkeypatch):
    monkeypatch.setenv("TWELVEDATA_EXCHANGES", "xetr, bad!, XETR, XLON")
    assert ex.twelvedata_exchanges() == ["XETR", "XLON"]
    monkeypatch.setenv("TWELVEDATA_EXCHANGES", "!!")
    assert ex.twelvedata_exchanges() == list(ex.DEFAULT_EXCHANGES)


def td_handler(req):
    p = req.url.params
    assert p["apikey"] == KEY
    if req.url.path == "/stocks":
        if p["exchange"] == "XETR":
            return httpx.Response(200, json={"status": "ok", "data": [
                {"symbol": "sap", "name": "SAP SE", "currency": "EUR", "country": "Germany"}, {"symbol": ""}]})
        return httpx.Response(200, json={"code": 429, "status": "error", "message": f"out of credits for {KEY}"})
    if req.url.path == "/forex_pairs":
        return httpx.Response(200, json={"status": "ok", "data": [
            {"symbol": "EUR/USD", "currency_base": "Euro", "currency_quote": "US Dollar"}]})
    return httpx.Response(404)


def test_twelvedata_lists_non_us_stocks_and_forex_and_names_the_exchanges_that_failed(monkeypatch):
    monkeypatch.setenv("TWELVEDATA_API_KEY", KEY)
    monkeypatch.setenv("TWELVEDATA_EXCHANGES", "XETR,XLON")
    items, meta = run(ex.get_source("twelvedata", Settings(_env_file=None), transport=httpx.MockTransport(td_handler)))
    assert [i["symbol"] for i in items] == ["SAP:XETR", "EUR/USD"]
    assert items[0]["exchange"] == "XETR" and items[0]["quote"] == "EUR" and items[1]["asset_class"] == "forex"
    assert meta["status"] == "ok" and "XLON" in meta["message"] and KEY not in meta["message"]


def test_twelvedata_total_failure_is_unavailable_and_never_leaks_the_key(monkeypatch):
    monkeypatch.setenv("TWELVEDATA_API_KEY", KEY)
    monkeypatch.setenv("TWELVEDATA_EXCHANGES", "XETR")
    t = httpx.MockTransport(lambda r: httpx.Response(200, json={"code": 401, "status": "error", "message": f"bad key {KEY}"}))
    items, meta = run(ex.get_source("twelvedata", Settings(_env_file=None), transport=t))
    assert items == [] and meta["status"] == "unavailable" and KEY not in meta["message"]


# ------------------------------------------------------------------------------------------------ candles

def test_bitget_candles_are_sorted_oldest_first_with_close_times():
    data = [["1700003600000", "2", "3", "1", "2.5", "10", "0", "0"], ["1700000000000", "1", "2", "0.5", "1.5", "9", "0", "0"]]

    def handler(req):
        assert req.url.path == "/api/v2/spot/market/candles"
        assert req.url.params["symbol"] == "BTCUSDT" and req.url.params["granularity"] == "1h"
        return httpx.Response(200, json={"code": "00000", "data": data})
    rows = run(hx.fetch_bitget("btcusdt", "1h", 2, transport=httpx.MockTransport(handler)))
    assert [r["open_time"] for r in rows] == [1700000000000, 1700003600000]
    assert rows[0]["close_time"] == 1700000000000 + 3_600_000 - 1 and rows[1]["close"] == 2.5


@pytest.mark.parametrize("resp,status", [
    (httpx.Response(400, json={}), 404), (httpx.Response(500), 502),
    (httpx.Response(200, json={"code": "40001", "data": []}), 502), (httpx.Response(200, json={"code": "00000", "data": []}), 404),
    (httpx.Response(200, json={"code": "00000", "data": [["x"]]}), 502)])
def test_bitget_errors_map_to_honest_statuses(resp, status):
    with pytest.raises(hx.HistoryError) as e:
        run(hx.fetch_bitget("BTCUSDT", "1h", 5, transport=httpx.MockTransport(lambda r: resp)))
    assert e.value.status == status


def test_unsupported_interval_is_rejected_not_guessed():
    with pytest.raises(hx.HistoryError) as e:
        run(hx.fetch_bitget("BTCUSDT", "1M", 5))
    assert e.value.status == 422


def test_twelvedata_candles_request_the_right_symbol_exchange_and_timezone():
    seen = {}

    def handler(req):
        seen.update(dict(req.url.params))
        return httpx.Response(200, json={"status": "ok", "values": [
            {"datetime": "2026-01-02 15:00:00", "open": "2", "high": "3", "low": "1", "close": "2.5", "volume": "100"},
            {"datetime": "2026-01-02 14:00:00", "open": "1", "high": "2", "low": "0.5", "close": "1.5"}]})
    rows = run(hx.fetch_twelvedata("sap:xetr", "1h", 2, KEY, transport=httpx.MockTransport(handler)))
    assert seen["symbol"] == "SAP" and seen["exchange"] == "XETR" and seen["timezone"] == "UTC" and seen["interval"] == "1h"
    assert rows[0]["open_time"] < rows[1]["open_time"] and rows[0]["volume"] == 0.0 and rows[1]["volume"] == 100.0
    assert rows[1]["close_time"] - rows[1]["open_time"] == 3_599_999


def test_twelvedata_forex_pair_has_no_exchange_and_daily_dates_parse():
    seen = {}

    def handler(req):
        seen.update(dict(req.url.params))
        return httpx.Response(200, json={"status": "ok", "values": [
            {"datetime": "2026-01-02", "open": "1", "high": "2", "low": "0.5", "close": "1.5"}]})
    rows = run(hx.fetch_twelvedata("EUR/USD", "1d", 1, KEY, transport=httpx.MockTransport(handler)))
    assert seen["symbol"] == "EUR/USD" and "exchange" not in seen and rows[0]["close_time"] - rows[0]["open_time"] == 86_399_999


@pytest.mark.parametrize("body,status", [
    ({"code": 400, "status": "error", "message": "symbol invalid"}, 404),
    ({"code": 401, "status": "error", "message": f"bad apikey {KEY}"}, 502),
    ({"status": "ok", "values": []}, 404),
    ({"status": "ok", "values": [{"datetime": "nonsense"}]}, 502)])
def test_twelvedata_errors_map_to_honest_statuses_without_leaking_the_key(body, status):
    with pytest.raises(hx.HistoryError) as e:
        run(hx.fetch_twelvedata("AAPL", "1h", 5, KEY, transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    assert e.value.status == status and KEY not in e.value.message


def test_twelvedata_needs_a_key():
    with pytest.raises(hx.HistoryError) as e:
        run(hx.fetch_twelvedata("AAPL", "1h", 5, ""))
    assert e.value.status == 503

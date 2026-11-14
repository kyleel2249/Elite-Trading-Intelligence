"""USDT-amount sizing on /api/execution/signals: fresh-price rule, USDT-only, exactly-one-of validation."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import execution as ex
from app.config import Settings
from app.execution import quote_sizing as qs

S = Settings(_env_file=None, execution_enabled=True)


class Market:
    def __init__(self, price=100.0, status="fresh", boom=False):
        self.price, self.status, self.boom = price, status, boom

    async def get_snapshot(self, provider, symbol):
        if self.boom:
            raise RuntimeError("upstream")
        return {"price": self.price, "data_status": self.status}


def run(coro):
    return asyncio.run(coro)


def test_market_amount_uses_a_fresh_live_quote_and_rounds_down():
    qty, sz = run(qs.size_from_usdt(1000, "btcusdt", None, "binance", S, market=Market(30000.0)))
    assert qty == 0.03333333 and sz["price_source"] == "live_quote" and sz["quote_currency"] == "USDT"
    assert sz["estimated_notional_usdt"] <= 1000


def test_limit_price_is_the_reference_and_no_quote_is_fetched():
    qty, sz = run(qs.size_from_usdt(500, "ETHUSDT", 2000.0, "binance", S, market=Market(boom=True)))
    assert qty == 0.25 and sz["price_source"] == "limit_price"


@pytest.mark.parametrize("status", ["stale", "delayed", "invalid", "market_closed", None])
def test_non_fresh_quotes_are_refused_not_guessed(status):
    with pytest.raises(qs.QuoteSizingError) as e:
        run(qs.size_from_usdt(100, "BTCUSDT", None, "binance", S, market=Market(100.0, status)))
    assert e.value.status == 503 and "fresh" in e.value.message


def test_missing_price_and_upstream_failure():
    with pytest.raises(qs.QuoteSizingError) as e:
        run(qs.size_from_usdt(100, "BTCUSDT", None, "binance", S, market=Market(None, "fresh")))
    assert e.value.status == 503
    with pytest.raises(qs.QuoteSizingError) as e:
        run(qs.size_from_usdt(100, "BTCUSDT", None, "binance", S, market=Market(boom=True)))
    assert e.value.status == 502


def test_only_usdt_quoted_symbols_and_tiny_amounts_are_rejected():
    with pytest.raises(qs.QuoteSizingError) as e:
        run(qs.size_from_usdt(100, "AAPL", None, "alpaca", S, market=Market()))
    assert e.value.status == 422 and "USDT" in e.value.message
    with pytest.raises(qs.QuoteSizingError) as e:
        run(qs.size_from_usdt(0.0000001, "BTCUSDT", None, "binance", S, market=Market(60000.0)))
    assert e.value.status == 422


def test_signal_body_needs_exactly_one_of_qty_or_quote_amount():
    base = {"account_id": "a1", "symbol": "BTCUSDT", "side": "buy"}
    assert ex.SignalBody(**base, qty=1).quote_amount is None
    assert ex.SignalBody(**base, quote_amount=50).qty is None
    for extra in ({}, {"qty": 1, "quote_amount": 50}):
        with pytest.raises(ValidationError):
            ex.SignalBody(**base, **extra)


@pytest.fixture()
def client(monkeypatch):
    from app.config import get_settings
    from app.main import app
    seen = {}

    class Engine:
        async def submit_signal(self, intent):
            seen["intent"] = intent
            return SimpleNamespace(to_dict=lambda: {"status": "proposed", "qty": intent.qty})

    monkeypatch.setattr(ex, "get_engine", lambda: Engine())
    monkeypatch.setattr(ex, "_account", lambda account_id: SimpleNamespace(provider="binance"))
    monkeypatch.setattr(qs, "MarketService", lambda settings: Market(25000.0))
    app.dependency_overrides[get_settings] = lambda: S
    c = TestClient(app)
    c.seen = seen
    yield c
    app.dependency_overrides.pop(get_settings, None)


def test_signals_endpoint_converts_usdt_and_returns_the_sizing_evidence(client):
    r = client.post("/api/execution/signals", json={"account_id": "a1", "symbol": "BTCUSDT", "side": "buy", "quote_amount": 1000})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["qty"] == 0.04 and j["sizing"]["quote_amount"] == 1000 and j["sizing"]["price_source"] == "live_quote"
    assert client.seen["intent"].qty == 0.04


def test_signals_endpoint_still_accepts_qty_and_rejects_both_or_neither(client):
    ok = client.post("/api/execution/signals", json={"account_id": "a1", "symbol": "BTCUSDT", "side": "buy", "qty": 0.5})
    assert ok.status_code == 200 and "sizing" not in ok.json()
    for body in ({}, {"qty": 1, "quote_amount": 10}):
        r = client.post("/api/execution/signals", json={"account_id": "a1", "symbol": "BTCUSDT", "side": "buy", **body})
        assert r.status_code == 422
    r = client.post("/api/execution/signals", json={"account_id": "a1", "symbol": "AAPL", "side": "buy", "quote_amount": 10})
    assert r.status_code == 422

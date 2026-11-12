"""API boundary tests use mocked services: never start jobs or contact providers."""
import math
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.main as main
import app.security.auth as auth
from app.config import Settings
from app.database import get_db


@pytest.fixture
def api(monkeypatch):
    settings = Settings(_env_file=None, app_env="production", api_key="test-only-key")
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    previous = main.app.dependency_overrides.copy()
    main.app.dependency_overrides[main.get_settings] = lambda: settings
    main.app.dependency_overrides[get_db] = lambda: MagicMock()
    client = TestClient(main.app)
    try:
        yield client
    finally:
        client.close()
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(previous)


HEADERS = {"X-API-Key": "test-only-key"}


@pytest.mark.parametrize("path", ["positions", "portfolio", "journal", "history"])
def test_private_reads_require_key(api, path):
    for headers in ({}, {"X-API-Key": "wrong"}):
        assert api.get("/api/paper-trading/" + path, headers=headers).status_code == 401


def test_private_reads_allow_valid_key(api, monkeypatch):
    portfolio = MagicMock()
    portfolio.list_positions.return_value = []
    portfolio.list_journal.return_value = []
    portfolio.portfolio_summary.return_value = {"environment": "live"}
    monkeypatch.setattr(main, "PortfolioService", lambda db: portfolio)
    assert api.get("/api/paper-trading/positions?environment=live", headers=HEADERS).json() == []
    assert api.get("/api/paper-trading/journal", headers=HEADERS).json() == []
    assert api.get("/api/paper-trading/portfolio?environment=live", headers=HEADERS).status_code == 200


def test_score_auth_and_positive_price(api, monkeypatch):
    score = MagicMock()
    score.score_pending.return_value = []
    score.summary.return_value = {}
    monkeypatch.setattr(main, "ForecastAccuracyService", lambda db: score)
    assert api.post("/api/intelligence/forecast/score", json={"realized_price": 1}).status_code == 401
    score.score_pending.assert_not_called()
    for price in (0, -5):
        assert api.post("/api/intelligence/forecast/score", json={"realized_price": price}, headers=HEADERS).status_code == 422
    for price in (math.nan, math.inf, -math.inf):
        with pytest.raises(ValidationError):
            main.ForecastScoreRequest(realized_price=price)
    assert api.post("/api/intelligence/forecast/score", json={"realized_price": 100}, headers=HEADERS).status_code == 200
    score.score_pending.assert_called_once_with("BTCUSDT", 100.0, provider="binance")


@pytest.mark.parametrize("price", [0, -1, float("inf"), float("nan"), "invalid"])
def test_score_rejects_invalid_upstream_price(api, monkeypatch, price):
    market = MagicMock(get_snapshot=AsyncMock(return_value={"price": price}))
    monkeypatch.setattr(main, "MarketService", lambda settings: market)
    assert api.post("/api/intelligence/forecast/score", json={}, headers=HEADERS).status_code == 422


@pytest.mark.parametrize("path,cap", [("/api/intelligence/decisions", 100), ("/api/paper-trading/history", 200),
    ("/api/paper-trading/journal", 200), ("/api/data-intelligence/activities", 200),
    ("/api/data-intelligence/alerts", 200), ("/api/data-intelligence/consensus", 200)])
@pytest.mark.parametrize("value", [-1, 0, 999999])
def test_query_bounds(api, path, cap, value):
    assert api.get(path, params={"limit": value}, headers=HEADERS).status_code == 422


@pytest.mark.parametrize("path", ["/api/market/snapshot", "/api/intelligence/council", "/api/intelligence/forecast"])
def test_persistence_is_opt_in_and_authenticated(api, monkeypatch, path):
    market = MagicMock()
    market.get_snapshot = AsyncMock(return_value={"price": 100, "data_status": "fresh"})
    market.get_order_book = AsyncMock(return_value={})
    market.get_history = AsyncMock(return_value=[])
    monkeypatch.setattr(main, "MarketService", lambda settings: market)
    monkeypatch.setattr(main, "fetch_fred_series", AsyncMock(return_value={}))
    monkeypatch.setattr(main, "fetch_news_headlines", AsyncMock(return_value={}))
    decision = SimpleNamespace(action=SimpleNamespace(value="WAIT"), confidence=0, summary="test", risk_veto=False,
        risk_notes=[], risk_officer="test", contradictory_signals=[], data_quality="fresh", methodology_notes=[],
        timestamp="test", specialist_reports=[])
    monkeypatch.setattr(main, "TradingCouncil", lambda: SimpleNamespace(analyse=lambda **kw: decision))
    monkeypatch.setattr(main, "PredictiveEngine", lambda: SimpleNamespace(forecast=lambda **kw: SimpleNamespace(to_dict=lambda: {"symbol": "BTCUSDT"})))
    writers = [MagicMock(), MagicMock(), MagicMock()]
    for name, writer in zip(("save_snapshot", "save_council_decision", "save_forecast"), writers):
        monkeypatch.setattr(main, name, writer)
    assert api.get(path, params={"persist": "true"}).status_code == 401
    market.get_snapshot.assert_not_called()
    assert api.get(path).status_code == 200
    for writer in writers:
        writer.assert_not_called()
    assert api.get(path, params={"persist": "true"}, headers=HEADERS).status_code == 200
    assert any(writer.called for writer in writers)


def test_environment_and_job_interval_validation(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    assert Settings(_env_file=None).app_env == "production"
    assert Settings(_env_file=None, app_env=" Production ").app_env == "production"
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="produciton")
    for field in ("mtm_interval_seconds", "reconcile_interval_seconds", "investor_monitor_interval_seconds"):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, **{field: 0})


def test_api_key_is_normalized():
    assert Settings(_env_file=None, api_key="  ").api_key is None
    assert Settings(_env_file=None, api_key=" key ").api_key == "key"


def test_private_routes_fail_closed_without_configured_key(api, monkeypatch):
    monkeypatch.setattr(auth, "get_settings", lambda: Settings(_env_file=None, app_env="production", api_key=None))
    assert api.get("/api/paper-trading/portfolio").status_code == 503
    assert api.post("/api/intelligence/forecast/score", json={"realized_price": 100}).status_code == 503


@pytest.mark.parametrize("environment", ["paper", "live"])
def test_order_uses_server_reference_price(api, monkeypatch, environment):
    market = MagicMock(get_snapshot=AsyncMock(return_value={"price": 100.0}))
    monkeypatch.setattr(main, "MarketService", lambda settings: market)
    ctx = SimpleNamespace(equity=10000, current_open_positions=0, daily_realized_pnl_pct=0,
        current_drawdown_pct=0, data_age_seconds=1, data_status="fresh", to_dict=lambda: {})
    monkeypatch.setattr(main, "build_risk_context", lambda *a, **kw: ctx)
    service = MagicMock(place_order=AsyncMock(return_value={"status": "rejected"}))
    monkeypatch.setattr(main, "TradingService", lambda *a, **kw: service)
    response = api.post("/api/trading/order", headers=HEADERS, json={
        "provider": "binance", "environment": environment, "symbol": "BTCUSDT", "side": "buy", "qty": .01})
    assert response.status_code == 200
    assert service.place_order.call_args.kwargs["reference_price"] == 100.0


def test_limit_price_cannot_manufacture_market_quote(api, monkeypatch):
    monkeypatch.setattr(main, "MarketService", lambda settings: MagicMock(get_snapshot=AsyncMock(return_value={})))
    ctx = SimpleNamespace(equity=10000, current_open_positions=0, daily_realized_pnl_pct=0,
        current_drawdown_pct=0, data_age_seconds=None, data_status="unknown", to_dict=lambda: {})
    monkeypatch.setattr(main, "build_risk_context", lambda *a, **kw: ctx)
    service = MagicMock(place_order=AsyncMock(return_value={"status": "rejected"}))
    monkeypatch.setattr(main, "TradingService", lambda *a, **kw: service)
    response = api.post("/api/trading/order", headers=HEADERS, json={
        "provider": "binance", "environment": "paper", "symbol": "BTCUSDT", "side": "buy",
        "qty": .01, "order_type": "limit", "limit_price": 100})
    assert response.status_code == 200
    assert service.place_order.call_args.kwargs["reference_price"] is None
    assert service.place_order.call_args.kwargs["fill_price_hint"] is None

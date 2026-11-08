import asyncio
from datetime import datetime, timezone

import pytest

from app.config import Settings
from app.api import risk_gateway


class _Market:
    def __init__(self, settings):
        pass

    async def get_snapshot(self, provider, symbol):
        return {
            "provider": provider,
            "symbol": symbol,
            "price": 100.0,
            "data_status": "fresh",
            "ts_utc": datetime.now(timezone.utc).isoformat(),
        }


class _Activities:
    def __init__(self, db):
        pass

    def list_activities(self, **kwargs):
        return [{
            "activity_id": "act-1",
            "ticker": "BTCUSDT",
            "significance": "HIGH",
            "verification_status": "VERIFIED",
            "category": "disclosure",
        }]


def test_preflight_connects_market_risk_and_disclosures_without_submitting(monkeypatch):
    monkeypatch.setattr(risk_gateway, "MarketService", _Market)
    monkeypatch.setattr(risk_gateway, "ActivityStore", _Activities)
    settings = Settings(paper_starting_equity=10000.0)
    req = risk_gateway.PreflightRequest(
        provider="binance", environment="paper", symbol="BTCUSDT",
        side="buy", quantity=0.01, order_type="market",
    )

    result = asyncio.run(risk_gateway.execution_preflight(
        req, settings=settings, db=None, _auth=None,
    ))

    assert result["approved"] is True
    assert result["risk_inputs"]["source"] == "server"
    assert result["market"]["price"] == 100.0
    assert result["disclosure_context"]["high_impact_verified_count"] == 1
    assert result["disclosure_context"]["interpretation"].startswith("Research context only")
    assert "market_research" in result
    assert "council_action" in result["market_research"]
    assert result["submits_order"] is False


def test_live_preflight_fails_closed_without_live_account_equity(monkeypatch):
    monkeypatch.setattr(risk_gateway, "MarketService", _Market)
    monkeypatch.setattr(risk_gateway, "ActivityStore", _Activities)
    settings = Settings(live_trading_enabled=False, live_account_equity=None)
    req = risk_gateway.PreflightRequest(
        provider="binance", environment="live", symbol="BTCUSDT",
        side="buy", quantity=0.01, order_type="limit", limit_price=100.0,
    )

    result = asyncio.run(risk_gateway.execution_preflight(
        req, settings=settings, db=None, _auth=None,
    ))

    assert result["approved"] is False
    assert any("LIVE_TRADING_ENABLED" in reason for reason in result["reasons"])
    assert result["submits_order"] is False


def test_live_preflight_rejects_market_orders():
    with pytest.raises(ValueError):
        risk_gateway.PreflightRequest(
            provider="binance", environment="live", symbol="BTCUSDT",
            side="buy", quantity=0.01, order_type="market",
        )

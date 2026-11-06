"""Trading service risk gating tests (no real network)."""
import pytest
from app.trading.service import TradingService
from app.config import Settings


@pytest.mark.asyncio
async def test_live_rejected_when_disabled():
    settings = Settings(
        live_trading_enabled=False,
        alpaca_paper=True,
        binance_live_trading_enabled=True,
        default_risk_per_trade_pct=1.0,
        max_daily_loss_pct=3.0,
        max_portfolio_drawdown_pct=10.0,
        max_open_positions=8,
        require_fresh_data_for_live_orders=True,
        data_max_age_seconds=300,
    )
    svc = TradingService(settings)
    result = await svc.place_order(
        provider="binance",
        environment="live",
        symbol="BTCUSDT",
        side="buy",
        qty=0.01,
        equity=10000.0,
        data_age_seconds=5,
        data_status="fresh",
    )
    assert result["status"] == "rejected"
    assert any("LIVE_TRADING_ENABLED" in r for r in result["risk"]["reasons"])

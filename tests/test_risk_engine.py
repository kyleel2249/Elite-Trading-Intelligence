"""Unit tests for RiskEngine — must stay green."""
from app.risk.engine import RiskEngine, OrderProposal, Decision
from app.config import Settings


def make_settings(**kwargs):
    base = dict(
        live_trading_enabled=True,
        default_risk_per_trade_pct=1.0,
        max_daily_loss_pct=3.0,
        max_portfolio_drawdown_pct=10.0,
        max_open_positions=8,
        alpaca_paper=True,
        binance_live_trading_enabled=True,
        require_fresh_data_for_live_orders=True,
        data_max_age_seconds=300,
    )
    base.update(kwargs)
    return Settings(**base)


def test_approve_paper_order():
    engine = RiskEngine(make_settings())
    proposal = OrderProposal(
        provider="binance",
        environment="paper",
        symbol="BTCUSDT",
        side="buy",
        qty=0.01,
        reference_price=100.0,
        equity=10000.0,
        data_age_seconds=5,
        data_status="fresh",
    )
    decision = engine.evaluate(proposal)
    assert decision.approved
    assert decision.decision == Decision.APPROVED


def test_reject_live_when_global_disabled():
    engine = RiskEngine(make_settings(live_trading_enabled=False))
    proposal = OrderProposal(
        provider="binance",
        environment="live",
        symbol="BTCUSDT",
        side="buy",
        qty=0.01,
        reference_price=100.0,
        equity=10000.0,
        data_age_seconds=5,
        data_status="fresh",
    )
    decision = engine.evaluate(proposal)
    assert not decision.approved
    assert any("LIVE_TRADING_ENABLED" in r for r in decision.reasons)


def test_reject_stale_data_for_live():
    engine = RiskEngine(make_settings())
    proposal = OrderProposal(
        provider="binance",
        environment="live",
        symbol="BTCUSDT",
        side="buy",
        qty=0.01,
        reference_price=100.0,
        equity=10000.0,
        data_age_seconds=900,
        data_status="stale",
    )
    decision = engine.evaluate(proposal)
    assert not decision.approved


def test_reject_max_positions():
    engine = RiskEngine(make_settings(max_open_positions=2))
    proposal = OrderProposal(
        provider="alpaca",
        environment="paper",
        symbol="AAPL",
        side="buy",
        qty=10,
        reference_price=100.0,
        equity=50000.0,
        current_open_positions=2,
        data_status="fresh",
        data_age_seconds=10,
    )
    decision = engine.evaluate(proposal)
    assert not decision.approved


def test_position_size():
    engine = RiskEngine(make_settings())
    qty = engine.position_size(equity=10000, entry_price=100, stop_price=98, risk_pct=1.0)
    # Risk $100, stop distance $2 → 50 shares
    assert abs(qty - 50.0) < 1e-6

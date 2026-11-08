"""Risk inputs are derived server-side from the DB and market snapshot."""
from datetime import datetime, timedelta, timezone

from app.config import Settings
from app.database import Base, engine, SessionLocal
from app.trading.portfolio import PortfolioService
from app.trading.risk_context import base_equity, build_risk_context, snapshot_age_seconds

NOW = datetime(2026, 11, 8, 12, 0, 0, tzinfo=timezone.utc)


def setup_module():
    Base.metadata.create_all(bind=engine)


def _snap(**overrides):
    snap = {"price": 100.0, "data_status": "fresh", "ts_utc": (NOW - timedelta(seconds=30)).isoformat()}
    snap.update(overrides)
    return snap


def test_snapshot_age_parses_aware_naive_and_z_suffix():
    assert snapshot_age_seconds(_snap(), now=NOW) == 30.0
    naive = (NOW - timedelta(seconds=45)).replace(tzinfo=None).isoformat()
    assert snapshot_age_seconds({"ts_utc": naive}, now=NOW) == 45.0
    z = (NOW - timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert snapshot_age_seconds({"ts_utc": z}, now=NOW) == 10.0


def test_snapshot_age_missing_or_garbage_is_none():
    assert snapshot_age_seconds(None, now=NOW) is None
    assert snapshot_age_seconds({}, now=NOW) is None
    assert snapshot_age_seconds({"ts_utc": "not-a-date"}, now=NOW) is None


def test_base_equity_paper_vs_live():
    s = Settings(paper_starting_equity=2500.0, live_account_equity=None)
    assert base_equity(s, "paper") == 2500.0
    assert base_equity(s, "testnet") == 2500.0
    assert base_equity(s, "live") == 0.0
    assert base_equity(Settings(live_account_equity=7000.0), "live") == 7000.0


def test_live_without_configured_equity_gets_zero_equity():
    ctx = build_risk_context(None, Settings(live_account_equity=None), environment="live", snapshot=_snap())
    assert ctx.equity == 0.0  # RiskEngine rejects non-positive equity


def test_unavailable_snapshot_marks_data_unavailable():
    ctx = build_risk_context(None, Settings(), environment="paper", snapshot=None)
    assert ctx.data_status == "unavailable"
    assert ctx.data_age_seconds is None
    ctx = build_risk_context(None, Settings(), environment="paper", snapshot=_snap(price=None))
    assert ctx.data_status == "unavailable"


def test_fresh_snapshot_passes_status_through():
    ctx = build_risk_context(None, Settings(paper_starting_equity=1000.0), environment="paper", snapshot=_snap())
    assert ctx.data_status == "fresh"
    assert ctx.equity == 1000.0
    assert ctx.current_open_positions == 0


def test_db_derived_positions_pnl_and_drawdown():
    env = "ctx-test"  # isolated from other tests sharing the temp database
    db = SessionLocal()
    try:
        svc = PortfolioService(db)
        svc.record_order_event(client_order_id="ctx-buy-1", provider="binance", environment=env, symbol="BTCUSDT",
                               side="buy", qty=1.0, status="filled", fill_price=100.0, risk_approved=True)
        svc.record_order_event(client_order_id="ctx-sell-1", provider="binance", environment=env, symbol="BTCUSDT",
                               side="sell", qty=1.0, status="filled", fill_price=90.0, risk_approved=True)  # -10 realized
        svc.record_order_event(client_order_id="ctx-buy-2", provider="binance", environment=env, symbol="ETHUSDT",
                               side="buy", qty=1.0, status="filled", fill_price=50.0, risk_approved=True)  # stays open

        ctx = build_risk_context(db, Settings(paper_starting_equity=1000.0), environment=env, snapshot=_snap())

        assert ctx.current_open_positions == 1
        assert abs(ctx.equity - 990.0) < 1e-9
        assert abs(ctx.current_drawdown_pct - 1.0) < 1e-9
        assert abs(ctx.daily_realized_pnl_pct - (-10.0 / 990.0 * 100.0)) < 1e-9
    finally:
        db.close()

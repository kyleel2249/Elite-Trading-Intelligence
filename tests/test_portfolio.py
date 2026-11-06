from app.database import Base, engine, SessionLocal
from app.trading.portfolio import PortfolioService


def setup_module():
    Base.metadata.create_all(bind=engine)


def test_paper_fill_opens_long():
    db = SessionLocal()
    try:
        svc = PortfolioService(db)
        order = svc.record_order_event(
            client_order_id="eti-test-long-1",
            provider="binance",
            environment="paper",
            symbol="BTCUSDT",
            side="buy",
            qty=0.01,
            status="filled",
            fill_price=50000.0,
            risk_approved=True,
            risk_notes="Approved by RiskEngine",
            thesis="Council BUY",
            council_action="BUY",
        )
        assert order.status == "filled"
        positions = svc.list_positions(environment="paper", status="open")
        assert any(p.symbol == "BTCUSDT" and p.side == "long" for p in positions)
        journal = svc.list_journal(limit=10)
        assert any(j.event == "filled" for j in journal)
        summary = svc.portfolio_summary("paper")
        assert summary["open_positions"] >= 1
        assert summary["auditor"] == "Claire Bennett"
        assert summary["risk_officer"] == "Helena Frost"
    finally:
        db.close()


def test_reduce_position_realizes_pnl():
    db = SessionLocal()
    try:
        svc = PortfolioService(db)
        svc.record_order_event(
            client_order_id="eti-test-long-2",
            provider="binance",
            environment="paper",
            symbol="ETHUSDT",
            side="buy",
            qty=1.0,
            status="filled",
            fill_price=2000.0,
            risk_approved=True,
        )
        svc.record_order_event(
            client_order_id="eti-test-sell-2",
            provider="binance",
            environment="paper",
            symbol="ETHUSDT",
            side="sell",
            qty=0.4,
            status="filled",
            fill_price=2100.0,
            risk_approved=True,
        )
        positions = [p for p in svc.list_positions("paper", "open") if p.symbol == "ETHUSDT"]
        assert positions
        assert abs(positions[0].qty - 0.6) < 1e-9
        assert positions[0].realized_pnl > 0
    finally:
        db.close()

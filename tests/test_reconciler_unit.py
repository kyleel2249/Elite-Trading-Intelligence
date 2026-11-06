import pytest
from unittest.mock import AsyncMock, patch

from app.database import Base, engine, SessionLocal
from app.models import OrderRecord
from app.trading.reconciliation import OrderReconciler
from app.config import Settings


def setup_module():
    Base.metadata.create_all(bind=engine)


@pytest.mark.asyncio
async def test_reconcile_no_remote_when_unconfigured():
    db = SessionLocal()
    try:
        row = OrderRecord(
            client_order_id="eti-recon-1",
            provider="binance",
            environment="paper",
            symbol="BTCUSDT",
            side="buy",
            order_type="market",
            qty=0.01,
            status="submitted",
            risk_approved=True,
        )
        db.add(row)
        db.commit()

        settings = Settings(
            binance_api_key=None,
            binance_secret_key=None,
            alpaca_api_key=None,
            alpaca_secret_key=None,
        )
        rec = OrderReconciler(db, settings)
        result = await rec.reconcile_open(limit=10)
        assert result["checked"] >= 1
        assert result["analyst"] == "Omar Diallo"
        assert result["auditor"] == "Claire Bennett"
    finally:
        db.close()

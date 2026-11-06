from app.database import Base, engine, SessionLocal
from app.models import ForecastRecord
from app.intelligence.forecast_accuracy import ForecastAccuracyService


def setup_module():
    Base.metadata.create_all(bind=engine)


def test_score_and_summary():
    db = SessionLocal()
    try:
        fc = ForecastRecord(
            symbol="BTCUSDT",
            provider="binance",
            horizon="intraday",
            model_version="v0-scaffold",
            analyst="Lars Hagen",
            bull_price=110.0,
            base_price=100.0,
            bear_price=90.0,
            confidence=0.4,
            payload={"last_price": 98.0},
        )
        db.add(fc)
        db.commit()
        db.refresh(fc)

        svc = ForecastAccuracyService(db)
        scored = svc.score_pending("BTCUSDT", realized_price=102.0, provider="binance")
        assert scored
        summary = svc.summary(symbol="BTCUSDT")
        assert summary["sample_size"] >= 1
        assert summary["analyst"] == "Lars Hagen"
        assert "mae" in summary
    finally:
        db.close()

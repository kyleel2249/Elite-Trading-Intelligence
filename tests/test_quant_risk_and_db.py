"""RiskEngine position-allocation cap, config clamps and quant persistence (needs repo deps)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.risk.engine import OrderProposal, RiskEngine


def proposal(**kw):
    d = dict(provider="binance", environment="paper", symbol="BTCUSDT", side="buy", qty=10.0,
             equity=10_000.0, data_age_seconds=5, data_status="fresh", reference_price=50.0)
    d.update(kw)
    return OrderProposal(**d)


def test_notional_above_6_percent_rejected_by_risk_engine():
    d = RiskEngine(Settings()).evaluate(proposal(qty=13.0))        # $650 = 6.5%
    assert not d.approved and any("exceeds cap" in r for r in d.reasons)
    assert d.position_allocation_pct == pytest.approx(6.5)


def test_exactly_6_percent_allowed():
    assert RiskEngine(Settings()).evaluate(proposal(qty=12.0)).approved      # $600 = 6.0%


def test_config_cannot_raise_cap_above_6():
    s = Settings(max_position_allocation_pct=50.0)
    assert s.max_position_allocation_pct == 6.0
    assert not RiskEngine(s).evaluate(proposal(qty=13.0)).approved


def test_config_can_lower_cap():
    s = Settings(max_position_allocation_pct=2.0)
    assert not RiskEngine(s).evaluate(proposal(qty=5.0)).approved            # $250 = 2.5%


def test_closing_orders_are_not_blocked_by_cap():
    assert RiskEngine(Settings()).evaluate(proposal(qty=100.0, side="sell", reduces_exposure=True)).approved


def test_live_order_without_reference_price_rejected():
    s = Settings(live_trading_enabled=True, binance_live_trading_enabled=True)
    d = RiskEngine(s).evaluate(proposal(environment="live", reference_price=None, limit_price=None))
    assert not d.approved and any("reference price" in r for r in d.reasons)


def test_kelly_fraction_clamped_in_config():
    assert Settings(kelly_fraction=0.9).kelly_fraction == 0.5
    assert Settings(kelly_fraction=0.01).kelly_fraction == 0.25
    assert Settings().scan_enabled is False


def make_db():
    from app.database import Base
    from app.quant import db_models  # noqa: F401  (register tables)
    from app.prediction_ledger import models as _ledger  # noqa: F401
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_predictions_go_through_existing_append_only_ledger_and_are_idempotent():
    from app.prediction_ledger.models import ImmutableRecordError, PredictionRecord
    from app.quant.service import QuantStore
    db = make_db()
    store = QuantStore(db)
    kw = dict(symbol="AAPL", market_price=90.0, fair_value=110.0, mispricing_pct=18.18, confidence=0.7,
              horizon_days=60, direction="undervalued", invalidation=["stop"], asset_class="equity")
    p1 = store.record_prediction(**kw)
    p2 = store.record_prediction(**kw)                      # retry must not duplicate
    assert p1.prediction_uid == p2.prediction_uid and db.query(PredictionRecord).count() == 1
    p1.reasoning = "rewritten"                              # attempt to rewrite history
    with pytest.raises(ImmutableRecordError):
        db.commit()
    db.rollback()
    assert len(store.ledger_rows()) == 1
    assert store.performance_summary()["scored"] == 0       # no performance claimed without outcomes


def test_mispricing_alert_keeps_discovery_numbers_and_converges():
    from app.quant.mispricing import evaluate_mispricing
    from app.quant.service import QuantStore
    db = make_db()
    store = QuantStore(db)
    res = evaluate_mispricing("Y", 100.0, 80.0)
    a1 = store.record_mispricing("Y", res)
    a2 = store.record_mispricing("Y", evaluate_mispricing("Y", 120.0, 80.0))
    assert a1 == a2                                         # open alert not overwritten
    assert store.track_convergence("Y", 99.0) == 1


def test_coverage_bulk_upsert_and_scan_run():
    from app.quant import db_models as m
    from app.quant.scanner import Coverage, ScanMetrics
    from app.quant.service import QuantStore
    db = make_db()
    store = QuantStore(db)
    cov = {f"S{i}": Coverage(f"S{i}", "equity", "T", provider="a", status="ACTIVE", price=1.0) for i in range(700)}
    store.save_scan(ScanMetrics(universe_size=700, scanned_ok=700), cov)
    store.save_scan(ScanMetrics(universe_size=700, scanned_ok=700), cov)     # upsert, not duplicate
    assert db.query(m.MarketCoverage).count() == 700 and db.query(m.ScanRun).count() == 2


def test_execution_record_unique_signal_id():
    from sqlalchemy.exc import IntegrityError
    from app.quant import db_models as m
    db = make_db()
    db.add(m.ExecutionEventRecord(signal_id="s1", symbol="A", environment="paper", state="FILLED"))
    db.commit()
    db.add(m.ExecutionEventRecord(signal_id="s1", symbol="A", environment="paper", state="FILLED"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

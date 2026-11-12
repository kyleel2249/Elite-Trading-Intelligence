"""End-to-end tests: real PortfolioService fills drive the post-trade learning pipeline."""
import uuid

import pytest

from app.database import SessionLocal, init_db
from app.memory.lessons import PriorityService
from app.memory.models import MemoryLesson, MemorySignal, MemoryTrade
from app.memory.signals import SignalMemoryService
from app.memory.store import MemoryStore
from app.memory.versions import StrategyVersionService
from app.trading.portfolio import PortfolioService


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _sym() -> str:
    return f"L{uuid.uuid4().hex[:9]}USDT".upper()


def _order(pf: PortfolioService, sym: str, side: str, qty: float, price: float, sid: str | None = None):
    return pf.record_order_event(
        client_order_id=f"t-{uuid.uuid4().hex[:12]}", provider="binance", environment="paper", symbol=sym,
        side=side, qty=qty, status="filled", fill_price=price, risk_approved=True,
        thesis=f"StrategyRunner:{sid}:long:test" if sid else None, council_action=None,
    )


def _trades(db, sym):
    db.expire_all()
    return db.query(MemoryTrade).filter(MemoryTrade.symbol == sym).order_by(MemoryTrade.id.asc()).all()


def test_full_lifecycle_runs_all_ten_learning_steps(db):
    sid, sym = f"t_{uuid.uuid4().hex[:8]}", _sym()
    sig = SignalMemoryService(db).record(
        source="strategy_runner", symbol=sym, provider="binance", direction="long", reference_price=100.0,
        stop_price=95.0, target_price=110.0, horizon_seconds=3600, strategy_id=sid)
    pf = PortfolioService(db)

    _order(pf, sym, "buy", 1, 100.2, sid)
    (t,) = _trades(db, sym)
    assert t.status == "open" and t.signal_id == sig.signal_id and t.strategy_id == sid
    assert t.analysis_snapshot["target_price"] == 110.0 and t.analysis_sha256 == sig.analysis_sha256

    _order(pf, sym, "sell", 1, 111.0, sid)
    (t,) = _trades(db, sym)
    assert t.status == "closed" and t.classification == "win"
    assert t.gross_pnl == pytest.approx(10.8)
    assert t.fees == pytest.approx((100.2 + 111.0) * 5 / 1e4)
    assert t.net_pnl == pytest.approx(t.gross_pnl - t.fees)
    assert t.entry_slippage_bps == pytest.approx(20.0, rel=1e-3)
    assert t.analysis_integrity == "verified"
    assert abs(t.pnl_reconciliation_diff) < 1e-9

    steps = t.learning["steps"]
    for key in ("original_analysis", "actual_execution", "price_comparison", "pnl", "costs", "assumptions",
                "regime", "strategy_evaluation", "lessons_updated", "priorities_updated"):
        assert key in steps, key
    held = {a["type"] for a in steps["assumptions"]["held"]}
    assert {"direction", "target_reached", "stop_respected", "horizon"} <= held
    assert steps["costs"]["slippage_alert"] is True and steps["costs"]["fees_estimated"] is True

    db.refresh(sig)
    assert sig.status == "executed" and sig.trade_id == t.trade_id
    assert db.query(MemoryLesson).filter(MemoryLesson.strategy_id == sid).count() >= 1
    topics = {p.topic_key for p in PriorityService(db).list(kind="monitoring")}
    assert f"monitoring:execution:{sym}" in topics
    assert steps["strategy_evaluation"]["sample_size"] == 1


def test_losing_trade_records_failed_assumptions_and_failure_memory(db):
    sid, sym = f"t_{uuid.uuid4().hex[:8]}", _sym()
    SignalMemoryService(db).record(
        source="strategy_runner", symbol=sym, provider="binance", direction="long", reference_price=100.0,
        stop_price=95.0, target_price=110.0, horizon_seconds=3600, strategy_id=sid)
    pf = PortfolioService(db)
    _order(pf, sym, "buy", 1, 100.0, sid)
    _order(pf, sym, "sell", 1, 90.0, sid)
    (t,) = _trades(db, sym)
    assert t.classification == "loss" and t.net_pnl < 0
    failed = {a["type"] for a in t.learning["steps"]["assumptions"]["failed"]}
    assert {"direction", "stop_respected"} <= failed
    assert t.exit_deviation_kind == "vs_stop" and t.expected_exit_price == 95.0
    assert t.slippage_cost == pytest.approx(5.0)
    failure = MemoryStore(db).get("strategy_failure", f"failure:{t.trade_id}")
    assert failure is not None and "not a verdict" in failure.content["interpretation"]
    topics = {p.topic_key for p in PriorityService(db).list(kind="research")}
    assert f"research:assumption:{sid}:direction" in topics


def test_unplanned_trade_has_no_invented_analysis(db):
    sym = _sym()
    pf = PortfolioService(db)
    _order(pf, sym, "buy", 1, 50.0)
    _order(pf, sym, "sell", 1, 51.0)
    (t,) = _trades(db, sym)
    assert t.strategy_id == "manual" and t.signal_id is None
    assert t.learning["steps"]["original_analysis"]["had_prior_analysis"] is False
    assert t.learning["steps"]["assumptions"]["held"] == [] and t.learning["steps"]["assumptions"]["failed"] == []
    assert "monitoring:process:unplanned_trades" in {p.topic_key for p in PriorityService(db).list(kind="monitoring")}


def test_tampered_analysis_is_detected_at_close(db):
    sid, sym = f"t_{uuid.uuid4().hex[:8]}", _sym()
    sig = SignalMemoryService(db).record(
        source="strategy_runner", symbol=sym, provider="binance", direction="long", reference_price=100.0,
        horizon_seconds=3600, strategy_id=sid)
    pf = PortfolioService(db)
    _order(pf, sym, "buy", 1, 100.0, sid)
    sig = db.query(MemorySignal).filter(MemorySignal.signal_id == sig.signal_id).one()
    sig.analysis = {"rewritten": "with hindsight"}  # simulate a retroactive edit
    db.commit()
    _order(pf, sym, "sell", 1, 101.0, sid)
    (t,) = _trades(db, sym)
    assert t.analysis_integrity == "mismatch"
    assert "monitoring:analysis_integrity" in {p.topic_key for p in PriorityService(db).list(kind="monitoring")}


def test_partial_reduce_then_flip_closes_and_reopens(db):
    sym = _sym()
    pf = PortfolioService(db)
    _order(pf, sym, "buy", 2, 100.0)
    _order(pf, sym, "sell", 1, 110.0)  # reduce: +10
    _order(pf, sym, "sell", 3, 105.0)  # closes last 1 (+5) and flips short 2
    first, second = _trades(db, sym)
    assert first.status == "closed" and first.gross_pnl == pytest.approx(15.0)
    assert len(first.exit_fills) == 2 and abs(first.pnl_reconciliation_diff) < 1e-9
    assert second.status == "open" and second.side == "short" and second.open_qty == pytest.approx(2.0)


def test_marks_track_best_and_worst_price(db):
    sym = _sym()
    pf = PortfolioService(db)
    _order(pf, sym, "buy", 1, 100.0)
    pf.mark_positions({("binance", "paper", sym): 120.0})
    pf.mark_positions({("binance", "paper", sym): 90.0})
    (t,) = _trades(db, sym)
    assert t.mfe_price == 120.0 and t.mae_price == 90.0


def test_one_trade_never_rewrites_a_strategy_only_conservative_proposals_after_enough_trades(db):
    sym, mod = _sym(), "turtle_trend"
    pf = PortfolioService(db)
    svc = StrategyVersionService(db)

    _order(pf, sym, "buy", 1, 100.0, mod)
    _order(pf, sym, "sell", 1, 90.0, mod)
    assert [v.status for v in svc.history(mod)] == ["baseline"], "a single loss must not change anything"

    for _ in range(24):
        _order(pf, sym, "buy", 1, 100.0, mod)
        _order(pf, sym, "sell", 1, 90.0, mod)

    hist = svc.history(mod)
    base = hist[0]
    assert svc.effective_version(mod).version == base.version and base.status == "baseline"
    for v in hist[1:]:  # anything the learning loop created is only ever a proposal
        assert v.status == "proposed" and v.created_by == "system:learning"
        assert v.config["risk_per_trade_pct"] < base.config["risk_per_trade_pct"]
        assert v.evidence["conservative_only"] is True
    assert len(hist) <= 2  # cooldown + one open proposal at a time
    closed = [t for t in _trades(db, sym) if t.status == "closed"]
    assert len(closed) == 25

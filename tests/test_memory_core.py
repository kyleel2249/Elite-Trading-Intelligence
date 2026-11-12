"""Unit and service tests for the ETI persistent memory system (pure logic + DB services)."""
import uuid
from datetime import timedelta

import pytest

from app.database import SessionLocal, init_db
from app.memory.assumptions import evaluate_assumptions, split_results
from app.memory.backtests import BacktestMemoryService
from app.memory.lessons import lesson_status
from app.memory.partition import (
    LeakageError, assert_not_future, audit_split, chronological_split, is_forward_evidence, point_in_time,
)
from app.memory.signals import SignalMemoryService, derive_assumptions, direction_from_action, signal_fingerprint
from app.memory.store import MemoryStore, normalize_key
from app.memory.util import utcnow, wilson_interval
from app.memory.versions import StrategyVersionService


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


def uid(prefix: str = "T") -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}".upper()


# ----------------------------------------------------------------------------- partitioning
def test_chronological_split_is_ordered_and_embargoed():
    plan = chronological_split(100, 0.6, 0.2, embargo_bars=2)
    assert plan.train == (0, 60)
    assert plan.validation == (62, 82)
    assert plan.holdout == (84, 100)
    assert plan.train[1] <= plan.validation[0] and plan.validation[1] <= plan.holdout[0]


@pytest.mark.parametrize("args", [(5, 0.6, 0.2, 0), (100, 0.9, 0.2, 0), (100, 0.6, 0.2, -1), (20, 0.6, 0.2, 5)])
def test_split_rejects_bad_inputs(args):
    with pytest.raises(ValueError):
        chronological_split(*args)


def test_audit_flags_overlap_embargo_tuning_and_survivorship():
    assert "evaluation_overlaps_training" in audit_split((0, 100), (50, 150))["failures"]
    gap = audit_split((0, 100), (101, 200), embargo_bars=5)
    assert gap["passed"] is False and any(f.startswith("embargo_gap") for f in gap["failures"])
    assert "parameters_tuned_on_evaluation_data" in audit_split((0, 100), (110, 200), tuned_on_evaluation=True)["failures"]
    assert "train_and_evaluation_ranges_not_declared" in audit_split(None, None)["failures"]
    ok = audit_split((0, 100), (110, 200), embargo_bars=5, universe_source="point_in_time")
    assert ok["passed"] is True and ok["warnings"] == []
    assert "universe_not_point_in_time_survivorship_risk" in audit_split((0, 1), (5, 9))["warnings"]


def test_unfitted_parameters_cannot_leak_through_overlap():
    a = audit_split(None, None, parameters_fitted=False)
    assert a["passed"] is True and "no_parameter_fitting_performed" in a["notes"]
    assert audit_split(None, None, parameters_fitted=False, tuned_on_evaluation=True)["passed"] is False


def test_point_in_time_and_future_guards():
    now = utcnow()
    recs = [{"t": now - timedelta(hours=2)}, {"t": now + timedelta(hours=2)}]
    assert len(point_in_time(recs, now, key=lambda r: r["t"])) == 1
    with pytest.raises(LeakageError):
        assert_not_future(now + timedelta(hours=1))
    assert is_forward_evidence(now, now - timedelta(days=1)) is True
    assert is_forward_evidence(now - timedelta(days=2), now - timedelta(days=1)) is False
    assert is_forward_evidence(now, None) is False


# ----------------------------------------------------------------------------- assumptions
CTX = {"side": "long", "exit_price": 111.0, "gross_pnl": 10.0, "holding_seconds": 600, "stop_price": 95.0,
       "target_price": 110.0, "horizon_seconds": 3600, "mfe_price": 112.0, "mae_price": 99.0}


def test_assumptions_held_and_failed():
    res = evaluate_assumptions(
        [{"type": "direction"}, {"type": "target_reached"}, {"type": "stop_respected"}, {"type": "horizon"}], CTX)
    assert {r["type"]: r["result"] for r in res} == {
        "direction": "held", "target_reached": "held", "stop_respected": "held", "horizon": "held"}
    bad = evaluate_assumptions(
        [{"type": "direction"}, {"type": "stop_respected"}, {"type": "horizon"}],
        {**CTX, "gross_pnl": -5.0, "exit_price": 90.0, "mae_price": 90.0, "holding_seconds": 7200})
    grouped = split_results(bad)
    assert len(grouped["failed"]) == 3 and not grouped["held"]


def test_assumptions_never_guess():
    res = evaluate_assumptions(
        [{"type": "regime_stable"}, {"type": "astrology"}, {"type": "max_slippage_bps"}, "junk"],
        {"side": "long", "regime_entry": "unknown", "regime_exit": "sideways"})
    assert [r["result"] for r in res] == ["not_evaluable"] * 3
    short = evaluate_assumptions([{"type": "target_reached"}], {"side": "short", "exit_price": 89.0, "target_price": 90.0})
    assert short[0]["result"] == "held"
    assert evaluate_assumptions([{"type": "regime_stable"}], {"regime_entry": "a", "regime_exit": "b"})[0]["result"] == "failed"


# ----------------------------------------------------------------------------- lessons / stats
def test_lesson_status_needs_sample_size():
    assert lesson_status(1, 1) == "observation"
    assert lesson_status(4, 4) == "observation"  # perfect but tiny sample is still only an observation
    assert lesson_status(5, 6) == "supported"
    assert lesson_status(19, 20) == "established"
    assert lesson_status(1, 10) == "contradicted"
    assert lesson_status(5, 10) == "mixed"
    lo, hi = wilson_interval(8, 10)
    assert 0.4 < lo < 0.8 < hi < 1.0
    assert wilson_interval(0, 0) is None


# ----------------------------------------------------------------------------- versioned store
def test_store_versions_documents_and_records_events(db):
    store = MemoryStore(db)
    key = f"pref-{uuid.uuid4().hex[:8]}"
    r1, new1 = store.put_document("user_preference", key, {"style": "swing"}, tags=["x"])
    r1b, new1b = store.put_document("user_preference", key, {"style": "swing"})
    assert new1 and not new1b and r1b.version == 1
    r2, new2 = store.put_document("user_preference", key, {"style": "position"})
    assert new2 and r2.version == 2 and r2.tags == ["x"]
    hist = store.history("user_preference", key)
    assert [h.status for h in hist] == ["superseded", "active"]
    assert store.get("user_preference", key).content == {"style": "position"}
    assert store.get("user_preference", key, version=1).content == {"style": "swing"}
    ev = store.add_event("market_observation", {"text": "range-bound"}, tags=["btc"])
    assert ev.version == 1 and ev.key.startswith("market_observation:")
    with pytest.raises(ValueError):
        store.put_document("market_observation", "k", {})
    with pytest.raises(ValueError):
        store.add_event("risk_limit", {})
    with pytest.raises(ValueError):
        normalize_key("bad key!")
    assert store.overview()["domains"]["user_preferences"] >= 1


def test_seed_static_knowledge_is_idempotent(db):
    store = MemoryStore(db)
    first = store.seed_static_knowledge()
    second = store.seed_static_knowledge()
    assert second["trader_profile"]["new_versions"] == 0 and second["methodology"]["new_versions"] == 0
    assert first["methodology"]["new_versions"] + first["methodology"]["unchanged"] > 0


# ----------------------------------------------------------------------------- signals
def test_direction_mapping_and_derived_assumptions():
    assert direction_from_action("BUY") == "long" and direction_from_action("sell") == "short"
    assert direction_from_action("HOLD") == "flat" and direction_from_action("exit_long") == "exit"
    assert direction_from_action("???") == "unknown"
    items = derive_assumptions("long", None, stop=95, target=110, horizon=3600, regime="sideways")
    assert {i["type"] for i in items} == {"direction", "target_reached", "stop_respected", "horizon", "regime_stable"}
    assert derive_assumptions("flat", None, stop=None, target=None, horizon=None, regime=None) == []


def test_signal_record_dedupe_and_future_guard(db):
    svc = SignalMemoryService(db)
    sym = uid() + "USDT"
    a = svc.record(source="council", symbol=sym, provider="binance", action="BUY", confidence=72, reference_price=100.0)
    b = svc.record(source="council", symbol=sym, provider="binance", action="BUY", confidence=72, reference_price=100.0)
    assert a.signal_id == b.signal_id and a.confidence == pytest.approx(0.72)
    assert a.horizon_seconds and a.analysis_sha256 == signal_fingerprint(a)
    with pytest.raises(ValueError):
        svc.record(source="manual", symbol=sym, provider="binance", direction="long", as_of=utcnow() + timedelta(hours=1))
    with pytest.raises(ValueError):
        svc.record(source="manual", symbol=sym, provider="binance", direction="long", reference_price=100, stop_price=105)


def test_signal_resolution_accuracy_and_no_lookahead(db):
    svc = SignalMemoryService(db)
    sid, sym = f"s_{uuid.uuid4().hex[:8]}", uid() + "USDT"
    sig = svc.record(source="strategy_runner", symbol=sym, provider="binance", direction="long", reference_price=100.0,
                     horizon_seconds=3600, strategy_id=sid, as_of=utcnow() - timedelta(seconds=3700))
    with pytest.raises(LeakageError):  # outcome dated before the horizon elapsed
        svc.resolve_signal(sig, 105.0, sig.as_of + timedelta(seconds=10))
    done = svc.resolve_signal(sig, 105.0, utcnow())
    assert done.outcome == "hit" and done.outcome_return_pct == pytest.approx(5.0) and done.outcome_status == "scored"
    with pytest.raises(ValueError):
        svc.resolve_signal(done, 105.0, utcnow())
    acc = svc.accuracy(strategy_id=sid)
    assert acc["directional"]["n"] == 1 and acc["directional"]["hit_rate"] == 1.0
    assert acc["population"]["scored"] == 1
    assert any("n < 30" in n or "not statistically" in n for n in acc["notes"])


def test_short_flat_and_expired_signals_stay_in_population(db):
    svc = SignalMemoryService(db)
    sid, sym = f"s_{uuid.uuid4().hex[:8]}", uid() + "USDT"
    short = svc.record(source="manual", symbol=sym, provider="binance", direction="short", reference_price=100.0,
                       horizon_seconds=3600, strategy_id=sid, as_of=utcnow() - timedelta(seconds=3700))
    svc.resolve_signal(short, 95.0, utcnow())
    assert short.outcome == "hit" and short.outcome_return_pct == pytest.approx(5.0)
    stale = svc.record(source="manual", symbol=sym, provider="kraken", direction="long", reference_price=100.0,
                       horizon_seconds=3600, strategy_id=sid, as_of=utcnow() - timedelta(hours=10))
    summary = svc.resolve_due({("kraken", sym): 100.0})
    assert summary["expired_unscored"] >= 1
    db.refresh(stale)
    assert stale.outcome_status == "expired_unscored"
    acc = svc.accuracy(strategy_id=sid)
    assert acc["population"]["expired_unscored"] == 1 and acc["population"]["total"] == 2
    assert acc["coverage"] == pytest.approx(0.5)


# ----------------------------------------------------------------------------- backtests + governance
WF = {"folds": [{"end_index": 120, "trades": 4, "max_drawdown_pct": 1.0}, {"end_index": 140, "trades": 3, "max_drawdown_pct": 2.0}],
      "aggregate_return_pct": 2.5}


def test_backtest_partition_eligibility(db):
    svc = BacktestMemoryService(db)
    insample = svc.record(strategy_id="darvas_box", symbol="BTCUSDT", provider="binance",
                          result={"bars": 200, "trades": 9, "win_rate": 0.5, "total_return_pct": 4.0, "max_drawdown_pct": 3.0},
                          partition="train")
    assert insample.validation_eligible is False and insample.leakage_audit["passed"] is False
    overlap = svc.record(strategy_id="darvas_box", symbol="BTCUSDT", provider="binance", result=WF, partition="validation",
                         training_range=(0, 100), evaluation_range=(50, 140))
    assert overlap.validation_eligible is False
    good = svc.record(strategy_id="darvas_box", symbol="BTCUSDT", provider="binance", result=WF, partition="validation",
                      training_range=(0, 80), evaluation_range=(80, 140), parameters_fitted=False)
    assert good.validation_eligible is True and good.trades == 7 and good.bars == 140
    with pytest.raises(ValueError):
        svc.record(strategy_id="x", symbol="BTCUSDT", provider="binance", result=WF, partition="live")


def test_version_governance_requires_evidence_and_human_approval(db):
    svc = StrategyVersionService(db)
    base = svc.ensure_baseline("darvas_box")
    assert base is not None and base.status == "baseline" and base.version == 1
    cfg = {**base.config, "lookback": 25}
    cand = svc.create_version("darvas_box", cfg, reason="test wider lookback", created_by="alice")
    assert cand.status == "candidate" and cand.change_diff["changed"]["lookback"] == {"from": 20, "to": 25}

    with pytest.raises(ValueError):  # identical config
        svc.create_version("darvas_box", base.config, reason="no change", created_by="alice")
    with pytest.raises(ValueError):  # out-of-range risk
        svc.create_version("darvas_box", {**cfg, "risk_per_trade_pct": 50}, reason="too risky", created_by="alice")
    with pytest.raises(PermissionError):  # autonomous actors can never validate/activate
        svc.transition("darvas_box", cand.version, "validated", actor="bot", actor_kind="system")
    with pytest.raises(ValueError):  # no validation-partition evidence yet
        svc.transition("darvas_box", cand.version, "validated", actor="alice")
    with pytest.raises(ValueError):  # cannot skip validation
        svc.transition("darvas_box", cand.version, "active", actor="alice")

    BacktestMemoryService(db).record(
        strategy_id="darvas_box", symbol="BTCUSDT", provider="binance", result=WF, partition="validation",
        strategy_version=cand.version, training_range=(0, 80), evaluation_range=(80, 140), parameters_fitted=False)
    assert svc.transition("darvas_box", cand.version, "validated", actor="alice").status == "validated"
    with pytest.raises(PermissionError):
        svc.transition("darvas_box", cand.version, "active", actor="bot", actor_kind="system")
    svc.transition("darvas_box", cand.version, "active", actor="alice")
    assert svc.effective_version("darvas_box").version == cand.version
    assert svc.get("darvas_box", 1).status == "retired"

    rb = svc.rollback("darvas_box", 1, approved_by="alice", note="test")
    assert rb.status == "active" and rb.config["lookback"] == 20
    assert svc.get("darvas_box", cand.version).status == "retired"
    assert [v.version for v in svc.history("darvas_box")] == [1, cand.version, rb.version]

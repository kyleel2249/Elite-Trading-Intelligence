"""Prediction ledger tests: scoring, calibration, immutability, API, reports."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DatabaseError

from app.database import Base, SessionLocal, engine
from app.main import app
from app.prediction_ledger.evaluation import compute_metrics, group_metrics, score_prediction
from app.prediction_ledger.models import ImmutableRecordError, PredictionRecord
from app.prediction_ledger.reports import build_summary, period_bounds, publish_report, render_markdown
from app.prediction_ledger.service import create_prediction, naive_utc, resolve_prediction, scored_rows


def setup_module():
    from app.database import init_db
    init_db()


def _mk(db, **kw):
    base = dict(asset="BTCUSDT", market="crypto", direction="up", entry_reference=100.0, horizon_seconds=3600,
                probability=0.7, reasoning="momentum + liquidity", sources=["unit-test"],
                invalidation_criteria="close below 95", target_low=98.0, target_high=110.0, target_base=105.0,
                invalidation_price=95.0, market_regime="weak_bull", strategy="turtle_trend")
    base.update(kw)
    return create_prediction(db, **base)


def _expire(db, pred):
    """Move 'now' past expiry instead of mutating the (immutable) row."""
    return pred.expires_at + timedelta(seconds=30)


# ---------- pure scoring ----------
def test_score_up_hit():
    s = score_prediction(dict(direction="up", entry_reference=100, target_low=98, target_high=110, target_base=105, invalidation_price=95), 104)
    assert s["direction_correct"] and s["in_target_range"] and not s["invalidated"]
    assert s["abs_error"] == pytest.approx(1.0)


def test_score_down_miss_and_invalidation():
    s = score_prediction(dict(direction="down", entry_reference=100, invalidation_price=104), 106)
    assert not s["direction_correct"] and s["invalidated"]


def test_score_neutral_band():
    assert score_prediction(dict(direction="neutral", entry_reference=100), 100.3)["direction_correct"]
    assert not score_prediction(dict(direction="neutral", entry_reference=100), 101.5)["direction_correct"]


def test_metrics_calibration_and_sample_warning():
    rows = [dict(status="resolved", probability=0.9, direction_correct=(i % 2 == 0), in_target_range=True,
                 pct_error=0.01, abs_error=1.0, invalidated=False, asset="A") for i in range(10)]
    m = compute_metrics(rows)
    assert m["n_scored"] == 10 and m["directional_accuracy"] == 0.5
    assert m["calibration_gap"] == pytest.approx(0.4)
    assert m["brier_score"] == pytest.approx(0.5 * 0.01 + 0.5 * 0.81)
    assert not m["sufficient_sample"] and "warning" in m


def test_late_outcomes_excluded_but_counted():
    rows = [dict(status="late", probability=0.6, direction_correct=True, asset="A"),
            dict(status="resolved", probability=0.6, direction_correct=False, asset="A")]
    m = compute_metrics(rows)
    assert m["n_scored"] == 1 and m["n_late_excluded"] == 1 and m["directional_accuracy"] == 0.0
    assert group_metrics(rows, lambda r: r["asset"])["A"]["n_scored"] == 1


def test_empty_metrics():
    assert compute_metrics([])["directional_accuracy"] is None


# ---------- persistence + immutability ----------
def test_create_resolve_and_failed_prediction_kept():
    db = SessionLocal()
    try:
        p, created = _mk(db, asset="ETHUSDT", idempotency_key="t-create-1")
        assert created and len(p.content_hash) == 64
        again, created2 = _mk(db, asset="ETHUSDT", idempotency_key="t-create-1")
        assert not created2 and again.id == p.id

        with pytest.raises(ValueError):  # before expiry
            resolve_prediction(db, p, 101.0, price_source="test", observed_at=naive_utc())
        o = resolve_prediction(db, p, 90.0, price_source="test", observed_at=_expire(db, p))  # wrong + invalidated
        assert o.status == "invalidated" and o.direction_correct is False
        again_o = resolve_prediction(db, p, 200.0, price_source="test", observed_at=_expire(db, p))
        assert again_o.id == o.id and again_o.realized_price == 90.0  # first outcome stands
        assert any(r["prediction_uid"] == p.prediction_uid and r["status"] == "invalidated" for r in scored_rows(db))
    finally:
        db.close()


def test_late_resolution_flagged():
    db = SessionLocal()
    try:
        p, _ = _mk(db, asset="SOLUSDT")
        o = resolve_prediction(db, p, 105.0, price_source="test", observed_at=p.expires_at + timedelta(hours=5))
        assert o.status == "late"
    finally:
        db.close()


def test_orm_update_and_delete_blocked():
    db = SessionLocal()
    try:
        p, _ = _mk(db, asset="ADAUSDT")
        p.reasoning = "rewritten after the fact"
        with pytest.raises(ImmutableRecordError):
            db.commit()
        db.rollback()
        db.delete(db.get(PredictionRecord, p.id))
        with pytest.raises(ImmutableRecordError):
            db.commit()
        db.rollback()
    finally:
        db.close()


def test_raw_sql_update_and_delete_blocked_by_trigger():
    db = SessionLocal()
    try:
        p, _ = _mk(db, asset="XRPUSDT")
        for stmt in ("UPDATE predictions SET probability = 0.99 WHERE id = :i", "DELETE FROM predictions WHERE id = :i"):
            with pytest.raises(DatabaseError):
                db.execute(text(stmt), {"i": p.id})
                db.commit()
            db.rollback()
    finally:
        db.close()


# ---------- reports ----------
def test_period_bounds_and_validation():
    assert period_bounds("2026-12") == (datetime(2026, 12, 1), datetime(2027, 1, 1))
    with pytest.raises(ValueError):
        period_bounds("2026-13")


def test_report_publish_once_and_not_before_month_end():
    db = SessionLocal()
    try:
        with pytest.raises(ValueError):
            publish_report(db, "2099-01")
        rep, created = publish_report(db, "2000-01", now=datetime(2000, 3, 1))
        rep2, created2 = publish_report(db, "2000-01", now=datetime(2000, 3, 1))
        assert created and not created2 and rep.id == rep2.id
        assert "Prediction Performance Report" in rep.markdown
        assert render_markdown(build_summary(db, "2000-01")).startswith("# ETI")
    finally:
        db.close()


# ---------- API ----------
VALID = dict(asset="BTCUSDT", market="crypto", direction="up", entry_reference=100, horizon_seconds=3600, probability=0.6,
             reasoning="api test reasoning", sources=["https://example.org/a"], invalidation_criteria="below 95")
client = TestClient(app)


def test_api_create_get_list_and_validation():
    r = client.post("/api/predictions", json={**VALID, "idempotency_key": "api-1"})
    assert r.status_code == 201, r.text
    uid = r.json()["prediction_uid"]
    assert client.get(f"/api/predictions/{uid}").json()["outcome"] is None
    assert any(x["prediction_uid"] == uid for x in client.get("/api/predictions").json()["predictions"])
    assert client.post("/api/predictions", json={**VALID, "probability": 1.5}).status_code == 422
    assert client.post("/api/predictions", json={**VALID, "sources": []}).status_code == 422
    assert client.post("/api/predictions", json={**VALID, "target_low": 5, "target_high": 1}).status_code == 422
    assert client.post("/api/predictions", json={**VALID, "created_at": "2001-01-01T00:00:00"}).json()["created_at"] > "2020"


def test_api_cannot_settle_before_expiry_and_unknown_404():
    uid = client.post("/api/predictions", json=VALID).json()["prediction_uid"]
    r = client.post(f"/api/predictions/{uid}/outcome", json={"realized_price": 101, "price_source": "manual"})
    assert r.status_code == 409
    assert client.get("/api/predictions/does-not-exist").status_code == 404


def test_api_metrics_reports_and_page():
    assert "overall" in client.get("/api/predictions/metrics").json()
    assert client.get("/api/predictions/reports").status_code == 200
    assert client.get("/api/predictions/reports/2099-01").status_code == 404
    assert client.get("/api/predictions/reports/bad").status_code == 422
    assert client.get("/api/predictions/reports/2026-10/preview").status_code == 200
    assert client.post("/api/predictions/reports/2099-01/publish").status_code == 409
    page = client.get("/predictions")
    assert page.status_code == 200 and "Prediction Accountability" in page.text

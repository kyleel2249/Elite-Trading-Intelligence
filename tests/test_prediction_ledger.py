"""Prediction ledger tests: scoring, calibration, immutability, candle resolution, API, reports."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import DatabaseError

from app.database import SessionLocal
from app.main import app
from app.prediction_ledger.evaluation import compute_metrics, group_metrics, lateness_tolerance, score_prediction
from app.prediction_ledger.models import ImmutableRecordError, PredictionRecord
from app.prediction_ledger.reports import build_summary, period_bounds, publish_report, render_markdown
from app.prediction_ledger.service import (_hash, _hash_body, create_prediction, kline_resolution, naive_utc,
                                           record_from_forecast, resolve_prediction, scored_rows, verify_hash)


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


def _past(db, *, age_s=7200, horizon_s=3600, **kw):
    """Insert a prediction that was made `age_s` ago (ORM insert is allowed; only updates/deletes are blocked)."""
    created = naive_utc() - timedelta(seconds=age_s)
    import uuid
    row = PredictionRecord(
        prediction_uid=str(uuid.uuid4()), created_at=created, asset=kw.get("asset", "BTCUSDT"), market="crypto",
        provider=kw.get("provider"), direction=kw.get("direction", "up"), entry_reference=100.0,
        horizon_label="intraday", horizon_seconds=horizon_s, expires_at=created + timedelta(seconds=horizon_s),
        target_low=98.0, target_high=110.0, target_base=105.0, probability=0.7, reasoning="past prediction",
        sources=["unit-test"], invalidation_criteria="below 95", invalidation_price=kw.get("inv", 95.0),
        model_version="manual", content_hash="")
    row.content_hash = _hash(_hash_body(row))
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ---------- pure scoring ----------
def test_score_up_hit():
    s = score_prediction(dict(direction="up", entry_reference=100, target_low=98, target_high=110, target_base=105, invalidation_price=95), 104)
    assert s["direction_correct"] and s["in_target_range"] and not s["invalidated"]
    assert s["abs_error"] == pytest.approx(1.0)


def test_score_down_miss_and_invalidation():
    s = score_prediction(dict(direction="down", entry_reference=100, invalidation_price=104), 106)
    assert not s["direction_correct"] and s["invalidated"]


def test_path_aware_invalidation():
    up = dict(direction="up", entry_reference=100, invalidation_price=95)
    assert not score_prediction(up, 104)["invalidated"]                       # final price alone: fine
    assert score_prediction(up, 104, path_low=94.5)["invalidated"]            # but it traded through 95 on the way
    down = dict(direction="down", entry_reference=100, invalidation_price=105)
    assert score_prediction(down, 98, path_high=105.5)["invalidated"]
    assert not score_prediction(down, 98, path_high=104)["invalidated"]


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


def test_lateness_tolerance_covers_evaluator_interval():
    assert lateness_tolerance(1800) >= 900 and lateness_tolerance(14 * 86400) == pytest.approx(0.10 * 14 * 86400)


# ---------- candle resolution ----------
def _bars(start: datetime, n: int, bar_ms: int = 60_000):
    t0 = start.replace(tzinfo=timezone.utc).timestamp() * 1000
    out = []
    for i in range(n):
        o = t0 + i * bar_ms
        c = 100 + i * 0.1
        out.append(dict(open_time=o, close_time=o + bar_ms - 1, open=c, high=c + 1, low=c - 1, close=c, volume=1, data_status="fresh"))
    return out


def test_kline_resolution_price_and_path():
    start = datetime(2026, 1, 1, 0, 0, 0)
    created, expires = start + timedelta(seconds=30), start + timedelta(seconds=30 + 1800)
    r = kline_resolution(_bars(start, 41), created, expires, 60_000)
    assert r is not None and r["bars"] == 29              # candles 1..29: the partial first bar and the one straddling expiry are excluded
    assert r["price"] == pytest.approx(100 + 29 * 0.1)
    assert r["low"] == pytest.approx(100 + 1 * 0.1 - 1) and r["high"] == pytest.approx(100 + 29 * 0.1 + 1)
    assert r["observed_at"] <= expires


def test_kline_resolution_requires_coverage():
    start = datetime(2026, 1, 1, 0, 0, 0)
    created, expires = start, start + timedelta(seconds=1800)
    late_window = _bars(start + timedelta(minutes=10), 40)       # candles begin 10 min after creation
    assert kline_resolution(late_window, created, expires, 60_000) is None
    assert kline_resolution([], created, expires, 60_000) is None
    invalid = [dict(b, data_status="invalid") for b in _bars(start, 40)]
    assert kline_resolution(invalid, created, expires, 60_000) is None


# ---------- persistence + immutability ----------
def test_create_resolve_and_failed_prediction_kept():
    db = SessionLocal()
    try:
        p, created = _mk(db, asset="ETHUSDT", idempotency_key="t-create-1")
        assert created and len(p.content_hash) == 64 and verify_hash(p)["intact"]
        again, created2 = _mk(db, asset="ETHUSDT", idempotency_key="t-create-1")
        assert not created2 and again.id == p.id

        with pytest.raises(ValueError):  # before expiry
            resolve_prediction(db, p, 101.0, price_source="test", observed_at=naive_utc())
        obs = p.expires_at + timedelta(seconds=30)
        o = resolve_prediction(db, p, 90.0, price_source="test", observed_at=obs)  # wrong + invalidated
        assert o.status == "invalidated" and o.direction_correct is False
        again_o = resolve_prediction(db, p, 200.0, price_source="test", observed_at=obs)
        assert again_o.id == o.id and again_o.realized_price == 90.0  # first outcome stands
        assert any(r["prediction_uid"] == p.prediction_uid and r["status"] == "invalidated" for r in scored_rows(db))
    finally:
        db.close()


def test_snapshot_resolution_late_flagged():
    db = SessionLocal()
    try:
        p = _past(db, asset="SOLUSDT")                      # expired an hour ago
        o = resolve_prediction(db, p, 105.0, price_source="snapshot", observed_at=naive_utc())
        assert o.status == "late" and o.late_seconds > lateness_tolerance(3600)
    finally:
        db.close()


def test_historical_resolution_is_never_late_and_uses_path():
    db = SessionLocal()
    try:
        p = _past(db, asset="DOGEUSDT")
        o = resolve_prediction(db, p, 104.0, price_source="binance:kline-1m-close-at-expiry",
                               observed_at=p.expires_at - timedelta(seconds=1), path_low=94.0, historical=True)
        assert o.status == "invalidated" and o.late_seconds == 0.0 and o.direction_correct is True
        q = _past(db, asset="DOGEUSDT")
        with pytest.raises(ValueError):
            resolve_prediction(db, _mk(db, asset="DOGEUSDT")[0], 104.0, price_source="x", historical=True)  # not expired
        assert resolve_prediction(db, q, 104.0, price_source="k", observed_at=q.expires_at, historical=True).status == "resolved"
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


# ---------- auto-logging from forecasts ----------
def _forecast(base: float, symbol: str, horizon: str = "intraday"):
    return {"symbol": symbol, "provider": "binance", "horizon": horizon, "last_price": 100.0,
            "scenarios": {"bull": 103.0, "base": base, "bear": 97.0}, "confidence": 0.4,
            "assumptions": ["a"], "model_version": "v0-scaffold", "analyst": "Lars Hagen"}


def test_forecast_down_call_invalidates_above_entry():
    db = SessionLocal()
    try:
        out = record_from_forecast(db, _forecast(99.0, "DOWNUSDT"))
        p = db.execute(select(PredictionRecord).where(PredictionRecord.prediction_uid == out["prediction_uid"])).scalar_one()
        assert p.direction == "down" and p.invalidation_price == 103.0 and p.invalidation_price > p.entry_reference
        assert p.horizon_seconds == 3600 and p.horizon_label == "intraday"
        assert record_from_forecast(db, _forecast(99.0, "DOWNUSDT"))["created"] is False   # same hour: deduplicated
    finally:
        db.close()


def test_forecast_up_and_neutral_calls():
    db = SessionLocal()
    try:
        up = record_from_forecast(db, _forecast(101.0, "UPUSDT", "swing"))
        pu = db.execute(select(PredictionRecord).where(PredictionRecord.prediction_uid == up["prediction_uid"])).scalar_one()
        assert pu.direction == "up" and pu.invalidation_price == 97.0 and pu.horizon_seconds == 7200
        ne = record_from_forecast(db, _forecast(100.01, "FLATUSDT"))
        pn = db.execute(select(PredictionRecord).where(PredictionRecord.prediction_uid == ne["prediction_uid"])).scalar_one()
        assert pn.direction == "neutral" and pn.invalidation_price is None
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


def test_api_create_get_verify_list_and_validation():
    r = client.post("/api/predictions", json={**VALID, "idempotency_key": "api-1"})
    assert r.status_code == 201, r.text
    uid = r.json()["prediction_uid"]
    assert client.get(f"/api/predictions/{uid}").json()["outcome"] is None
    v = client.get(f"/api/predictions/{uid}/verify").json()
    assert v["intact"] is True and v["stored_hash"] == v["recomputed_hash"]
    assert client.get("/api/predictions/nope/verify").status_code == 404
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


def test_api_settle_matured_prediction_once():
    db = SessionLocal()
    try:
        uid = _past(db, asset="LTCUSDT").prediction_uid
    finally:
        db.close()
    body = {"realized_price": 104.0, "price_source": "manual:exchange-close"}
    first = client.post(f"/api/predictions/{uid}/outcome", json=body)
    assert first.status_code == 201 and first.json()["status"] == "late"   # settled long after expiry on a snapshot basis
    assert client.post(f"/api/predictions/{uid}/outcome", json=body).status_code == 409


def test_api_metrics_reports_and_page():
    assert "overall" in client.get("/api/predictions/metrics").json()
    assert client.get("/api/predictions/reports").status_code == 200
    assert client.get("/api/predictions/reports/2099-01").status_code == 404
    assert client.get("/api/predictions/reports/bad").status_code == 422
    assert client.get("/api/predictions/reports/2026-10/preview").status_code == 200
    assert client.post("/api/predictions/reports/2099-01/publish").status_code == 409
    page = client.get("/predictions")
    assert page.status_code == 200 and "Prediction Accountability" in page.text

"""Ledger operations: SQL pagination, report scheduling (catch-up, pending-wait, grace), manual settlement timing."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal, init_db
from app.main import app
from app.prediction_ledger.models import PredictionRecord
from app.prediction_ledger.queries import due_report_periods, list_page
from app.prediction_ledger.service import _hash, _hash_body, naive_utc, resolve_prediction

client = TestClient(app)


def setup_module():
    init_db()


def _insert(db, created: datetime, *, asset: str, horizon_s: int = 3600) -> PredictionRecord:
    row = PredictionRecord(
        prediction_uid=str(uuid.uuid4()), created_at=created, asset=asset, market="crypto", provider=None,
        direction="up", entry_reference=100.0, horizon_label="intraday", horizon_seconds=horizon_s,
        expires_at=created + timedelta(seconds=horizon_s), target_low=98.0, target_high=110.0, target_base=105.0,
        probability=0.6, reasoning="ops test prediction", sources=["unit-test"], invalidation_criteria="below 95",
        invalidation_price=95.0, model_version="manual", content_hash="")
    row.content_hash = _hash(_hash_body(row))
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_report_waits_for_pending_results_then_publishes_after_grace():
    db = SessionLocal()
    try:
        p = _insert(db, datetime(1999, 5, 10, 12, 0, 0), asset="OPS1")
        assert due_report_periods(db, now=datetime(1999, 5, 20)) == []              # month not finished
        assert due_report_periods(db, now=datetime(1999, 6, 3)) == []               # finished, but result outstanding, within grace
        assert due_report_periods(db, now=datetime(1999, 6, 9)) == ["1999-05"]      # grace over: publish anyway
        resolve_prediction(db, p, 104.0, price_source="test", observed_at=p.expires_at)
        assert due_report_periods(db, now=datetime(1999, 6, 3)) == ["1999-05"]      # resolved: publish immediately
    finally:
        db.close()


def test_report_catch_up_covers_every_missed_month_and_skips_empty_ones():
    db = SessionLocal()
    try:
        a = _insert(db, datetime(1998, 1, 5, 9, 0, 0), asset="OPS2")
        b = _insert(db, datetime(1998, 3, 5, 9, 0, 0), asset="OPS2")
        for p in (a, b):
            resolve_prediction(db, p, 101.0, price_source="test", observed_at=p.expires_at)
        assert due_report_periods(db, now=datetime(1998, 5, 1)) == ["1998-01", "1998-03"]   # February had nothing due
    finally:
        db.close()


def test_list_page_filters_and_paginates_in_sql():
    db = SessionLocal()
    try:
        for i in range(5):
            _insert(db, naive_utc() - timedelta(days=30 + i), asset="PAGEUSDT")
        total, page = list_page(db, asset="pageusdt", limit=2, offset=0)
        assert total == 5 and len(page) == 2
        assert page[0]["created_at"] >= page[1]["created_at"]                       # newest first
        _, rest = list_page(db, asset="PAGEUSDT", limit=10, offset=2)
        assert len(rest) == 3
        assert list_page(db, asset="PAGEUSDT", status="resolved")[0] == 0
        assert list_page(db, asset="PAGEUSDT", status="pending")[0] == 5
    finally:
        db.close()


def test_list_api_pagination_and_status_validation():
    db = SessionLocal()
    try:
        _insert(db, naive_utc() - timedelta(days=40), asset="APIPAGE")
    finally:
        db.close()
    r = client.get("/api/predictions", params={"asset": "APIPAGE", "limit": 1})
    assert r.status_code == 200 and r.json()["total"] == 1 and len(r.json()["predictions"]) == 1
    assert client.get("/api/predictions", params={"status": "bogus"}).status_code == 422
    assert client.get("/api/predictions", params={"limit": 0}).status_code == 422


def test_manual_settlement_with_price_time_at_expiry_is_scored_not_late():
    db = SessionLocal()
    try:
        p = _insert(db, naive_utc() - timedelta(days=2), asset="MANUAL1")
        uid = p.prediction_uid
        as_of = p.expires_at + timedelta(seconds=30)
    finally:
        db.close()
    r = client.post(f"/api/predictions/{uid}/outcome",
                    json={"realized_price": 104.0, "price_source": "exchange close", "observed_at": as_of.isoformat() + "Z"})
    assert r.status_code == 201 and r.json()["status"] == "resolved" and r.json()["direction_correct"] is True

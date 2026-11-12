from datetime import datetime, timedelta

import pytest

from app.alpha.db_models import AlphaCandidateSnapshot
from app.alpha.discovery import SNAPSHOT_MIN_GAP_HOURS, evaluate_ohlcv
from app.alpha.performance import evaluate_discovery
from app.database import SessionLocal, init_db
from tests.alpha_helpers import make_bars

T0 = datetime(2026, 1, 1)
NOW = datetime(2026, 4, 1)


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    s.query(AlphaCandidateSnapshot).delete()
    s.commit()
    yield s
    s.close()


def snap(db, cid, day, status, price, bench=100.0, ac="crypto"):
    db.add(AlphaCandidateSnapshot(candidate_id=cid, ts=T0 + timedelta(days=day), asset_class=ac, symbol=cid.split(":")[-1], status=status,
                                  stage=None, early_alpha_score=60.0, price=price, bench_price=bench))
    db.commit()


def test_flagged_success_needs_threshold_and_beating_the_benchmark(db):
    # A: +20% while the benchmark rose +5% -> success. B: +12% but benchmark +30% -> not a success (just the market).
    snap(db, "c:A", 0, "EARLY_ACCUMULATION", 100.0, 100.0); snap(db, "c:A", 15, "EARLY_ACCUMULATION", 120.0, 105.0)
    snap(db, "c:B", 0, "EARLY_ACCUMULATION", 100.0, 100.0); snap(db, "c:B", 15, "EARLY_ACCUMULATION", 112.0, 130.0)
    r = evaluate_discovery(db, 14, now=NOW)
    assert r["flagged_events"] == 2 and r["precision"] == 0.5 and r["false_positive_rate"] == 0.5
    assert r["benchmarked_share"] == 1.0 and r["avg_excess_flagged_pct"] is not None


def test_no_hindsight_event_uses_only_later_prices_and_pending_is_not_scored(db):
    snap(db, "c:P", 0, "EARLY_ACCUMULATION", 100.0)
    snap(db, "c:P", 85, "WATCHLIST", 150.0)  # far outside the 14-14d..28d window: must not be used as the outcome
    r = evaluate_discovery(db, 14, now=NOW)
    assert r["flagged_events"] == 0 and r["unresolvable"] >= 1
    young = evaluate_discovery(db, 14, now=T0 + timedelta(days=5))
    assert young["pending"] >= 1 and young["flagged_events"] == 0  # too recent to judge


def test_survivorship_vanished_assets_are_counted_not_dropped(db):
    snap(db, "c:GONE", 0, "DEVELOPING_OPPORTUNITY", 100.0)  # never seen again
    r = evaluate_discovery(db, 14, now=NOW)
    assert r["unresolvable"] == 1 and r["flagged_events"] == 0


def test_episodes_are_deduplicated_not_one_event_per_scan(db):
    for d in (0, 1, 2, 3, 4):
        snap(db, "c:E", d, "EARLY_ACCUMULATION", 100.0 + d)  # one episode, five scans
    snap(db, "c:E", 16, "EARLY_ACCUMULATION", 125.0)
    r = evaluate_discovery(db, 14, now=NOW)
    assert r["flagged_events"] == 1
    snap(db, "c:E", 20, "WATCHLIST", 120.0); snap(db, "c:E", 21, "EARLY_ACCUMULATION", 121.0); snap(db, "c:E", 40, "EARLY_ACCUMULATION", 140.0)
    assert evaluate_discovery(db, 14, now=NOW)["flagged_events"] == 2  # a re-flag after a lapse is a new episode


def test_unflagged_base_rate_miss_rate_recall_and_lift(db):
    for i in range(4):  # 4 flagged: 2 succeed
        snap(db, f"c:F{i}", 0, "EARLY_ACCUMULATION", 100.0); snap(db, f"c:F{i}", 15, "EARLY_ACCUMULATION", 130.0 if i < 2 else 95.0)
    for i in range(4):  # 4 unflagged: 1 succeeds
        snap(db, f"c:U{i}", 0, "WATCHLIST", 100.0); snap(db, f"c:U{i}", 15, "WATCHLIST", 130.0 if i == 0 else 100.0)
    r = evaluate_discovery(db, 14, now=NOW)
    assert r["precision"] == 0.5 and r["miss_rate_among_unflagged"] == 0.25 and r["recall"] == pytest.approx(2 / 3, abs=1e-3) and r["lift_vs_unflagged"] == 2.0


def test_lead_time_is_measured_from_flag_to_first_threshold_snapshot(db):
    snap(db, "c:L", 0, "EARLY_ACCUMULATION", 100.0); snap(db, "c:L", 6, "EARLY_ACCUMULATION", 112.0); snap(db, "c:L", 15, "EARLY_ACCUMULATION", 120.0)
    assert evaluate_discovery(db, 14, now=NOW)["median_lead_time_days"] == 6.0


def test_small_samples_make_no_performance_claim(db):
    snap(db, "c:S", 0, "EARLY_ACCUMULATION", 100.0); snap(db, "c:S", 15, "EARLY_ACCUMULATION", 130.0)
    r = evaluate_discovery(db, 14, now=NOW)
    assert r["precision"] == 1.0 and r["small_sample_warning"] is True and "NO performance claim" in r["claim"]
    big = evaluate_discovery(db, 14, now=NOW, min_samples=1)
    assert big["small_sample_warning"] is False


def test_asset_class_thresholds_differ(db):
    snap(db, "e:X", 0, "EARLY_ACCUMULATION", 100.0, ac="equity"); snap(db, "e:X", 15, "EARLY_ACCUMULATION", 107.0, ac="equity")  # +7% >= equity 5%
    snap(db, "c:Y", 0, "EARLY_ACCUMULATION", 100.0, ac="crypto"); snap(db, "c:Y", 15, "EARLY_ACCUMULATION", 107.0, ac="crypto")  # +7% < crypto 10%
    assert evaluate_discovery(db, 14, "equity", now=NOW)["precision"] == 1.0 and evaluate_discovery(db, 14, "crypto", now=NOW)["precision"] == 0.0


def test_scans_write_throttled_append_only_snapshots_with_benchmark(db):
    bars, bench = make_bars(250, seed=2, volume=50000), [100 + i * 0.1 for i in range(250)]
    evaluate_ohlcv(db, asset_class="crypto", symbol="SNAPUSDT", bars=bars, provider="binance_public", exchange="BINANCE", bench_closes=bench)
    evaluate_ohlcv(db, asset_class="crypto", symbol="SNAPUSDT", bars=bars, provider="binance_public", exchange="BINANCE", bench_closes=bench)
    rows = db.query(AlphaCandidateSnapshot).filter_by(symbol="SNAPUSDT").all()
    assert len(rows) == 1 and rows[0].bench_price == bench[-1] and rows[0].price == bars[-1]["close"]  # second scan inside the throttle window
    rows[0].ts = rows[0].ts - timedelta(hours=SNAPSHOT_MIN_GAP_HOURS + 1)
    db.commit()
    evaluate_ohlcv(db, asset_class="crypto", symbol="SNAPUSDT", bars=bars, provider="binance_public", exchange="BINANCE", bench_closes=bench)
    assert db.query(AlphaCandidateSnapshot).filter_by(symbol="SNAPUSDT").count() == 2


def test_performance_route():
    from fastapi.testclient import TestClient
    from app.main import app
    r = TestClient(app).get("/api/alpha/performance/discovery", params={"horizon_days": 14})
    assert r.status_code == 200 and "claim" in r.json() and "limits" in r.json()
    assert TestClient(app).get("/api/alpha/performance/discovery", params={"horizon_days": 0}).status_code == 422
    assert TestClient(app).get("/api/alpha/performance/discovery", params={"asset_class": "forex"}).status_code == 422

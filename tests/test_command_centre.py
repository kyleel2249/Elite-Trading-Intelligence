"""Command-centre logic: performance maths, health score, crawler state, reports, pages and endpoints."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.command_centre import crawler, metrics
from app.main import app

NOW = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)


def _sell(day_offset: float, pnl: float, sym: str = "BTCUSDT", qty: float = 1.0, price: float = 100.0, fee: float = 0.1):
    ts = (NOW - timedelta(days=day_offset)).isoformat()
    return {"id": "f", "order_id": "o", "symbol": sym, "side": "sell", "qty": qty, "price": price, "fee": fee,
            "liquidity": "taker", "realized_pnl": pnl, "ts": ts}


# ---------- performance ----------
def test_performance_core_ratios():
    fills = [_sell(4, 10), _sell(3, -5), _sell(2, 20), _sell(1, -5)]
    p = metrics.performance(fills, 10_000, "ALL", NOW)
    assert p["trades"] == 4 and p["wins"] == 2 and p["losses"] == 2 and p["win_rate"] == 0.5
    assert p["profit_factor"] == pytest.approx(3.0) and p["expectancy"] == pytest.approx(5.0)
    assert p["net_realized_pnl"] == pytest.approx(20.0) and p["payoff_ratio"] == pytest.approx(15 / 5)
    assert p["max_drawdown_abs"] == pytest.approx(5.0)
    assert p["max_drawdown_pct"] == pytest.approx(5.0 / 10010 * 100)
    assert p["recovery_factor"] == pytest.approx(4.0)
    assert p["equity_curve"][-1]["equity"] == pytest.approx(10_020)


def test_performance_range_filters_and_rolling_windows():
    fills = [_sell(40, 100), _sell(5, 7), _sell(0.5, 3)]
    one_month = metrics.performance(fills, 10_000, "1M", NOW)
    assert one_month["trades"] == 2 and one_month["net_realized_pnl"] == pytest.approx(10)
    assert one_month["equity_curve"][0]["equity"] == pytest.approx(10_100)        # carries the pre-range gain
    assert one_month["rolling_pnl"]["daily"] == pytest.approx(3) and one_month["rolling_pnl"]["weekly"] == pytest.approx(10)
    with pytest.raises(ValueError):
        metrics.performance(fills, 10_000, "2Y", NOW)


def test_ratios_withheld_on_small_samples_and_no_trades():
    p = metrics.performance([_sell(1, 5)], 10_000, "ALL", NOW)
    assert p["sharpe"] is None and p["sortino"] is None and "need" in p["ratio_note"]
    empty = metrics.performance([], 10_000, "ALL", NOW)
    assert empty["win_rate"] is None and empty["profit_factor"] is None and empty["profit_factor_note"]
    assert empty["max_drawdown_pct"] == 0.0


def test_ratios_computed_with_enough_days():
    fills = [_sell(d, 5 if d % 3 else -2) for d in range(1, 41)]
    p = metrics.performance(fills, 10_000, "ALL", NOW)
    assert p["sharpe"] is not None and p["sortino"] is not None and p["ratio_note"] is None


def test_no_losses_has_no_profit_factor():
    p = metrics.performance([_sell(2, 4), _sell(1, 6)], 1_000, "ALL", NOW)
    assert p["profit_factor"] is None and "no losing" in p["profit_factor_note"] and p["max_drawdown_pct"] == 0.0


def test_average_holding_time_is_fifo_and_quantity_weighted():
    t0 = NOW - timedelta(days=1)
    fills = [
        {"side": "buy", "symbol": "X", "qty": 2.0, "ts": t0.isoformat()},
        {"side": "sell", "symbol": "X", "qty": 1.0, "ts": (t0 + timedelta(hours=1)).isoformat()},
        {"side": "sell", "symbol": "X", "qty": 1.0, "ts": (t0 + timedelta(hours=2)).isoformat()},
    ]
    assert metrics.average_holding_seconds(fills) == pytest.approx(5400.0)
    assert metrics.average_holding_seconds([]) is None


# ---------- health score ----------
def test_health_score_all_good_and_all_bad():
    good = metrics.health_score(drawdown_pct=0, exposure_pct=20, max_position_pct=10, daily_pnl_pct=0.5,
                                data_connected=True, jobs_total=8, jobs_errored=0)
    assert good["score"] == 100 and good["label"] == "Excellent" and good["risk_level"] == "Low" and good["readiness"] == "ready"
    bad = metrics.health_score(drawdown_pct=25, exposure_pct=100, max_position_pct=100, daily_pnl_pct=-5,
                               data_connected=False, jobs_total=8, jobs_errored=8)
    assert bad["score"] == 0 and bad["risk_level"] == "High" and bad["readiness"] == "not_ready"


def test_health_score_excludes_unmeasured_criteria_instead_of_assuming_good():
    h = metrics.health_score(drawdown_pct=10, data_connected=None)
    assert h["score"] == 50 and h["coverage"] == pytest.approx(30 / 100)
    none = metrics.health_score()
    assert none["score"] is None and none["risk_level"] is None and none["readiness"] == "unknown"
    assert metrics.health_score(drawdown_pct=0, halted=True)["readiness"] == "halted"


# ---------- reports ----------
def test_csv_neutralises_formula_injection():
    out = metrics.fills_csv([{"ts": "t", "symbol": "=cmd()", "side": "sell", "qty": 1, "price": 2, "fee": 0, "liquidity": "taker",
                              "realized_pnl": 1, "order_id": "o", "id": "f"}])
    assert "'=cmd()" in out and out.splitlines()[0].startswith("ts,symbol")


def test_markdown_report_states_its_data_source_and_limits():
    perf = metrics.performance([_sell(1, 5), _sell(2, -2)], 10_000, "1W", NOW)
    md = metrics.report_markdown("weekly", perf, {"equity": 10_003, "starting_cash": 10_000, "unrealized_pnl": 0, "positions": []},
                                 NOW, metrics.health_score(drawdown_pct=0))
    assert "INTERNAL PAPER" in md and "not investment advice" in md and "Profit factor" in md


# ---------- crawler state ----------
def _agents(**raw):
    return crawler.snapshot(raw, NOW)


def test_crawler_idle_when_nothing_runs_or_nothing_available():
    assert _agents()["state"] == "idle"
    assert _agents(mark_to_market={"running": False})["state"] == "idle"


def test_crawler_initialising_scanning_and_error():
    assert _agents(mark_to_market={"running": True})["state"] == "initialising"
    recent = (NOW - timedelta(seconds=30)).isoformat()
    s = _agents(mark_to_market={"running": True, "last_run": recent, "interval_seconds": 60})
    assert s["state"] == "scanning" and s["totals"]["running"] == 1 and s["last_successful_run"] == recent
    assert _agents(mark_to_market={"running": True, "last_run": recent}, reconcile={"running": True, "last_error": "boom"})["state"] == "error"


def test_crawler_stale_and_stream_connection():
    old = (NOW - timedelta(hours=5)).isoformat()
    s = _agents(mark_to_market={"running": True, "last_run": old, "interval_seconds": 60})
    assert s["state"] == "idle" and s["totals"]["stale"] == 1
    stream = _agents(market_stream={"binance": {"connected": True}, "alpaca": {"connected": False}})
    assert next(a for a in stream["agents"] if a["id"] == "market_stream")["running"] is True


def test_activity_log_contains_only_real_events():
    snap = _agents(mark_to_market={"running": True, "last_run": NOW.isoformat(), "last_result": {"marked": 3}})
    log = crawler.activity_log(snap["agents"], [{"retrieved_at": (NOW - timedelta(hours=1)).isoformat(), "category": "13F",
                                                  "ticker": "AAPL", "significance": "HIGH", "verification_status": "CONFIRMED"}])
    assert [r["agent"] for r in log] == ["Portfolio Valuation Agent", "Institutional Intelligence Agent"]
    assert "marked=3" in log[0]["result"] and log[1]["target"] == "AAPL"
    assert crawler.activity_log(_agents()["agents"], []) == []


# ---------- pages and endpoints ----------
client = TestClient(app)


def test_pages_are_served_with_brand_and_safety_labelling():
    for path, marker in (("/command", "Trading Command Centre"), ("/intelligence", "Intelligence Command Centre")):
        r = client.get(path)
        assert r.status_code == 200 and marker in r.text and "DISCOVER OPPORTUNITIES" in r.text and "/static/eti.css" in r.text


def test_static_design_system_assets_are_served():
    for path in ("/static/eti.css", "/static/eti.js", "/static/scenes.js"):
        assert client.get(path).status_code == 200, path


def test_performance_endpoint_shape_and_validation():
    r = client.get("/api/command/performance", params={"range": "1M"})
    assert r.status_code == 200
    j = r.json()
    assert {"summary", "performance", "health", "mode"} <= set(j) and j["mode"]["simulated"] is True
    assert j["performance"]["range"] == "1M" and "components" in j["health"]
    assert client.get("/api/command/performance", params={"range": "9Z"}).status_code == 422
    assert client.get("/api/command/performance", params={"account_id": "bad id!"}).status_code == 422


def test_crawler_endpoint_reports_real_agents_and_counts():
    j = client.get("/api/command/crawler").json()
    assert j["state"] in {"idle", "initialising", "scanning", "error"}
    assert len(j["agents"]) == len(crawler.AGENTS) and {"investor_activities", "alerts_total", "predictions_total"} <= set(j["counts"])
    assert isinstance(j["activity_log"], list)


def test_report_endpoint_formats():
    md = client.get("/api/command/report", params={"kind": "weekly"})
    assert md.status_code == 200 and md.text.startswith("# ETI Weekly Trading Report")
    csv_ = client.get("/api/command/report", params={"kind": "daily", "format": "csv"})
    assert csv_.status_code == 200 and csv_.headers["content-type"].startswith("text/csv") and csv_.text.startswith("ts,symbol")
    assert client.get("/api/command/report", params={"kind": "yearly"}).status_code == 422

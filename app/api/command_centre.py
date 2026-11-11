"""Command-centre pages and aggregate endpoints. Everything returned is computed from stored records or the real
status of background jobs; unavailable inputs are reported as unavailable, never filled in."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from starlette.requests import Request

from app import __version__
from app.command_centre import crawler as crawler_mod
from app.command_centre import metrics
from app.config import Settings, get_settings
from app.database import get_db
from app.models import IntelligenceAlert, InvestorActivity
from app.paper import wiring
from app.services.activity_store import ActivityStore

logger = logging.getLogger("eti.command_centre")
router = APIRouter(tags=["command-centre"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parents[1] / "templates"))
ID = r"^[A-Za-z0-9_.-]{1,64}$"


def _collect_statuses() -> dict[str, Any]:
    """Raw status of each background agent; None when it cannot be read."""
    out: dict[str, Any] = {}

    def grab(key: str, fn) -> None:
        try:
            out[key] = fn()
        except Exception:
            logger.warning("status for %s unavailable", key, exc_info=True)
            out[key] = None

    from app.jobs.execution_supervisor import execution_supervisor_job
    from app.jobs.investor_monitor import investor_monitor_job
    from app.jobs.mark_to_market import mtm_job
    from app.jobs.paper_autopilot import paper_job
    from app.jobs.reconcile import reconcile_job
    from app.prediction_ledger.job import prediction_resolver_job
    from app.streaming.manager import stream_hub

    grab("market_stream", stream_hub.status)
    grab("mark_to_market", mtm_job.status)
    grab("reconcile", reconcile_job.status)
    grab("investor_monitor", investor_monitor_job.status)
    grab("paper_engine", paper_job.status)
    grab("execution_supervisor", execution_supervisor_job.status)
    grab("prediction_resolver", prediction_resolver_job.status)

    def adaptive():
        from app.jobs.adaptive_edge_job import adaptive_edge_job
        return adaptive_edge_job.status()

    grab("adaptive_edge", adaptive)
    return out


def _page(request: Request, name: str):
    return templates.TemplateResponse(request, name, {"version": __version__})


@router.get("/command", response_class=HTMLResponse)
async def trading_command_centre(request: Request):
    return _page(request, "trading_centre.html")


@router.get("/intelligence", response_class=HTMLResponse)
async def intelligence_command_centre(request: Request):
    return _page(request, "intelligence_centre.html")


def _mode(settings: Settings) -> dict[str, Any]:
    return {"data_source": "INTERNAL PAPER (simulated)", "simulated": True,
            "live_trading_enabled": settings.live_trading_enabled, "execution_enabled": settings.execution_enabled,
            "kill_switch": settings.kill_switch}


async def _account_view(account_id: str, range_key: str, settings: Settings) -> dict[str, Any]:
    key = range_key.upper()
    if key not in metrics.RANGE_DAYS:
        raise HTTPException(status_code=422, detail=f"range must be one of {', '.join(metrics.RANGE_DAYS)}")
    svc = wiring.get_paper_service()
    summary = await svc.summary(account_id)
    fills = svc.fills(account_id, 100000)
    now = datetime.now(timezone.utc)
    perf = metrics.performance(fills, summary["starting_cash"], key, now)
    full = perf if key == "ALL" else metrics.performance(fills, summary["starting_cash"], "ALL", now)
    today = perf if key == "1D" else metrics.performance(fills, summary["starting_cash"], "1D", now)
    snap = crawler_mod.snapshot(_collect_statuses(), now)
    eq = summary["equity"]
    positions = summary.get("positions") or []
    stream = _collect_statuses().get("market_stream") if False else None  # stream state is part of `snap`
    stream_agent = next((a for a in snap["agents"] if a["id"] == "market_stream"), None)
    health = metrics.health_score(
        drawdown_pct=full["max_drawdown_pct"] if full["trades"] else None,
        exposure_pct=(summary["market_value"] / eq * 100.0) if eq > 0 else None,
        max_position_pct=(max((p["market_value"] for p in positions), default=0.0) / eq * 100.0) if eq > 0 else None,
        daily_pnl_pct=(today["net_realized_pnl"] / summary["starting_cash"] * 100.0) if summary["starting_cash"] > 0 else None,
        data_connected=None if stream_agent is None or stream_agent["health"] == "unavailable" else bool(stream_agent["running"]),
        jobs_total=snap["totals"]["available"], jobs_errored=snap["totals"]["errored"],
        halted=bool(summary.get("halted")))
    del stream
    return {"account_id": account_id, "range": key, "summary": summary, "performance": perf, "health": health,
            "mode": _mode(settings), "generated_at": now.isoformat()}


@router.get("/api/command/performance")
async def command_performance(account_id: str = Query("default", pattern=ID), range: str = Query("ALL", max_length=3),
                              settings: Settings = Depends(get_settings)):
    return await _account_view(account_id, range, settings)


@router.get("/api/command/crawler")
async def command_crawler(db: Session = Depends(get_db)):
    from app.prediction_ledger.queries import list_page

    now = datetime.now(timezone.utc)
    snap = crawler_mod.snapshot(_collect_statuses(), now)
    acts = ActivityStore(db).list_activities(limit=30)
    snap["counts"] = {
        "investor_activities": db.query(InvestorActivity).count(),
        "alerts_total": db.query(IntelligenceAlert).count(),
        "alerts_unacknowledged": db.query(IntelligenceAlert).filter(IntelligenceAlert.acknowledged.is_(False)).count(),
        "predictions_total": list_page(db, limit=1)[0],
        "predictions_pending": list_page(db, status="pending", limit=1)[0],
    }
    snap["activity_log"] = crawler_mod.activity_log(snap["agents"], acts)
    return snap


@router.get("/api/command/report")
async def command_report(kind: Literal["daily", "weekly", "monthly"] = "daily", format: Literal["md", "csv", "json"] = "md",
                         account_id: str = Query("default", pattern=ID), settings: Settings = Depends(get_settings)):
    range_key = {"daily": "1D", "weekly": "1W", "monthly": "1M"}[kind]
    view = await _account_view(account_id, range_key, settings)
    if format == "json":
        return view
    if format == "csv":
        cut = datetime.now(timezone.utc) - __import__("datetime").timedelta(days=metrics.RANGE_DAYS[range_key])
        rows = [f for f in wiring.get_paper_service().fills(account_id, 100000)
                if (metrics.parse_ts(f.get("ts")) or cut) >= cut]
        return Response(content=metrics.fills_csv(rows), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="eti-{kind}-fills.csv"'})
    md = metrics.report_markdown(kind, view["performance"], view["summary"], datetime.now(timezone.utc), view["health"])
    return PlainTextResponse(md, media_type="text/markdown")

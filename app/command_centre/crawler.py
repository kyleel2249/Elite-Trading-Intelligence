"""Crawler/agent state derived from the real status of ETI's background jobs. Pure functions.

Nothing here invents activity: an agent that is not running reports as stopped, an agent that has never run reports
as starting, and the overall crawler state is computed from those facts.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.command_centre.metrics import parse_ts

AGENTS = (
    ("market_stream", "Market Stream Agent", "Maintains live Binance/Alpaca quote streams"),
    ("mark_to_market", "Portfolio Valuation Agent", "Marks open positions to market"),
    ("reconcile", "Execution Reconciliation Agent", "Reconciles recorded orders with the venue"),
    ("investor_monitor", "Institutional Intelligence Agent", "Scans SEC EDGAR / Quiver disclosures and raises alerts"),
    ("paper_engine", "Paper Engine Agent", "Advances resting paper orders against live books"),
    ("execution_supervisor", "Execution Supervisor Agent", "Supervises testnet/live execution accounts"),
    ("prediction_resolver", "Prediction Accountability Agent", "Scores matured predictions and publishes monthly reports"),
    ("adaptive_edge", "Adaptive Edge Agent", "Regime-aware strategy research cycle"),
)
LABELS = {a[0]: a[1] for a in AGENTS}


def _as_dt(v: Any) -> Optional[datetime]:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        try:
            return datetime.fromtimestamp(float(v), timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return parse_ts(v)


def _scalar_summary(d: Any, limit: int = 4) -> str:
    if not isinstance(d, dict):
        return ""
    items = [f"{k}={v}" for k, v in d.items() if isinstance(v, (str, int, float, bool)) and not isinstance(v, bool) or isinstance(v, bool)]
    return ", ".join(items[:limit])


def normalize(agent_id: str, raw: Any, now: datetime) -> dict[str, Any]:
    label = LABELS.get(agent_id, agent_id)
    resp = next((a[2] for a in AGENTS if a[0] == agent_id), "")
    base = {"id": agent_id, "label": label, "responsibility": resp, "running": False, "last_run": None,
            "age_seconds": None, "interval_seconds": None, "last_error": None, "last_result": "", "health": "unavailable"}
    if not isinstance(raw, dict):
        return base
    if agent_id == "market_stream":
        kids = [v for v in raw.values() if isinstance(v, dict) and "connected" in v]
        running = any(bool(k.get("connected")) for k in kids)
        last = None
    else:
        running = bool(raw.get("running", raw.get("active", False)))
        last = _as_dt(raw.get("last_run") or raw.get("last_run_at") or raw.get("last_scan") or raw.get("last_success"))
    err = raw.get("last_error") or raw.get("error")
    interval = raw.get("interval_seconds") or raw.get("interval")
    interval = float(interval) if isinstance(interval, (int, float)) and not isinstance(interval, bool) and interval > 0 else None
    age = (now - last).total_seconds() if last else None
    if err:
        health = "error"
    elif not running:
        health = "stopped"
    elif agent_id != "market_stream" and last is None:
        health = "starting"
    elif age is not None and interval and age > max(3 * interval, 600):
        health = "stale"
    else:
        health = "healthy"
    base.update(running=running, last_run=last.isoformat() if last else None, age_seconds=age,
                interval_seconds=interval, last_error=str(err)[:200] if err else None,
                last_result=_scalar_summary(raw.get("last_result")), health=health)
    return base


def crawler_state(agents: list[dict[str, Any]]) -> str:
    """error | initialising | scanning | idle. 'scanning' only when a running agent completed a cycle recently."""
    avail = [a for a in agents if a["health"] != "unavailable"]
    if any(a["health"] == "error" for a in avail):
        return "error"
    running = [a for a in avail if a["running"]]
    if not running:
        return "idle"
    if all(a["health"] == "starting" for a in running):
        return "initialising"
    for a in running:
        if a["age_seconds"] is not None and a["age_seconds"] <= max(120.0, 1.5 * (a["interval_seconds"] or 0.0)):
            return "scanning"
    return "idle"


def snapshot(raw_by_id: dict[str, Any], now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    agents = [normalize(a[0], raw_by_id.get(a[0]), now) for a in AGENTS]
    avail = [a for a in agents if a["health"] != "unavailable"]
    good = [a for a in avail if a["health"] == "healthy" and a["last_run"]]
    return {
        "state": crawler_state(agents), "agents": agents,
        "totals": {"agents": len(agents), "available": len(avail), "running": sum(1 for a in avail if a["running"]),
                   "errored": sum(1 for a in avail if a["health"] == "error"),
                   "stale": sum(1 for a in avail if a["health"] == "stale")},
        "last_successful_run": max((a["last_run"] for a in good), default=None),
        "generated_at": now.isoformat(),
    }


def activity_log(agents: list[dict[str, Any]], activities: list[dict[str, Any]], limit: int = 50) -> list[dict[str, Any]]:
    """Real events only: agent cycles (from job status) and stored institutional activities."""
    rows = []
    for a in agents:
        if a["last_run"]:
            rows.append({"ts": a["last_run"], "agent": a["label"], "activity": "Cycle completed" if a["health"] != "error" else "Cycle failed",
                         "target": a["id"], "result": a["last_result"] or a["last_error"] or "", "status": a["health"], "duration": None})
        elif a["last_error"]:
            rows.append({"ts": None, "agent": a["label"], "activity": "Error", "target": a["id"], "result": a["last_error"],
                         "status": "error", "duration": None})
    for x in activities:
        rows.append({"ts": x.get("retrieved_at") or x.get("created_at"), "agent": "Institutional Intelligence Agent",
                     "activity": f"{x.get('category') or 'activity'} {x.get('direction') or ''}".strip(),
                     "target": x.get("ticker") or x.get("institution") or x.get("investor_name") or "",
                     "result": f"{x.get('significance') or ''} / {x.get('verification_status') or ''}".strip(" /"),
                     "status": "recorded", "duration": None})
    rows.sort(key=lambda r: r["ts"] or "", reverse=True)
    return rows[:limit]

"""Monthly performance reports. Published reports are immutable (one per YYYY-MM)."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.prediction_ledger.evaluation import breakdowns, compute_metrics
from app.prediction_ledger.models import PredictionRecord, PredictionReport
from app.prediction_ledger.service import iso, naive_utc, scored_rows

PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def period_bounds(period: str) -> tuple[datetime, datetime]:
    if not PERIOD_RE.match(period):
        raise ValueError("period must be YYYY-MM")
    y, m = int(period[:4]), int(period[5:])
    return datetime(y, m, 1), (datetime(y + 1, 1, 1) if m == 12 else datetime(y, m + 1, 1))


def previous_period(now: Optional[datetime] = None) -> str:
    now = naive_utc(now)
    y, m = (now.year - 1, 12) if now.month == 1 else (now.year, now.month - 1)
    return f"{y:04d}-{m:02d}"


def _pct(x: Optional[float]) -> str:
    return "n/a" if x is None else f"{x * 100:.1f}%"


def _num(x: Optional[float], d: int = 4) -> str:
    return "n/a" if x is None else f"{x:.{d}f}"


def build_summary(db: Session, period: str) -> dict[str, Any]:
    start, end = period_bounds(period)
    rows = scored_rows(db, start=start, end=end, include_pending=True)
    created = db.execute(select(PredictionRecord).where(PredictionRecord.created_at >= start, PredictionRecord.created_at < end)).scalars().all()
    resolved = [r for r in rows if r["status"] != "pending"]
    return {
        "period": period, "predictions_created": len(created), "predictions_due": len(rows),
        "still_pending_at_generation": sum(1 for r in rows if r["status"] == "pending"),
        "overall": compute_metrics(resolved), **breakdowns(resolved),
        "methodology": {
            "scope": "Predictions whose horizon expired inside the period. Failed predictions are never excluded.",
            "directional_accuracy": "up: price > entry; down: price < entry; neutral: |return| <= 0.5%.",
            "late_outcomes": "Outcomes recorded after 10% of horizon (min 5 min) are stored but excluded from accuracy.",
            "calibration": "Brier score and expected calibration error over stated probabilities.",
            "realized_price": "Price observed when the evaluator ran; invalidation is checked at that price only.",
        },
    }


def render_markdown(s: dict[str, Any]) -> str:
    o = s["overall"]
    L = [f"# ETI Prediction Performance Report — {s['period']}", "",
         f"- Predictions created: {s['predictions_created']}",
         f"- Predictions due in period: {s['predictions_due']} (pending at generation: {s['still_pending_at_generation']})",
         f"- Scored: {o['n_scored']} · late/excluded: {o['n_late_excluded']} · invalidated: {o['n_invalidated']}", "",
         "## Overall", "",
         f"- Directional accuracy: {_pct(o['directional_accuracy'])}",
         f"- Target-range hit rate: {_pct(o['target_range_hit_rate'])} (n={o['n_with_targets']})",
         f"- Mean absolute % error: {_pct(o['mean_abs_pct_error'])}",
         f"- Brier score: {_num(o['brier_score'])} (skill vs coin-flip: {_num(o['brier_skill_vs_coinflip'])})",
         f"- Expected calibration error: {_num(o['expected_calibration_error'])}",
         f"- Mean stated probability vs accuracy gap: {_num(o['calibration_gap'])}"]
    if o.get("warning"):
        L += ["", f"> **Warning:** {o['warning']}"]
    for title, key in (("Asset", "by_asset"), ("Timeframe", "by_timeframe"), ("Market regime", "by_regime"), ("Strategy", "by_strategy")):
        L += ["", f"## By {title}", "", "| Group | N | Direction | Target hit | MAPE | Brier |", "|---|---|---|---|---|---|"]
        for k, m in s[key].items():
            L.append(f"| {k} | {m['n_scored']} | {_pct(m['directional_accuracy'])} | {_pct(m['target_range_hit_rate'])} | {_pct(m['mean_abs_pct_error'])} | {_num(m['brier_score'])} |")
    L += ["", "## Methodology", ""] + [f"- **{k}**: {v}" for k, v in s["methodology"].items()]
    L += ["", "_Probabilistic research output; not investment advice. Historical forecasts are never rewritten._"]
    return "\n".join(L)


def get_report(db: Session, period: str) -> Optional[PredictionReport]:
    return db.execute(select(PredictionReport).where(PredictionReport.period == period)).scalar_one_or_none()


def publish_report(db: Session, period: str, now: Optional[datetime] = None) -> tuple[PredictionReport, bool]:
    """Publish once, only after the month has ended. Returns (report, created)."""
    existing = get_report(db, period)
    if existing:
        return existing, False
    _, end = period_bounds(period)
    if naive_utc(now) < end:
        raise ValueError("period has not ended; use preview instead")
    summary = build_summary(db, period)
    md = render_markdown(summary)
    rep = PredictionReport(period=period, summary=summary, markdown=md,
                           content_hash=hashlib.sha256(json.dumps(summary, sort_keys=True, default=str).encode()).hexdigest())
    db.add(rep)
    db.commit()
    db.refresh(rep)
    return rep, True


def report_to_dict(r: PredictionReport, full: bool = True) -> dict[str, Any]:
    d = {"period": r.period, "generated_at": iso(r.generated_at), "content_hash": r.content_hash}
    if full:
        d.update(summary=r.summary, markdown=r.markdown)
    return d

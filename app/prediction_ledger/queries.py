"""SQL-level queries for the ledger: paginated listing and report scheduling."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.prediction_ledger.models import PredictionOutcome, PredictionRecord
from app.prediction_ledger.reports import get_report, period_bounds
from app.prediction_ledger.service import naive_utc, outcome_to_dict, prediction_to_dict

_JOIN = PredictionOutcome.prediction_id == PredictionRecord.id


def _conditions(asset: Optional[str], status: Optional[str]) -> list:
    conds = []
    if asset:
        conds.append(PredictionRecord.asset == asset.upper())
    if status == "pending":
        conds.append(PredictionOutcome.id.is_(None))
    elif status:
        conds.append(PredictionOutcome.status == status)
    return conds


def list_page(db: Session, *, asset: Optional[str] = None, status: Optional[str] = None,
              limit: int = 50, offset: int = 0) -> tuple[int, list[dict[str, Any]]]:
    """Newest-first page of predictions (with outcomes) using SQL filtering/pagination."""
    conds = _conditions(asset, status)
    count_q = select(func.count(PredictionRecord.id)).select_from(PredictionRecord).outerjoin(PredictionOutcome, _JOIN)
    page_q = select(PredictionRecord, PredictionOutcome).outerjoin(PredictionOutcome, _JOIN)
    for c in conds:
        count_q = count_q.where(c)
        page_q = page_q.where(c)
    total = db.execute(count_q).scalar_one()
    page_q = page_q.order_by(PredictionRecord.created_at.desc(), PredictionRecord.id.desc()).limit(limit).offset(offset)
    rows: list[dict[str, Any]] = []
    for p, o in db.execute(page_q).all():
        d = prediction_to_dict(p)
        d["status"] = o.status if o else "pending"
        if o:
            d.update({k: v for k, v in outcome_to_dict(o).items() if k != "status"})
        rows.append(d)
    return total, rows


def _month_counts(db: Session, start: datetime, end: datetime, now: datetime) -> tuple[int, int]:
    """(predictions due in [start,end), of which still unresolved)."""
    base = select(func.count(PredictionRecord.id)).select_from(PredictionRecord).where(
        PredictionRecord.expires_at >= start, PredictionRecord.expires_at < end)
    due = db.execute(base).scalar_one()
    pending = db.execute(
        base.outerjoin(PredictionOutcome, _JOIN).where(PredictionOutcome.id.is_(None), PredictionRecord.expires_at <= now)
    ).scalar_one()
    return due, pending


def due_report_periods(db: Session, now: Optional[datetime] = None, grace_days: int = 7) -> list[str]:
    """Completed months that still need a published report, oldest first.

    A month qualifies when it has predictions due in it, no report yet, and either every due prediction has an
    outcome or `grace_days` have passed since month end (so a long evaluator outage cannot block a report forever,
    and a report is not frozen while results are still outstanding).
    """
    now = naive_utc(now)
    first = db.execute(select(func.min(PredictionRecord.expires_at))).scalar()
    if first is None:
        return []
    out: list[str] = []
    y, m = first.year, first.month
    while (y, m) < (now.year, now.month):
        period = f"{y:04d}-{m:02d}"
        if get_report(db, period) is None:
            start, end = period_bounds(period)
            due, pending = _month_counts(db, start, end, now)
            if due and (pending == 0 or now >= end + timedelta(days=grace_days)):
                out.append(period)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out

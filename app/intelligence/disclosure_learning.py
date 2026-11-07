"""
Disclosure delay-aware learning scaffold.
Uses publication_date as information-availability time — never transaction date alone.
Does not claim causality or profitability.
"""
from __future__ import annotations

from typing import Any, Optional, Sequence

from sqlalchemy.orm import Session

from app.models import DisclosureOutcome, InvestorActivity


HORIZONS = (1, 5, 20, 60, 90, 180)


def compute_forward_return(closes: Sequence[float], start_idx: int, horizon: int) -> Optional[float]:
    if start_idx < 0 or start_idx >= len(closes):
        return None
    end = start_idx + horizon
    if end >= len(closes):
        return None
    a, b = closes[start_idx], closes[end]
    if a is None or b is None or a == 0:
        return None
    return (b / a - 1.0) * 100.0


def record_outcomes_for_activity(
    db: Session,
    activity_id: str,
    ticker: str,
    publication_date: Optional[str],
    closes: Sequence[float],
    pub_index: int,
) -> list[dict[str, Any]]:
    """Store scaffold outcomes at fixed horizons from publication bar index."""
    out = []
    for h in HORIZONS:
        ret = compute_forward_return(closes, pub_index, h)
        row = DisclosureOutcome(
            activity_id=activity_id,
            ticker=ticker.upper(),
            publication_date=publication_date,
            horizon_days=h,
            return_pct=ret,
            notes="Scaffold only — not causal; account for confounders before claims",
        )
        db.add(row)
        out.append({"horizon_days": h, "return_pct": ret})
    db.commit()
    return out


def summary_by_category(db: Session, limit: int = 500) -> dict[str, Any]:
    rows = db.query(DisclosureOutcome).order_by(DisclosureOutcome.created_at.desc()).limit(limit).all()
    if not rows:
        return {
            "n": 0,
            "message": "No disclosure outcomes recorded yet",
            "disclaimer": "No profitability claim",
        }
    by_h: dict[int, list[float]] = {}
    for r in rows:
        if r.return_pct is not None:
            by_h.setdefault(r.horizon_days, []).append(r.return_pct)
    stats = {}
    for h, vals in by_h.items():
        stats[h] = {
            "n": len(vals),
            "mean_return_pct": round(sum(vals) / len(vals), 4) if vals else None,
        }
    return {
        "n": len(rows),
        "by_horizon": stats,
        "disclaimer": "Descriptive scaffold only — not proof of alpha; Claire Bennett / Lars Hagen review",
    }


def activities_pending_study(db: Session, limit: int = 20) -> list[dict[str, Any]]:
    rows = (
        db.query(InvestorActivity)
        .filter(InvestorActivity.ticker.isnot(None))
        .order_by(InvestorActivity.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "activity_id": r.activity_id,
            "ticker": r.ticker,
            "publication_date": r.publication_date or r.filing_or_report_date,
            "category": r.category,
            "note": "Use publication_date as T0 for any study",
        }
        for r in rows
    ]

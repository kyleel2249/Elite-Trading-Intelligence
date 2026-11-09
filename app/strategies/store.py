"""Persistence for validation runs. Results are only ever stored from real runs; nothing is pre-populated."""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.database import Base


class StrategyValidationRecord(Base):
    __tablename__ = "strategy_validation_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(64), index=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    interval: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(32))
    grade: Mapped[str] = mapped_column(String(48), index=True)
    bars: Mapped[int] = mapped_column(Integer)
    params: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    report: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), index=True)


def clean_json(obj: Any) -> Any:
    """Replace NaN/inf (invalid in strict JSON and PostgreSQL) with None, recursively."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {str(k): clean_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_json(v) for v in obj]
    return obj


def save_report(db: Session, report: dict[str, Any], *, symbol: str, provider: str, interval: str) -> StrategyValidationRecord:
    rep = clean_json(report)
    rec = StrategyValidationRecord(
        strategy_id=rep["strategy_id"], symbol=symbol.upper(), provider=provider, interval=interval, status=rep.get("status", "unknown"),
        grade=(rep.get("verdict") or {}).get("grade", "unknown"), bars=(rep.get("data") or {}).get("bars", 0),
        params=(rep.get("backtest") or {}).get("params"), report=rep)
    db.add(rec); db.commit(); db.refresh(rec)
    return rec


def latest_report(db: Session, strategy_id: str, symbol: Optional[str] = None, interval: Optional[str] = None) -> Optional[StrategyValidationRecord]:
    q = db.query(StrategyValidationRecord).filter(StrategyValidationRecord.strategy_id == strategy_id)
    if symbol: q = q.filter(StrategyValidationRecord.symbol == symbol.upper())
    if interval: q = q.filter(StrategyValidationRecord.interval == interval)
    return q.order_by(StrategyValidationRecord.created_at.desc(), StrategyValidationRecord.id.desc()).first()


def latest_grades(db: Session) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    rows = db.query(StrategyValidationRecord).order_by(StrategyValidationRecord.created_at.desc(), StrategyValidationRecord.id.desc()).limit(2000).all()
    for r in rows:
        out.setdefault(r.strategy_id, {"grade": r.grade, "status": r.status, "symbol": r.symbol, "interval": r.interval, "bars": r.bars,
                                       "validated_at": r.created_at.isoformat() if r.created_at else None})
    return out


def summary(rec: Optional[StrategyValidationRecord]) -> Optional[dict[str, Any]]:
    if rec is None: return None
    return {"id": rec.id, "grade": rec.grade, "status": rec.status, "symbol": rec.symbol, "interval": rec.interval, "bars": rec.bars,
            "validated_at": rec.created_at.isoformat() if rec.created_at else None}

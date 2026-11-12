"""Lessons learned + research/monitoring priorities.

Lessons are *aggregates*: a lesson only changes status after enough closed trades, so one
win or one loss can never rewrite what the system believes.
"""
from __future__ import annotations

import math
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.memory.models import MemoryLesson, ResearchPriority
from app.memory.util import append_unique, utcnow, wilson_interval

MIN_FOR_STATUS = 5
ESTABLISHED_N = 20


def lesson_status(supporting: int, total: int) -> str:
    if total < MIN_FOR_STATUS:
        return "observation"
    rate = supporting / total
    if rate >= 0.7:
        return "established" if total >= ESTABLISHED_N else "supported"
    if rate <= 0.3:
        return "contradicted"
    return "mixed"


def render_lesson_text(category: str, strategy_id: Optional[str], subject: Optional[str], s: int, n: int, context: dict[str, Any]) -> str:
    if category == "assumption":
        return (
            f"[{strategy_id}] assumption '{subject}' held in {s} of {n} closed trades "
            f"(regime at entry: {context.get('regime', 'unknown')})."
        )
    if category == "execution":
        return f"[{subject}] entry slippage stayed within {context.get('alert_bps')} bps in {s} of {n} closed trades."
    if category == "regime":
        return (
            f"[{strategy_id}] closed profitable after costs in {s} of {n} trades entered in regime "
            f"'{context.get('regime', 'unknown')}'."
        )
    return f"{subject}: supported in {s} of {n} observations."


class LessonService:
    def __init__(self, db: Session):
        self.db = db

    def observe(
        self,
        *,
        lesson_key: str,
        category: str,
        strategy_id: Optional[str],
        subject: Optional[str],
        supports: bool,
        trade_id: str,
        context: Optional[dict[str, Any]] = None,
    ) -> MemoryLesson:
        """Record one observation (flushed, not committed - the caller commits atomically)."""
        row = self.db.query(MemoryLesson).filter(MemoryLesson.lesson_key == lesson_key).one_or_none()
        ctx = dict(context or {})
        if row is None:
            row = MemoryLesson(
                lesson_key=lesson_key[:160],
                strategy_id=strategy_id,
                category=category,
                subject=(subject or "")[:128],
                supporting_count=0,
                contradicting_count=0,
                trade_ids=[],
                context={},
                first_seen=utcnow(),
            )
            self.db.add(row)
        if supports:
            row.supporting_count = (row.supporting_count or 0) + 1
        else:
            row.contradicting_count = (row.contradicting_count or 0) + 1
        s, c = row.supporting_count, row.contradicting_count
        n = s + c
        row.text = render_lesson_text(category, strategy_id, subject, s, n, ctx)
        row.status = lesson_status(s, n)
        ci = wilson_interval(s, n)
        row.confidence = round(ci[0], 4) if ci else 0.0
        row.trade_ids = append_unique(row.trade_ids, trade_id, keep_last=25)
        row.context = {**(row.context or {}), **ctx}
        row.last_seen = utcnow()
        self.db.flush()
        return row

    def list(
        self,
        *,
        strategy_id: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100,
    ) -> list[MemoryLesson]:
        q = self.db.query(MemoryLesson)
        if strategy_id:
            q = q.filter(MemoryLesson.strategy_id == strategy_id)
        if category:
            q = q.filter(MemoryLesson.category == category)
        if status:
            q = q.filter(MemoryLesson.status == status)
        return q.order_by(MemoryLesson.last_seen.desc()).limit(max(1, min(limit, 500))).all()


def _score(weight: float) -> float:
    return round(1.0 - math.exp(-0.3 * max(weight, 0.0)), 4)


class PriorityService:
    """Saturating evidence-weighted priority queue (score in [0,1))."""

    def __init__(self, db: Session):
        self.db = db

    def bump(
        self,
        topic_key: str,
        kind: str,
        title: str,
        *,
        delta: float,
        strategy_id: Optional[str] = None,
        rationale: Optional[dict[str, Any]] = None,
        trade_id: Optional[str] = None,
        create: bool = True,
    ) -> Optional[ResearchPriority]:
        row = self.db.query(ResearchPriority).filter(ResearchPriority.topic_key == topic_key).one_or_none()
        if row is None:
            if not create or delta <= 0:
                return None
            row = ResearchPriority(
                topic_key=topic_key[:160], kind=kind, strategy_id=strategy_id, title=title[:256],
                weight=0.0, score=0.0, evidence_count=0, status="open", created_at=utcnow(),
            )
            self.db.add(row)
        row.weight = max(0.0, (row.weight or 0.0) + delta)
        if delta > 0:
            row.evidence_count = (row.evidence_count or 0) + 1
        row.score = _score(row.weight)
        row.status = "open" if row.weight > 0.05 else "resolved"
        if rationale:
            row.rationale = {**(row.rationale or {}), **rationale}
        if trade_id:
            row.last_trade_id = trade_id
        row.updated_at = utcnow()
        self.db.flush()
        return row

    def upsert_absolute(
        self,
        topic_key: str,
        kind: str,
        title: str,
        score: float,
        *,
        strategy_id: Optional[str] = None,
        rationale: Optional[dict[str, Any]] = None,
    ) -> ResearchPriority:
        score = min(max(score, 0.0), 0.99)
        weight = -math.log(1.0 - score) / 0.3 if score > 0 else 0.0
        row = self.db.query(ResearchPriority).filter(ResearchPriority.topic_key == topic_key).one_or_none()
        if row is None:
            row = ResearchPriority(
                topic_key=topic_key[:160], kind=kind, strategy_id=strategy_id, title=title[:256],
                evidence_count=0, created_at=utcnow(),
            )
            self.db.add(row)
        row.weight = weight
        row.score = round(score, 4)
        row.status = "open" if score > 0.0 else "resolved"
        row.rationale = {**(row.rationale or {}), **(rationale or {})}
        row.updated_at = utcnow()
        self.db.flush()
        return row

    def list(self, kind: Optional[str] = None, status: Optional[str] = "open", limit: int = 50) -> list[ResearchPriority]:
        q = self.db.query(ResearchPriority)
        if kind:
            q = q.filter(ResearchPriority.kind == kind)
        if status:
            q = q.filter(ResearchPriority.status == status)
        return q.order_by(ResearchPriority.score.desc()).limit(max(1, min(limit, 200))).all()

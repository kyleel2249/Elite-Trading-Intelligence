"""Permanent Market Intelligence Knowledge Base — learn from successes and failures."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional
from sqlalchemy.orm import Session


@dataclass
class KnowledgeRecord:
    record_type: str
    ref_id: str
    payload: dict[str, Any]
    tags: list[str] = field(default_factory=list)
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AdaptiveKnowledgeBase:
    """
    Persist adaptive-edge events via SQLAlchemy models (AdaptiveEdgeEvent).
    Failed strategies are first-class knowledge.

    The model lives in app.memory.models (the table is created by migration 0003 and by
    ``init_db``); it is imported lazily so this module stays import-light.
    """

    def __init__(self, db: Session):
        self.db = db

    def record(
        self,
        record_type: str,
        ref_id: str,
        payload: dict[str, Any],
        tags: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        from app.memory.models import AdaptiveEdgeEvent

        ts = datetime.now(timezone.utc)
        row = AdaptiveEdgeEvent(
            event_type=record_type,
            ref_id=ref_id,
            payload=payload,
            tags=tags or [],
            created_at=ts,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return {
            "id": row.id,
            "event_type": row.event_type,
            "ref_id": row.ref_id,
            "payload": row.payload,
            "tags": row.tags,
            "created_at": row.created_at.isoformat() if row.created_at else ts.isoformat(),
        }

    def list_events(
        self,
        event_type: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        from app.memory.models import AdaptiveEdgeEvent

        q = self.db.query(AdaptiveEdgeEvent).order_by(AdaptiveEdgeEvent.created_at.desc(), AdaptiveEdgeEvent.id.desc())
        if event_type:
            q = q.filter(AdaptiveEdgeEvent.event_type == event_type)
        rows = q.limit(limit).all()
        return [
            {
                "id": r.id,
                "event_type": r.event_type,
                "ref_id": r.ref_id,
                "payload": r.payload or {},
                "tags": r.tags or [],
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]

    def failed_strategies(self, limit: int = 20) -> list[dict[str, Any]]:
        return self.list_events(event_type="strategy_rejected", limit=limit) + self.list_events(
            event_type="strategy_suspended", limit=limit
        )

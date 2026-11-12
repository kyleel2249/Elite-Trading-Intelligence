"""Generic versioned memory store + overview across every memory domain."""
from __future__ import annotations

import re
import uuid
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.memory.models import (
    MemoryBacktest,
    MemoryEntry,
    MemoryLesson,
    MemorySignal,
    MemoryTrade,
    RegimeObservation,
    ResearchPriority,
    StrategyVersion,
)
from app.memory.util import sha256_json

# Versioned documents: a changed document becomes version N+1 and the old one is 'superseded'.
DOCUMENT_KINDS = frozenset({"trader_profile", "methodology", "user_preference", "risk_limit"})
# Append-only events: each record is its own key, version 1.
EVENT_KINDS = frozenset({"market_observation", "strategy_failure"})
ALL_KINDS = DOCUMENT_KINDS | EVENT_KINDS

_KEY_RE = re.compile(r"^[A-Za-z0-9._:/@+\-]{1,128}$")


def normalize_key(key: str) -> str:
    k = re.sub(r"\s+", "_", (key or "").strip())
    if not _KEY_RE.match(k):
        raise ValueError("key must be 1-128 chars of letters, digits and . _ : / @ + -")
    return k


class MemoryStore:
    def __init__(self, db: Session):
        self.db = db

    # -- writes -------------------------------------------------------------------------------
    def put_document(
        self,
        kind: str,
        key: str,
        content: dict[str, Any],
        *,
        title: Optional[str] = None,
        tags: Optional[list[str]] = None,
        source: str = "user",
    ) -> tuple[MemoryEntry, bool]:
        """Create the document or a new version of it. Returns (row, created_new_version).
        Re-saving identical content is a no-op, so history only records real changes."""
        if kind not in DOCUMENT_KINDS:
            raise ValueError(f"kind must be one of {sorted(DOCUMENT_KINDS)} for documents")
        if not isinstance(content, dict):
            raise ValueError("content must be an object")
        key = normalize_key(key)
        digest = sha256_json(content)
        latest = self._latest(kind, key)
        if latest is not None and latest.content_sha256 == digest:
            return latest, False
        row = MemoryEntry(
            kind=kind,
            key=key,
            version=(latest.version + 1) if latest else 1,
            status="active",
            title=title if title is not None else (latest.title if latest else None),
            content=content,
            tags=list(tags) if tags is not None else list(latest.tags or []) if latest else [],
            source=source,
            content_sha256=digest,
            supersedes_id=latest.id if latest else None,
        )
        if latest is not None:
            latest.status = "superseded"
        self.db.add(row)
        try:
            self.db.commit()
        except IntegrityError:  # concurrent writer created the same version
            self.db.rollback()
            existing = self._latest(kind, key)
            if existing is None:
                raise
            return existing, False
        self.db.refresh(row)
        return row, True

    def add_event(
        self,
        kind: str,
        content: dict[str, Any],
        *,
        key: Optional[str] = None,
        title: Optional[str] = None,
        tags: Optional[list[str]] = None,
        source: str = "user",
        commit: bool = True,
    ) -> MemoryEntry:
        if kind not in EVENT_KINDS:
            raise ValueError(f"kind must be one of {sorted(EVENT_KINDS)} for events")
        if not isinstance(content, dict):
            raise ValueError("content must be an object")
        row = MemoryEntry(
            kind=kind,
            key=normalize_key(key) if key else f"{kind}:{uuid.uuid4().hex[:16]}",
            version=1,
            status="active",
            title=title,
            content=content,
            tags=list(tags or []),
            source=source,
            content_sha256=sha256_json(content),
        )
        self.db.add(row)
        if commit:
            self.db.commit()
            self.db.refresh(row)
        else:
            self.db.flush()
        return row

    # -- reads --------------------------------------------------------------------------------
    def _latest(self, kind: str, key: str) -> Optional[MemoryEntry]:
        return (
            self.db.query(MemoryEntry)
            .filter(MemoryEntry.kind == kind, MemoryEntry.key == key)
            .order_by(MemoryEntry.version.desc())
            .first()
        )

    def get(self, kind: str, key: str, version: Optional[int] = None) -> Optional[MemoryEntry]:
        if version is None:
            return self._latest(kind, key)
        return (
            self.db.query(MemoryEntry)
            .filter(MemoryEntry.kind == kind, MemoryEntry.key == key, MemoryEntry.version == version)
            .one_or_none()
        )

    def history(self, kind: str, key: str) -> list[MemoryEntry]:
        return (
            self.db.query(MemoryEntry)
            .filter(MemoryEntry.kind == kind, MemoryEntry.key == key)
            .order_by(MemoryEntry.version.asc())
            .all()
        )

    def list_entries(
        self,
        *,
        kind: Optional[str] = None,
        q: Optional[str] = None,
        tag: Optional[str] = None,
        status: Optional[str] = "active",
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryEntry]:
        query = self.db.query(MemoryEntry)
        if kind:
            query = query.filter(MemoryEntry.kind == kind)
        if status:
            query = query.filter(MemoryEntry.status == status)
        if q:
            like = f"%{q.strip()}%"
            query = query.filter((MemoryEntry.key.ilike(like)) | (MemoryEntry.title.ilike(like)))
        query = query.order_by(MemoryEntry.created_at.desc(), MemoryEntry.id.desc())
        limit = max(1, min(limit, 500))
        if tag:
            # JSON containment is not portable across SQLite/Postgres; filter a bounded window.
            rows = [r for r in query.limit(2000).all() if tag.lower() in [str(t).lower() for t in (r.tags or [])]]
            return rows[offset: offset + limit]
        return query.offset(max(0, offset)).limit(limit).all()

    # -- seeding ------------------------------------------------------------------------------
    def seed_static_knowledge(self) -> dict[str, Any]:
        """Snapshot the documented trader profiles and strategy modules into versioned memory.
        Idempotent: only changed documents create a new version."""
        from app.knowledge.registry import list_traders
        from app.knowledge.strategies import list_strategy_modules

        out = {"trader_profile": {"new_versions": 0, "unchanged": 0}, "methodology": {"new_versions": 0, "unchanged": 0}}
        for t in list_traders():
            _, changed = self.put_document(
                "trader_profile", str(t["id"]), t, title=t.get("full_name"),
                tags=list(t.get("tags") or []), source="knowledge_registry",
            )
            out["trader_profile"]["new_versions" if changed else "unchanged"] += 1
        for m in list_strategy_modules():
            _, changed = self.put_document(
                "methodology", str(m["id"]), m, title=m.get("name"),
                tags=list(m.get("markets") or []), source="knowledge_strategies",
            )
            out["methodology"]["new_versions" if changed else "unchanged"] += 1
        return out

    def snapshot_risk_limits(self, settings: Any) -> tuple[MemoryEntry, bool]:
        """Record the server-enforced risk limits (no secrets). History shows every change."""
        content = {
            "default_risk_per_trade_pct": settings.default_risk_per_trade_pct,
            "max_daily_loss_pct": settings.max_daily_loss_pct,
            "max_portfolio_drawdown_pct": settings.max_portfolio_drawdown_pct,
            "max_open_positions": settings.max_open_positions,
            "max_correlated_exposure_pct": settings.max_correlated_exposure_pct,
            "max_position_notional_pct": settings.max_position_notional_pct,
            "kill_switch": settings.kill_switch,
            "live_trading_enabled": settings.live_trading_enabled,
            "require_live_confirmation": settings.require_live_confirmation,
            "data_max_age_seconds": settings.data_max_age_seconds,
            "paper_starting_equity": settings.paper_starting_equity,
            "enforced_by": "RiskEngine (server configuration)",
        }
        return self.put_document(
            "risk_limit", "server_enforced", content,
            title="Server-enforced risk limits", tags=["enforced"], source="settings",
        )

    # -- overview -----------------------------------------------------------------------------
    def _count(self, model: Any, *criteria: Any) -> int:
        q = self.db.query(func.count(model.id))
        for c in criteria:
            q = q.filter(c)
        return int(q.scalar() or 0)

    def overview(self) -> dict[str, Any]:
        """Counts for every memory domain the system is required to retain."""
        by_kind = {
            k: int(n)
            for k, n in self.db.query(MemoryEntry.kind, func.count(MemoryEntry.id))
            .filter(MemoryEntry.status == "active")
            .group_by(MemoryEntry.kind)
            .all()
        }
        sig_scored = self._count(MemorySignal, MemorySignal.outcome_status == "scored")
        domains = {
            "trader_profiles": by_kind.get("trader_profile", 0),
            "documented_methodologies": by_kind.get("methodology", 0),
            "historical_market_observations": by_kind.get("market_observation", 0),
            "strategy_configurations": self._count(StrategyVersion),
            "backtesting_results": self._count(MemoryBacktest),
            "previous_signals": self._count(MemorySignal),
            "signal_outcomes": sig_scored,
            "executed_trades": self._count(MemoryTrade),
            "winning_trades": self._count(MemoryTrade, MemoryTrade.classification == "win"),
            "losing_trades": self._count(MemoryTrade, MemoryTrade.classification == "loss"),
            "market_conditions": self._count(RegimeObservation),
            "prediction_accuracy_samples": sig_scored,
            "user_preferences": by_kind.get("user_preference", 0),
            "risk_limits": by_kind.get("risk_limit", 0),
            "strategy_failures": by_kind.get("strategy_failure", 0),
            "lessons_learned": self._count(MemoryLesson),
        }
        return {
            "domains": domains,
            "open_trades": self._count(MemoryTrade, MemoryTrade.status == "open"),
            "open_research_priorities": self._count(ResearchPriority, ResearchPriority.status == "open"),
            "schema_version": 1,
        }

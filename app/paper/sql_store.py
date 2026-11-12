"""SQLAlchemy persistence for paper accounts (works on SQLite and PostgreSQL). Optimistic concurrency via a version column."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import JSON, DateTime, Integer, String, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.paper.store import StaleStateError


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class PaperAccountRow(Base):
    __tablename__ = "paper_accounts"
    account_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    state: Mapped[dict] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class PaperAuditRow(Base):
    """Append-only: rows are only ever inserted."""
    __tablename__ = "paper_audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    ts: Mapped[str] = mapped_column(String(40))
    event: Mapped[str] = mapped_column(String(48), index=True)
    order_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


_READY: set[int] = set()


class SqlPaperStore:
    def __init__(self, session_factory: Callable[[], Any]):
        self._sf = session_factory

    def _session(self):
        """Open a session, creating the paper tables first if this database does not have them yet (idempotent, checkfirst)."""
        db = self._sf()
        bind = db.get_bind()
        if id(bind) not in _READY:
            Base.metadata.create_all(bind=bind, tables=[PaperAccountRow.__table__, PaperAuditRow.__table__])
            _READY.add(id(bind))
        return db

    def load(self, account_id: str) -> tuple[Optional[dict], int]:
        with self._session() as db:
            row = db.get(PaperAccountRow, account_id)
            return (dict(row.state), row.version) if row else (None, 0)

    def save(self, account_id: str, state: dict, audit: list[dict], expected_version: int) -> int:
        with self._session() as db:
            try:
                if expected_version == 0:
                    db.add(PaperAccountRow(account_id=account_id, state=state, version=1, updated_at=_now()))
                    new_version = 1
                else:
                    res = db.execute(update(PaperAccountRow).where(PaperAccountRow.account_id == account_id,
                                                                  PaperAccountRow.version == expected_version)
                                     .values(state=state, version=expected_version + 1, updated_at=_now()))
                    if res.rowcount != 1:
                        db.rollback()
                        raise StaleStateError(account_id)
                    new_version = expected_version + 1
                for a in audit:
                    db.add(PaperAuditRow(account_id=account_id, seq=a["seq"], ts=a["ts"], event=a["event"], order_id=a.get("order_id"), detail=a.get("detail")))
                db.commit()
                return new_version
            except IntegrityError:
                db.rollback()
                raise StaleStateError(account_id)

    def audit(self, account_id: str, limit: int = 200) -> list[dict]:
        with self._session() as db:
            rows = db.query(PaperAuditRow).filter(PaperAuditRow.account_id == account_id).order_by(PaperAuditRow.id.desc()).limit(limit).all()
            return [{"seq": r.seq, "ts": r.ts, "account_id": r.account_id, "event": r.event, "order_id": r.order_id, "detail": r.detail} for r in rows]

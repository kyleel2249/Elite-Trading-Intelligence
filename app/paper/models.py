"""SQLAlchemy tables for the internal paper engine (imported by app.database.init_db)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PaperAccountRow(Base):
    __tablename__ = "paper_accounts"

    account_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[dict] = mapped_column(JSON)            # full account aggregate: cash, positions, orders, fills
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PaperEventRow(Base):
    """Append-only audit trail (orders accepted/rejected, fills, triggers, cancels, kill-switch blocks)."""
    __tablename__ = "paper_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    event: Mapped[str] = mapped_column(String(48), index=True)
    order_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


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

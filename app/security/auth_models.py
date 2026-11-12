"""Tables for server-side execution authorization (session tokens + audit events).

Only a keyed hash of each token is stored; the raw token exists only in the HttpOnly cookie that
the browser holds and is never written to the database, logs or API responses.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ExecAuthToken(Base):
    __tablename__ = "eti_exec_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_id: Mapped[str] = mapped_column(String(24), unique=True, index=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    key_id: Mapped[str] = mapped_column(String(16))
    environment: Mapped[str] = mapped_column(String(24), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="session")
    subject: Mapped[str] = mapped_column(String(64), default="browser")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    idle_expires_at: Mapped[datetime] = mapped_column(DateTime)
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    replaced_by: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    revoked_reason: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)


class ExecAuthEvent(Base):
    """Audit trail. Holds the public token id only - never a secret, cookie or key."""

    __tablename__ = "eti_exec_auth_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    event: Mapped[str] = mapped_column(String(32), index=True)
    environment: Mapped[Optional[str]] = mapped_column(String(24), nullable=True, index=True)
    token_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    principal: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    result: Mapped[str] = mapped_column(String(16))
    reason: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    path: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

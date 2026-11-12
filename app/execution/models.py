"""SQLAlchemy tables for the execution engine. Imported by app.database.init_db so create_all sees them."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.execution.domain import utcnow


class ExecutionAccount(Base):
    __tablename__ = "execution_accounts"

    account_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    environment: Mapped[str] = mapped_column(String(16))
    label: Mapped[str] = mapped_column(String(128), default="")
    policy: Mapped[dict] = mapped_column(JSON, default=dict)
    halted: Mapped[bool] = mapped_column(Boolean, default=False)
    halted_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    baseline: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    credentials_ciphertext: Mapped[Optional[str]] = mapped_column(Text, nullable=True)   # Fernet token, never plaintext
    equity_hwm: Mapped[float] = mapped_column(Float, default=0.0)
    day_key: Mapped[str] = mapped_column(String(10), default="")
    day_start_equity: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ExecutionOrder(Base):
    __tablename__ = "execution_orders"

    client_order_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(256), unique=True, index=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    environment: Mapped[str] = mapped_column(String(16))
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(8))
    qty: Mapped[float] = mapped_column(Float)
    order_type: Mapped[str] = mapped_column(String(16))
    limit_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(24), index=True)
    filled_qty: Mapped[float] = mapped_column(Float, default=0.0)
    avg_fill_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    provider_order_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    mode: Mapped[str] = mapped_column(String(24), default="")
    origin: Mapped[str] = mapped_column(String(16), default="autonomous")
    strategy: Mapped[str] = mapped_column(String(64), default="")
    thesis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (Index("ix_exec_orders_acct_created", "account_id", "created_at"),)


class ExecutionProposal(Base):
    __tablename__ = "execution_proposals"

    proposal_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    intent: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    quote_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    decided_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class ExecutionLog(Base):
    """Append-only audit trail. Rows are never updated or deleted by the application."""
    __tablename__ = "execution_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    event: Mapped[str] = mapped_column(String(48), index=True)
    client_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

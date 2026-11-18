"""Tables for the Executive Command Centre (registered by app.database.init_db). Money is integer units of 1e-8.

Budgets, payment requests and the reserve policy are mutable working records; every change is also written to
exec_audit, which is append-only (triggers reject UPDATE/DELETE)."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import JSON, BigInteger, Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.prediction_ledger.immutability import install_on_create


class ExecBudget(Base):
    __tablename__ = "exec_budgets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    department: Mapped[str] = mapped_column(String(40), index=True)
    period: Mapped[str] = mapped_column(String(7))                      # YYYY or YYYY-MM
    currency: Mapped[str] = mapped_column(String(10), default="USD")
    amount: Mapped[int] = mapped_column(BigInteger)
    note: Mapped[str] = mapped_column(Text, default="")
    set_by: Mapped[str] = mapped_column(String(64), default="system")
    updated_at: Mapped[str] = mapped_column(String(32))
    __table_args__ = (UniqueConstraint("department", "period", "currency", name="uq_exec_budget"),)


class ExecPaymentRequest(Base):
    __tablename__ = "exec_payment_requests"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    reference: Mapped[str] = mapped_column(String(64), unique=True)
    idem_key: Mapped[Optional[str]] = mapped_column(String(120), unique=True, nullable=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    payee: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    amount: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(10), default="USD")
    department: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    due_date: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(12), index=True)         # pending|approved|rejected|paid|cancelled
    document_id: Mapped[Optional[str]] = mapped_column(String(300), nullable=True, index=True)
    expense_account: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    from_account: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    to_account: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    requested_by: Mapped[str] = mapped_column(String(64))
    requested_at: Mapped[str] = mapped_column(String(32))
    decided_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    decision_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    paid_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    paid_at: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    payment_ref: Mapped[Optional[str]] = mapped_column(String(190), nullable=True)
    ledger_entry: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    ledger_booked: Mapped[bool] = mapped_column(Boolean, default=False)


class ExecReservePolicy(Base):
    __tablename__ = "exec_reserve_policy"
    currency: Mapped[str] = mapped_column(String(10), primary_key=True)
    target: Mapped[int] = mapped_column(BigInteger, default=0)
    months_of_burn: Mapped[int] = mapped_column(Integer, default=0)
    updated_by: Mapped[str] = mapped_column(String(64), default="system")
    updated_at: Mapped[str] = mapped_column(String(32))


class ExecAudit(Base):
    __tablename__ = "exec_audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[str] = mapped_column(String(32), index=True)
    actor: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(16))
    action: Mapped[str] = mapped_column(String(48), index=True)
    subject: Mapped[str] = mapped_column(String(96))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


install_on_create(ExecAudit.__table__)

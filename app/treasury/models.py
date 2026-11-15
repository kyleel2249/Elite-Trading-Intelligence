"""Persistent withdrawal-approval requests (survive restarts; consumption is an atomic conditional UPDATE)."""
from __future__ import annotations

from sqlalchemy import Boolean, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class WithdrawalApproval(Base):
    __tablename__ = "eti_withdrawal_approvals"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(String(66), unique=True, index=True)
    network: Mapped[str] = mapped_column(String(24))
    to_address: Mapped[str] = mapped_column(String(42))
    amount_wei: Mapped[str] = mapped_column(String(80))
    requester: Mapped[str] = mapped_column(String(42))
    nonce: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    signatures: Mapped[dict] = mapped_column(JSON, default=dict)     # approver(lower) -> [r_hex, s_hex, recid]
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)

"""Broker-wallet funding and fee tables (kept apart from the core wallet tables)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ChainFunding(Base):
    """A verified on-chain transfer from the broker wallet to the ETI wallet (the capital ETI trades with)."""
    __tablename__ = "eti_chain_funding"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    network: Mapped[str] = mapped_column(String(24), index=True)
    tx_hash: Mapped[str] = mapped_column(String(66), unique=True, index=True)
    from_address: Mapped[str] = mapped_column(String(42))
    to_address: Mapped[str] = mapped_column(String(42))
    value_wei: Mapped[str] = mapped_column(String(80))
    block_number: Mapped[int] = mapped_column(Integer)
    confirmations: Mapped[int] = mapped_column(Integer)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ChainFee(Base):
    """Fee owed to the broker for one confirmed trade. accrued -> settling (payment broadcast) -> paid (payment confirmed)."""
    __tablename__ = "eti_chain_fees"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    network: Mapped[str] = mapped_column(String(24), index=True)
    source_tx_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    notional_wei: Mapped[str] = mapped_column(String(80))
    fee_bps: Mapped[int] = mapped_column(Integer)
    fee_wei: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(12), index=True)
    paid_tx_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

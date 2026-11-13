"""Futures paper-simulation tables. Money is stored as exact decimal strings (no float rounding, identical on SQLite and PostgreSQL)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Index, Integer, JSON, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class FuturesAccount(Base):
    """Simulated USDT-margined futures account. Invariant: wallet = starting + realized_pnl - fees_paid - funding_paid."""
    __tablename__ = "futures_paper_accounts"

    account_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    currency: Mapped[str] = mapped_column(String(10), default="USDT")
    starting_balance: Mapped[str] = mapped_column(String(48))
    wallet_balance: Mapped[str] = mapped_column(String(48))
    realized_pnl: Mapped[str] = mapped_column(String(48), default="0")   # gross, before fees and funding
    fees_paid: Mapped[str] = mapped_column(String(48), default="0")
    funding_paid: Mapped[str] = mapped_column(String(48), default="0")   # positive = paid, negative = received
    version: Mapped[int] = mapped_column(Integer, default=1)            # optimistic concurrency
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class FuturesPosition(Base):
    __tablename__ = "futures_paper_positions"
    __table_args__ = (
        Index("uq_futures_open_position", "account_id", "symbol", unique=True,
              sqlite_where=text("status = 'open'"), postgresql_where=text("status = 'open'")),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    direction: Mapped[str] = mapped_column(String(5))
    leverage: Mapped[int] = mapped_column(Integer)
    margin_mode: Mapped[str] = mapped_column(String(10), default="isolated")
    status: Mapped[str] = mapped_column(String(12), index=True)          # open | closed | liquidated
    qty: Mapped[str] = mapped_column(String(48))                          # base units
    entry_price: Mapped[str] = mapped_column(String(48))                  # simulated fill (mark + slippage)
    reference_price: Mapped[str] = mapped_column(String(48))              # mark price the fill was derived from
    notional: Mapped[str] = mapped_column(String(48))
    margin: Mapped[str] = mapped_column(String(48))                       # isolated margin reserved
    mmr: Mapped[str] = mapped_column(String(24))                          # maintenance margin rate used
    liq_price: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)  # ESTIMATE
    stop_price: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    take_profit_price: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    entry_fee: Mapped[str] = mapped_column(String(48))
    exit_price: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    exit_fee: Mapped[str] = mapped_column(String(48), default="0")
    funding: Mapped[str] = mapped_column(String(48), default="0")
    gross_pnl: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)
    realized_pnl: Mapped[Optional[str]] = mapped_column(String(48), nullable=True)   # net of fees and funding
    price_source: Mapped[str] = mapped_column(String(64))
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_funding_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    close_reason: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)


class FuturesEvent(Base):
    """Audit log. Rows are only ever inserted."""
    __tablename__ = "futures_paper_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str] = mapped_column(String(64), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    event: Mapped[str] = mapped_column(String(32), index=True)
    position_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

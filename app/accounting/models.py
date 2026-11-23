"""SQLAlchemy tables for the accounting engine (imported by app.database.init_db). The journal is append-only:
ORM-agnostic triggers (SQLite + PostgreSQL) reject UPDATE/DELETE on entries, lines, periods and reconciliation runs."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import JSON, BigInteger, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.prediction_ledger.immutability import install_on_create


class AcctAccount(Base):
    __tablename__ = "acct_accounts"
    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(12))
    parent: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    postable: Mapped[bool] = mapped_column(Boolean, default=True)
    cash: Mapped[bool] = mapped_column(Boolean, default=False)
    cashflow: Mapped[str] = mapped_column(String(12), default="operating")
    group_name: Mapped[str] = mapped_column(String(64), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class AcctEntry(Base):
    __tablename__ = "acct_entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_date: Mapped[str] = mapped_column(String(10), index=True)
    period: Mapped[str] = mapped_column(String(7), index=True)
    source: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[str] = mapped_column(String(200))
    memo: Mapped[str] = mapped_column(Text, default="")
    environment: Mapped[str] = mapped_column(String(12), index=True)
    reverses: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, unique=True)
    document_id: Mapped[Optional[str]] = mapped_column(String(300), nullable=True, index=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    posted_by: Mapped[str] = mapped_column(String(64), default="system")
    created_at: Mapped[str] = mapped_column(String(32))
    digest: Mapped[str] = mapped_column(String(64))
    prev_hash: Mapped[str] = mapped_column(String(64), unique=True)
    entry_hash: Mapped[str] = mapped_column(String(64), unique=True)
    lines: Mapped[list["AcctLine"]] = relationship(back_populates="entry", order_by="AcctLine.seq", lazy="selectin")
    __table_args__ = (UniqueConstraint("source", "source_id", name="uq_acct_entries_source_key"),)


class AcctLine(Base):
    __tablename__ = "acct_lines"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("acct_entries.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    account: Mapped[str] = mapped_column(String(8), index=True)
    debit: Mapped[int] = mapped_column(BigInteger, default=0)
    credit: Mapped[int] = mapped_column(BigInteger, default=0)
    currency: Mapped[str] = mapped_column(String(10))
    department: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    symbol: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    strategy: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    counterparty: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    external_ref: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, index=True)
    memo: Mapped[str] = mapped_column(Text, default="")
    entry: Mapped[AcctEntry] = relationship(back_populates="lines")


class AcctPeriod(Base):
    __tablename__ = "acct_periods"
    period: Mapped[str] = mapped_column(String(7), primary_key=True)
    closed_by: Mapped[str] = mapped_column(String(64))
    closed_at: Mapped[str] = mapped_column(String(32))


class AcctExtTxn(Base):
    __tablename__ = "acct_ext_txns"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(64))
    ext_id: Mapped[str] = mapped_column(String(200))
    ts: Mapped[str] = mapped_column(String(10), index=True)
    account: Mapped[str] = mapped_column(String(8), index=True)
    currency: Mapped[str] = mapped_column(String(10))
    amount: Mapped[int] = mapped_column(BigInteger)
    fee: Mapped[int] = mapped_column(BigInteger, default=0)
    kind: Mapped[str] = mapped_column(String(12))
    counterparty: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    confirmations: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(32))
    __table_args__ = (UniqueConstraint("source", "ext_id", name="uq_acct_ext_txn"),)


class AcctReconRun(Base):
    __tablename__ = "acct_recon_runs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    source: Mapped[str] = mapped_column(String(64))
    account: Mapped[str] = mapped_column(String(8))
    date_from: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    date_to: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    status: Mapped[str] = mapped_column(String(16))
    counts: Mapped[dict] = mapped_column(JSON, default=dict)
    ran_at: Mapped[str] = mapped_column(String(32))
    result: Mapped[dict] = mapped_column(JSON, default=dict)


APPEND_ONLY = ("acct_entries", "acct_lines", "acct_periods", "acct_recon_runs")
for _m in (AcctEntry, AcctLine, AcctPeriod, AcctReconRun):
    install_on_create(_m.__table__)

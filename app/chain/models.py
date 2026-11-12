"""Wallet, allowlist, transaction and audit tables for the ETI on-chain wallet.

The private key is stored only as a Fernet ciphertext (EXECUTION_VAULT_KEY is a separate secret from the database).
Big integers (wei) are stored as decimal strings so SQLite/Postgres behave identically.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ChainWallet(Base):
    __tablename__ = "eti_chain_wallets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    address: Mapped[str] = mapped_column(String(42), unique=True, index=True)
    key_ciphertext: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(String(64), default="ETI wallet")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ChainAllowlist(Base):
    __tablename__ = "eti_chain_allowlist"
    __table_args__ = (UniqueConstraint("network", "address", "kind", name="uq_chain_allow"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    network: Mapped[str] = mapped_column(String(24), index=True)          # network key or "*"
    address: Mapped[str] = mapped_column(String(42), index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)             # destination | token | watch
    label: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    symbol: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    decimals: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ChainTransaction(Base):
    __tablename__ = "eti_chain_txs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    quote_id: Mapped[str] = mapped_column(String(32), unique=True)        # single-use quote nonce
    wallet_address: Mapped[str] = mapped_column(String(42), index=True)
    network: Mapped[str] = mapped_column(String(24), index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)             # transfer | swap | approve
    to_address: Mapped[str] = mapped_column(String(42))
    value_wei: Mapped[str] = mapped_column(String(80))
    notional_wei: Mapped[str] = mapped_column(String(80), default="0")
    data_hex: Mapped[str] = mapped_column(Text, default="0x")
    nonce: Mapped[int] = mapped_column(Integer)
    gas_limit: Mapped[int] = mapped_column(Integer)
    tx_hash: Mapped[str] = mapped_column(String(66), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(20), index=True)           # signed|pending|confirmed|failed|broadcast_failed
    summary: Mapped[str] = mapped_column(String(240), default="")
    error: Mapped[Optional[str]] = mapped_column(String(240), nullable=True)
    gas_used: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    block_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    policy: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ChainEvent(Base):
    """Audit trail of wallet actions (never contains key material)."""
    __tablename__ = "eti_chain_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    event: Mapped[str] = mapped_column(String(32), index=True)
    network: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    tx_hash: Mapped[Optional[str]] = mapped_column(String(66), nullable=True)
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

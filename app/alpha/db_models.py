"""Persistence for Global Alpha Intelligence. Imported by app.database.init_db."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AlphaCandidate(Base):
    """Every investigated candidate, including rejected ones with reasons."""
    __tablename__ = "alpha_candidates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    candidate_id: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    asset_class: Mapped[str] = mapped_column(String(16), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    exchange: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    chain: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    contract: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    provider: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), index=True, default="WATCHLIST")
    stage: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    early_alpha_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True, index=True)
    overall_rank_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True, index=True)
    scores: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    reasons: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    rejection_reasons: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    evidence: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    plan: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # entry zone / invalidation
    last_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    market_cap: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    volume_24h: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    data_status: Mapped[str] = mapped_column(String(24), default="unknown")
    scan_count: Mapped[int] = mapped_column(Integer, default=1)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    validated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class AlphaSourceStatus(Base):
    __tablename__ = "alpha_source_status"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    last_success: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    calls: Mapped[int] = mapped_column(Integer, default=0)
    failures: Mapped[int] = mapped_column(Integer, default=0)


class AlphaStrategyRun(Base):
    __tablename__ = "alpha_strategy_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(64), index=True)
    asset_class: Mapped[str] = mapped_column(String(16), index=True)
    symbol: Mapped[str] = mapped_column(String(64))
    timeframe: Mapped[str] = mapped_column(String(8))
    bars: Mapped[int] = mapped_column(Integer)
    in_sample: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    out_of_sample: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    folds: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    verdict: Mapped[str] = mapped_column(String(24))
    reasons: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class AlphaStrategyState(Base):
    """Champion/challenger status per (strategy, asset class); history lives in runs."""
    __tablename__ = "alpha_strategy_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(64), index=True)
    asset_class: Mapped[str] = mapped_column(String(16), index=True)
    status: Mapped[str] = mapped_column(String(16), default="CHALLENGER")  # CHAMPION|CHALLENGER|RETIRED
    version: Mapped[int] = mapped_column(Integer, default=1)
    consecutive_passes: Mapped[int] = mapped_column(Integer, default=0)
    consecutive_fails: Mapped[int] = mapped_column(Integer, default=0)
    live_trades: Mapped[int] = mapped_column(Integer, default=0)
    live_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    __table_args__ = (Index("ix_alpha_state_pair", "strategy_id", "asset_class", unique=True),)


class TraderQualification(Base):
    __tablename__ = "alpha_trader_qualifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    category: Mapped[str] = mapped_column(String(48))
    evidence: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    criteria: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), index=True)  # QUALIFIED|REJECTED|PENDING_EVIDENCE
    reasons: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    decided_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TraderProfileVersion(Base):
    """Immutable history of profile changes; the live profile is the highest version."""
    __tablename__ = "alpha_profile_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trader_id: Mapped[str] = mapped_column(String(96), index=True)
    version: Mapped[int] = mapped_column(Integer)
    field: Mapped[str] = mapped_column(String(64))
    old_value: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    new_value: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    change_reason: Mapped[str] = mapped_column(Text)
    sources: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_alpha_pv", "trader_id", "version"),)


class WalletLabel(Base):
    __tablename__ = "alpha_wallet_labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    chain: Mapped[str] = mapped_column(String(32))
    address: Mapped[str] = mapped_column(String(96))
    label: Mapped[str] = mapped_column(String(160))
    entity_type: Mapped[str] = mapped_column(String(32))  # exchange|fund|treasury|individual|unknown
    source: Mapped[str] = mapped_column(String(300))
    confidence: Mapped[float] = mapped_column(Float)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_alpha_wallet", "chain", "address", unique=True),)


class AlphaTradePlan(Base):
    __tablename__ = "alpha_trade_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_id: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    candidate_id: Mapped[str] = mapped_column(String(160), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(16))
    environment: Mapped[str] = mapped_column(String(16))
    side: Mapped[str] = mapped_column(String(8))
    entry: Mapped[float] = mapped_column(Float)
    stop: Mapped[float] = mapped_column(Float)
    tp1: Mapped[float] = mapped_column(Float)
    tp2: Mapped[float] = mapped_column(Float)
    tp3: Mapped[float] = mapped_column(Float)
    qty: Mapped[float] = mapped_column(Float)
    remaining_qty: Mapped[float] = mapped_column(Float, default=0.0)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    stop_current: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), index=True)  # PLANNED|OPEN|CLOSED|REJECTED|ERROR|UNCONFIRMED
    client_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    tp_hits: Mapped[int] = mapped_column(Integer, default=0)
    decision: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    attribution: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    close_reason: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    close_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    strategy_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class AlphaAuditLog(Base):
    __tablename__ = "alpha_audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(64), index=True)
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class AlphaResearchRun(Base):
    __tablename__ = "alpha_research_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(16))
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    summary: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class Holding13F(Base):
    """Parsed 13F information-table rows. publication_date = filing date (when public)."""
    __tablename__ = "alpha_13f_holdings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    filer_cik: Mapped[str] = mapped_column(String(12), index=True)
    filer_name: Mapped[str] = mapped_column(String(256))
    accession: Mapped[str] = mapped_column(String(32), index=True)
    period_of_report: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    filing_date: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    issuer: Mapped[str] = mapped_column(String(256))
    cusip: Mapped[str] = mapped_column(String(12), index=True)
    title_of_class: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    value_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    shares: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    put_call: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    __table_args__ = (Index("ix_alpha_13f_unique", "accession", "cusip", "put_call", "shares", unique=False),)

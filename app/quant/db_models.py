"""Persistence models for the global scanner / valuation / sizing / execution stack."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, Index, Integer, JSON, String, Text, event
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models import utcnow


class ScanRun(Base):
    __tablename__ = "scan_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    universe_size: Mapped[int] = mapped_column(Integer, default=0)
    scanned_ok: Mapped[int] = mapped_column(Integer, default=0)
    stale: Mapped[int] = mapped_column(Integer, default=0)
    unavailable: Mapped[int] = mapped_column(Integer, default=0)
    requests: Mapped[int] = mapped_column(Integer, default=0)
    retries: Mapped[int] = mapped_column(Integer, default=0)
    failovers: Mapped[int] = mapped_column(Integer, default=0)
    completion_pct: Mapped[float] = mapped_column(Float, default=0.0)
    within_interval: Mapped[bool] = mapped_column(Boolean, default=True)
    per_provider: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class MarketCoverage(Base):
    """Market coverage registry: one row per instrument, upserted each scan."""
    __tablename__ = "market_coverage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    asset_class: Mapped[str] = mapped_column(String(32), index=True)
    exchange: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    failover_provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    data_age_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    quality_score: Mapped[float] = mapped_column(Float, default=0.0)
    fields: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    last_success_ts: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    last_valid_data_ts: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class FairValueEstimate(Base):
    __tablename__ = "fair_value_estimates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    asset_class: Mapped[str] = mapped_column(String(32))
    market_price: Mapped[float] = mapped_column(Float)
    fair_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    lower_bound: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    upper_bound: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    supported: Mapped[bool] = mapped_column(Boolean, default=False)
    model_version: Mapped[str] = mapped_column(String(32), default="fv-1")
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class MispricingAlert(Base):
    __tablename__ = "mispricing_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    direction: Mapped[str] = mapped_column(String(16))
    mispricing_pct: Mapped[float] = mapped_column(Float)
    band: Mapped[str] = mapped_column(String(16))
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    market_price_at_discovery: Mapped[float] = mapped_column(Float)
    fair_value_at_discovery: Mapped[float] = mapped_column(Float)
    failed_checks: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    unverified_checks: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open|converged|expired
    converged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PredictionLedger(Base):
    """Append-only. Rows are never updated or deleted; outcomes live in PredictionOutcome."""
    __tablename__ = "prediction_ledger"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prediction_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # idempotent
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    market_price: Mapped[float] = mapped_column(Float)
    fair_value: Mapped[float] = mapped_column(Float)
    mispricing_pct: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    horizon_days: Mapped[float] = mapped_column(Float)
    expected_direction: Mapped[str] = mapped_column(String(8))
    invalidation: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    model_version: Mapped[str] = mapped_column(String(32), default="fv-1")
    strategy: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    asset_class: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class PredictionOutcome(Base):
    __tablename__ = "prediction_outcomes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prediction_id: Mapped[int] = mapped_column(Integer, index=True)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    realized_price: Mapped[float] = mapped_column(Float)
    direction_correct: Mapped[bool] = mapped_column(Boolean)
    converged: Mapped[bool] = mapped_column(Boolean)
    return_pct: Mapped[float] = mapped_column(Float)


@event.listens_for(PredictionLedger, "before_update")
def _block_ledger_update(mapper, connection, target):  # noqa: ARG001
    raise ValueError("prediction_ledger is append-only: rows cannot be modified")


@event.listens_for(PredictionLedger, "before_delete")
def _block_ledger_delete(mapper, connection, target):  # noqa: ARG001
    raise ValueError("prediction_ledger is append-only: rows cannot be deleted")


class KellyCalculation(Base):
    __tablename__ = "kelly_calculations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    final_allocation_pct: Mapped[float] = mapped_column(Float, default=0.0)
    inputs: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class SentimentAssessment(Base):
    __tablename__ = "sentiment_assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    label: Mapped[str] = mapped_column(String(24))
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ExecutionEventRecord(Base):
    __tablename__ = "execution_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    signal_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)  # duplicate-order guard
    client_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    environment: Mapped[str] = mapped_column(String(16))
    state: Mapped[str] = mapped_column(String(24), index=True)
    latency_ms: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    actor: Mapped[str] = mapped_column(String(64), default="system")
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


Index("ix_mispricing_symbol_status", MispricingAlert.symbol, MispricingAlert.status)

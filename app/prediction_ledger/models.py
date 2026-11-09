"""Prediction ledger tables. All three are append-only (never updated, never deleted)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, Integer, JSON, String, Text, event
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models import utcnow
from app.prediction_ledger.immutability import install_on_create


class ImmutableRecordError(RuntimeError):
    """Raised on any attempt to modify or delete a ledger record."""


class PredictionRecord(Base):
    __tablename__ = "predictions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prediction_uid: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(160), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)  # server clock, UTC
    asset: Mapped[str] = mapped_column(String(64), index=True)
    market: Mapped[str] = mapped_column(String(32), index=True)
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    direction: Mapped[str] = mapped_column(String(8))
    entry_reference: Mapped[float] = mapped_column(Float)
    horizon_label: Mapped[str] = mapped_column(String(32), index=True)
    horizon_seconds: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    target_low: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    target_high: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    target_base: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    probability: Mapped[float] = mapped_column(Float)
    reasoning: Mapped[str] = mapped_column(Text)
    sources: Mapped[list] = mapped_column(JSON)
    invalidation_criteria: Mapped[str] = mapped_column(Text)
    invalidation_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    market_regime: Mapped[Optional[str]] = mapped_column(String(48), nullable=True, index=True)
    strategy: Mapped[Optional[str]] = mapped_column(String(96), nullable=True, index=True)
    model_version: Mapped[str] = mapped_column(String(48), default="manual")
    analyst: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    legacy_forecast_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64))


class PredictionOutcome(Base):
    """Write-once result for a prediction. status: resolved | invalidated | late | manual_void."""

    __tablename__ = "prediction_outcomes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prediction_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    realized_price: Mapped[float] = mapped_column(Float)
    price_source: Mapped[str] = mapped_column(String(64))
    observed_at: Mapped[datetime] = mapped_column(DateTime)
    late_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    return_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    direction_correct: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    in_target_range: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    abs_error: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pct_error: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    invalidated: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class PredictionReport(Base):
    """Published monthly performance report. One per period; immutable once stored."""

    __tablename__ = "prediction_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    period: Mapped[str] = mapped_column(String(7), unique=True, index=True)  # YYYY-MM
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    summary: Mapped[dict] = mapped_column(JSON)
    markdown: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))


LEDGER_TABLES = (PredictionRecord, PredictionOutcome, PredictionReport)


def _block(mapper, connection, target):  # noqa: ARG001
    raise ImmutableRecordError(f"{type(target).__name__} is append-only; updates and deletes are forbidden")


for _model in LEDGER_TABLES:
    event.listen(_model, "before_update", _block)
    event.listen(_model, "before_delete", _block)
    install_on_create(_model.__table__)

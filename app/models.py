"""SQLAlchemy models — extend, do not destroy."""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import String, Float, Integer, Boolean, DateTime, Text, JSON, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Instrument(Base):
    __tablename__ = "instruments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    normalized_symbol: Mapped[str] = mapped_column(String(64), index=True)
    asset_class: Mapped[str] = mapped_column(String(32))
    exchange: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    quote_currency: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    tradable: Mapped[bool] = mapped_column(Boolean, default=True)
    meta: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    __table_args__ = (Index("ix_provider_symbol", "provider", "symbol", unique=True),)


class MarketSnapshot(Base):
    __tablename__ = "market_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    price: Mapped[float] = mapped_column(Float)
    bid: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    ask: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    volume: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    ts_provider: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ts_utc: Mapped[datetime] = mapped_column(DateTime, index=True)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    data_status: Mapped[str] = mapped_column(String(32), default="unknown")
    quality_flags: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class OrderRecord(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_order_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    environment: Mapped[str] = mapped_column(String(16))
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(8))
    order_type: Mapped[str] = mapped_column(String(16))
    qty: Mapped[float] = mapped_column(Float)
    limit_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fill_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    provider_order_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    risk_approved: Mapped[bool] = mapped_column(Boolean, default=False)
    risk_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    realized_pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    environment: Mapped[str] = mapped_column(String(16), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(8))
    qty: Mapped[float] = mapped_column(Float, default=0.0)
    avg_entry: Mapped[float] = mapped_column(Float, default=0.0)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    unrealized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    mark_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open")
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    meta: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    __table_args__ = (
        Index("ix_pos_provider_env_symbol", "provider", "environment", "symbol", "status"),
    )


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_order_id: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    environment: Mapped[str] = mapped_column(String(16), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(8))
    qty: Mapped[float] = mapped_column(Float)
    price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    event: Mapped[str] = mapped_column(String(32), index=True)
    pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    thesis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    council_action: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    risk_officer: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class RiskEvent(Base):
    __tablename__ = "risk_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(Text)
    context: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CouncilDecisionRecord(Base):
    __tablename__ = "council_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    action: Mapped[str] = mapped_column(String(32))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    summary: Mapped[str] = mapped_column(Text, default="")
    risk_veto: Mapped[bool] = mapped_column(Boolean, default=False)
    data_quality: Mapped[str] = mapped_column(String(32), default="unknown")
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ForecastRecord(Base):
    __tablename__ = "forecasts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    horizon: Mapped[str] = mapped_column(String(32))
    model_version: Mapped[str] = mapped_column(String(32), default="v0-scaffold")
    analyst: Mapped[str] = mapped_column(String(64), default="Lars Hagen")
    bull_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    base_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    bear_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    expected_vol: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ForecastAccuracy(Base):
    __tablename__ = "forecast_accuracy"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    forecast_id: Mapped[int] = mapped_column(Integer, index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    horizon: Mapped[str] = mapped_column(String(32))
    predicted_base: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    realized_price: Mapped[float] = mapped_column(Float)
    absolute_error: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pct_error: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    in_scenario_range: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    direction_correct: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    analyst: Mapped[str] = mapped_column(String(64), default="Lars Hagen")
    model_version: Mapped[str] = mapped_column(String(32), default="v0-scaffold")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class InvestorActivity(Base):
    """Durable disclosure / investor activity intelligence record."""

    __tablename__ = "investor_activities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    activity_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(64), index=True)
    investor_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True, index=True)
    institution: Mapped[Optional[str]] = mapped_column(String(256), nullable=True, index=True)
    ticker: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    direction: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    transaction_date: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    filing_or_report_date: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    publication_date: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    amount_or_range: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    source_provider: Mapped[str] = mapped_column(String(64), index=True)
    verification_status: Mapped[str] = mapped_column(String(64), default="UNCONFIRMED")
    significance: Mapped[str] = mapped_column(String(32), default="INFORMATIONAL", index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    notes: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    is_historical_snapshot: Mapped[bool] = mapped_column(Boolean, default=False)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class IntelligenceAlert(Base):
    """User-facing alert when meaningful verified activity is stored."""

    __tablename__ = "intelligence_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    activity_id: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)
    title: Mapped[str] = mapped_column(String(512))
    severity: Mapped[str] = mapped_column(String(32), default="MODERATE", index=True)
    ticker: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    investor_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    category: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    recommended_action: Mapped[str] = mapped_column(String(64), default="RESEARCH")
    source_provider: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    verification_status: Mapped[str] = mapped_column(String(64), default="UNCONFIRMED")
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class DisclosureOutcome(Base):
    """Post-publication return study scaffold (publication date = info availability)."""

    __tablename__ = "disclosure_outcomes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    activity_id: Mapped[str] = mapped_column(String(64), index=True)
    ticker: Mapped[str] = mapped_column(String(32), index=True)
    publication_date: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    horizon_days: Mapped[int] = mapped_column(Integer)
    return_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    benchmark_return_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# --- ETI CAPITAL PROTECTION SYSTEM + strategy quarantine (new tables only; nothing above is altered) ---
class ProtectionStateRecord(Base):
    """Key/value state: halt latches ('halt:<env>'), equity high-water marks ('peak:<env>'), news calendar heartbeat."""

    __tablename__ = "protection_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    value: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ProtectionNewsEvent(Base):
    """Scheduled market-moving events that trigger an order blackout window."""

    __tablename__ = "protection_news_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(256))
    impact: Mapped[str] = mapped_column(String(16), default="high")
    scope: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    event_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class StrategyQuarantineRecord(Base):
    __tablename__ = "strategy_quarantine"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE", index=True)
    expectations: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    reasons: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    quarantined_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Evidence for ongoing evaluation counts only from here: set when a strategy is released after revalidation,
    # so its pre-quarantine losses cannot re-trigger the quarantine it just passed.
    baseline_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    review: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    history: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class StrategyTradeLog(Base):
    """Every order attempt attributed to a strategy: feeds execution-quality and divergence tests."""

    __tablename__ = "strategy_trade_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(128), index=True)
    environment: Mapped[str] = mapped_column(String(16), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    symbol: Mapped[str] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(8))
    qty: Mapped[float] = mapped_column(Float)
    reference_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fill_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    slippage_bps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    outcome: Mapped[str] = mapped_column(String(24), index=True)  # filled|submitted|risk_refused|provider_error
    client_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ProtectionAuditRecord(Base):
    """Append-only, hash-chained audit trail of protection decisions, halts and quarantine transitions."""

    __tablename__ = "protection_audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    actor: Mapped[str] = mapped_column(String(64), default="system")
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    prev_hash: Mapped[str] = mapped_column(String(64), default="")
    hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

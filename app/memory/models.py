"""SQLAlchemy models for the ETI persistent memory & learning system.

Lives in its own module so ``app.models`` is untouched. ``app.database.init_db``, the
alembic environment and ``app.trading.portfolio`` import this module so the tables are
registered on ``Base.metadata`` wherever the schema is created.

Also defines ``AdaptiveEdgeEvent`` and ``StrategyRegistry`` which migration 0003 already
creates but which had no model.

JSON columns: always assign a *new* list/dict when updating (in-place mutation is not tracked).
"""
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Boolean, DateTime, Float, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class _DictMixin:
    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for col in self.__table__.columns:  # type: ignore[attr-defined]
            val = getattr(self, col.name)
            if isinstance(val, datetime):
                if val.tzinfo is None:
                    val = val.replace(tzinfo=timezone.utc)
                val = val.isoformat()
            out[col.name] = val
        return out


class MemoryEntry(_DictMixin, Base):
    """Generic append-only, versioned memory (profiles, methodologies, observations,
    preferences, risk limits, strategy failures)."""

    __tablename__ = "eti_memory_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    key: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    title: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    content: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    tags: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    source: Mapped[str] = mapped_column(String(64), default="user")
    content_sha256: Mapped[str] = mapped_column(String(64), default="")
    supersedes_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)

    __table_args__ = (UniqueConstraint("kind", "key", "version", name="uq_eti_memory_kind_key_version"),)


class MemorySignal(_DictMixin, Base):
    """A signal / prediction exactly as it was known at ``as_of`` (immutable apart from
    status + outcome fields)."""

    __tablename__ = "eti_signals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    signal_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    source: Mapped[str] = mapped_column(String(32), index=True)
    strategy_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    strategy_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    direction: Mapped[str] = mapped_column(String(8))
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    reference_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    stop_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    target_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    horizon_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    regime: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    assumptions: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    analysis: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    analysis_sha256: Mapped[str] = mapped_column(String(64), default="")
    as_of: Mapped[datetime] = mapped_column(DateTime, index=True)
    data_partition: Mapped[str] = mapped_column(String(16), default="live")
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open|executed
    trade_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    outcome_status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    outcome: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    outcome_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    outcome_ts: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    outcome_return_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    resolution_lag_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    outcome_note: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class MemoryTrade(_DictMixin, Base):
    """One executed position lifecycle with its full post-trade learning record."""

    __tablename__ = "eti_trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trade_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    signal_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    strategy_id: Mapped[str] = mapped_column(String(64), index=True)
    strategy_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    environment: Mapped[str] = mapped_column(String(16), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    side: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    data_partition: Mapped[str] = mapped_column(String(16), default="live")

    entry_qty: Mapped[float] = mapped_column(Float, default=0.0)
    open_qty: Mapped[float] = mapped_column(Float, default=0.0)
    entry_avg_price: Mapped[float] = mapped_column(Float, default=0.0)
    entry_notional: Mapped[float] = mapped_column(Float, default=0.0)
    expected_entry_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    entry_slippage_bps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    entry_fills: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    exit_qty_total: Mapped[float] = mapped_column(Float, default=0.0)
    exit_notional: Mapped[float] = mapped_column(Float, default=0.0)
    exit_avg_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    expected_exit_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    exit_deviation_bps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    exit_deviation_kind: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    exit_fills: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    gross_pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fees: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    net_pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    return_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    slippage_cost: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fee_bps_assumed: Mapped[float] = mapped_column(Float, default=0.0)
    fees_estimated: Mapped[bool] = mapped_column(Boolean, default=True)
    reported_pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    pnl_reconciliation_diff: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    mfe_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    mae_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    regime_entry: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    regime_exit: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    analysis_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    analysis_sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    analysis_integrity: Mapped[str] = mapped_column(String(16), default="n/a")
    learning: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    classification: Mapped[Optional[str]] = mapped_column(String(16), nullable=True, index=True)

    thesis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    council_action: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    client_order_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    holding_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class MemoryBacktest(_DictMixin, Base):
    __tablename__ = "eti_backtests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    strategy_id: Mapped[str] = mapped_column(String(64), index=True)
    strategy_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    interval: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    bars: Mapped[int] = mapped_column(Integer, default=0)
    data_start: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    data_end: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    partition: Mapped[str] = mapped_column(String(16), default="unclassified", index=True)
    trades: Mapped[int] = mapped_column(Integer, default=0)
    win_rate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    total_return_pct: Mapped[float] = mapped_column(Float, default=0.0)
    max_drawdown_pct: Mapped[float] = mapped_column(Float, default=0.0)
    fee_bps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    params: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    leakage_audit: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    validation_eligible: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class StrategyVersion(_DictMixin, Base):
    """Immutable strategy configuration history. Only ``status`` and approval fields change."""

    __tablename__ = "eti_strategy_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(64), index=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), index=True)
    config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    config_sha256: Mapped[str] = mapped_column(String(64), default="")
    parent_version: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    change_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    change_diff: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    evidence: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str] = mapped_column(String(64), default="system")
    approved_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    status_changed_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    __table_args__ = (UniqueConstraint("strategy_id", "version", name="uq_eti_strategy_version"),)


class MemoryLesson(_DictMixin, Base):
    """Empirical lesson aggregated over many closed trades (never from a single trade)."""

    __tablename__ = "eti_lessons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lesson_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    strategy_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    category: Mapped[str] = mapped_column(String(24), index=True)
    subject: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    supporting_count: Mapped[int] = mapped_column(Integer, default=0)
    contradicting_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="observation", index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    trade_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    context: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class ResearchPriority(_DictMixin, Base):
    """Research / monitoring priority queue fed by the post-trade learning loop."""

    __tablename__ = "eti_research_priorities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)  # research | monitoring
    strategy_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(256), default="")
    rationale: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    weight: Mapped[float] = mapped_column(Float, default=0.0)
    score: Mapped[float] = mapped_column(Float, default=0.0, index=True)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    last_trade_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class RegimeObservation(_DictMixin, Base):
    """Point-in-time market-regime series. Lookups are always 'latest as of T', never later."""

    __tablename__ = "eti_regime_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    provider: Mapped[str] = mapped_column(String(32), index=True)
    as_of: Mapped[datetime] = mapped_column(DateTime, index=True)
    primary_regime: Mapped[str] = mapped_column(String(64), index=True)
    coexisting: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    metrics: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="adaptive_cycle")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class AdaptiveEdgeEvent(_DictMixin, Base):
    __tablename__ = "adaptive_edge_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    ref_id: Mapped[str] = mapped_column(String(128), index=True)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    tags: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class StrategyRegistry(_DictMixin, Base):
    __tablename__ = "strategy_registry"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    strategy_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    family: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    stage: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    health_status: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    allocation_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    params: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    meta: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    suspended: Mapped[Optional[bool]] = mapped_column(Boolean, default=False)
    version: Mapped[Optional[int]] = mapped_column(Integer, default=1)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)
    created_at: Mapped[Optional[datetime]] = mapped_column(DateTime, default=_utcnow)

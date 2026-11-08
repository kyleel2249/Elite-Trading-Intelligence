"""Server-side risk inputs for the RiskEngine.

Equity, open positions, daily PnL, drawdown and data freshness used to be accepted
from the HTTP request body (or hard-coded as "fresh"), which let a caller dictate the
very numbers the risk officer is supposed to verify. They are now derived here from
the database and the market snapshot fetched by the server.

Notes / limits:
- Paper/testnet equity = PAPER_STARTING_EQUITY + realized + unrealized PnL.
- Live equity = LIVE_ACCOUNT_EQUITY (no broker account sync exists yet). If it is
  unset, equity is 0 and RiskEngine rejects the order (fail-safe).
- Drawdown is measured against the starting equity (net PnL below zero), a
  conservative approximation until an equity curve is persisted.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import JournalEntry, OrderRecord, Position
from app.trading.portfolio import PortfolioService


@dataclass(frozen=True)
class RiskContext:
    equity: float
    current_open_positions: int
    daily_realized_pnl_pct: float
    current_drawdown_pct: float
    data_age_seconds: Optional[float]
    data_status: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def base_equity(settings: Settings, environment: str) -> float:
    if (environment or "").lower() == "live":
        return float(settings.live_account_equity or 0.0)
    return float(settings.paper_starting_equity)


def snapshot_age_seconds(snapshot: Optional[dict[str, Any]], now: Optional[datetime] = None) -> Optional[float]:
    """Seconds since the quote timestamp, or None if it is missing/unparseable."""
    if not snapshot:
        return None
    raw = snapshot.get("ts_utc")
    if not raw:
        return None
    try:
        ts = raw if isinstance(raw, datetime) else datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    return max(0.0, (current - ts).total_seconds())


def _data_quality(snapshot: Optional[dict[str, Any]]) -> tuple[str, Optional[float]]:
    if not snapshot or snapshot.get("price") is None:
        return "unavailable", snapshot_age_seconds(snapshot)
    return str(snapshot.get("data_status") or "unknown"), snapshot_age_seconds(snapshot)


def _realized_pnl_today(db: Session, environment: str) -> float:
    start_of_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    value = (
        db.query(func.coalesce(func.sum(JournalEntry.pnl), 0.0))
        .filter(
            JournalEntry.environment == environment,
            JournalEntry.event == "closed",
            JournalEntry.created_at >= start_of_day,
        )
        .scalar()
    )
    return float(value or 0.0)


def build_risk_context(
    db: Optional[Session],
    settings: Settings,
    *,
    environment: str,
    snapshot: Optional[dict[str, Any]],
) -> RiskContext:
    env = (environment or "paper").lower()
    start = base_equity(settings, env)

    open_positions = 0
    net_pnl = 0.0
    daily_pnl = 0.0
    if db is not None:
        summary = PortfolioService(db).portfolio_summary(env)
        occupied = {(p.provider, p.symbol) for p in db.query(Position).filter(
            Position.environment == env, Position.status == "open").all()}
        reserved = {(o.provider, o.symbol) for o in db.query(OrderRecord).filter(
            OrderRecord.environment == env,
            OrderRecord.status.in_(["pending", "submitted", "partial", "new"]),
            OrderRecord.risk_approved.is_(True)).all()}
        open_positions = len(occupied | reserved)
        net_pnl = float(summary["net_pnl"])
        daily_pnl = _realized_pnl_today(db, env)

    equity = start + net_pnl if start > 0 else 0.0
    daily_pct = (daily_pnl / equity) * 100.0 if equity > 0 else 0.0
    drawdown_pct = max(0.0, (-net_pnl / start) * 100.0) if start > 0 else 0.0
    status, age = _data_quality(snapshot)

    return RiskContext(
        equity=equity,
        current_open_positions=open_positions,
        daily_realized_pnl_pct=daily_pct,
        current_drawdown_pct=drawdown_pct,
        data_age_seconds=age,
        data_status=status,
    )

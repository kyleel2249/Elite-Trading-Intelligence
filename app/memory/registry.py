"""Shared helper for the strategy registry table (used by memory + adaptive-edge)."""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.memory.models import StrategyRegistry


def get_or_create_registry(
    db: Session,
    strategy_id: str,
    *,
    name: Optional[str] = None,
    family: Optional[str] = None,
) -> StrategyRegistry:
    """Return the registry row for a strategy, creating it (flushed, not committed) if needed."""
    row = db.query(StrategyRegistry).filter(StrategyRegistry.strategy_id == strategy_id).one_or_none()
    if row is not None:
        return row
    from app.knowledge.strategies import STRATEGY_MODULES

    mod = STRATEGY_MODULES.get(strategy_id)
    row = StrategyRegistry(
        strategy_id=strategy_id,
        name=name or (mod.name if mod else strategy_id),
        family=family or "systematic",
        stage="MONITORING",
        health_status="UNDER_VALIDATION",
        allocation_pct=0.0,
        params=None,
        meta={},
        suspended=False,
        version=1,
    )
    db.add(row)
    db.flush()
    return row


def is_suspended(db: Session, strategy_id: str) -> bool:
    row = db.query(StrategyRegistry).filter(StrategyRegistry.strategy_id == strategy_id).one_or_none()
    return bool(row and row.suspended)

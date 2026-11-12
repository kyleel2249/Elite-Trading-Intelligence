"""Backtest memory with train/validation separation and a leakage audit on every run."""
from __future__ import annotations

import math
import uuid
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.memory.models import MemoryBacktest
from app.memory.partition import Partition, VALIDATION_PARTITIONS, audit_split


def _f(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def normalize_result(result: dict[str, Any]) -> dict[str, Any]:
    """Accepts either a BacktestResult dict or a WalkForwardResult dict."""
    if "folds" in result:
        folds = result.get("folds") or []
        return {
            "bars": int(max([f.get("end_index", 0) for f in folds] or [0])),
            "trades": int(sum(int(f.get("trades", 0) or 0) for f in folds)),
            "win_rate": None,
            "total_return_pct": _f(result.get("aggregate_return_pct")),
            "max_drawdown_pct": _f(max([f.get("max_drawdown_pct", 0.0) or 0.0 for f in folds] or [0.0])),
            "kind": "walk_forward",
        }
    wr = result.get("win_rate")
    return {
        "bars": int(result.get("bars", 0) or 0),
        "trades": int(result.get("trades", 0) or 0),
        "win_rate": _f(wr) if wr is not None else None,
        "total_return_pct": _f(result.get("total_return_pct")),
        "max_drawdown_pct": _f(result.get("max_drawdown_pct")),
        "kind": "single_window",
    }


class BacktestMemoryService:
    def __init__(self, db: Session):
        self.db = db

    def record(
        self,
        *,
        strategy_id: str,
        symbol: str,
        provider: str,
        result: dict[str, Any],
        partition: str = "unclassified",
        strategy_version: Optional[int] = None,
        interval: Optional[str] = None,
        data_start: Optional[str] = None,
        data_end: Optional[str] = None,
        training_range: Optional[tuple[Any, Any]] = None,
        evaluation_range: Optional[tuple[Any, Any]] = None,
        embargo_bars: int = 0,
        horizon: int = 0,
        parameters_fitted: bool = True,
        tuned_on_evaluation: bool = False,
        universe_source: str = "unknown",
        fee_bps: Optional[float] = None,
        params: Optional[dict[str, Any]] = None,
    ) -> MemoryBacktest:
        valid_parts = {p.value for p in Partition} - {Partition.LIVE.value}
        if partition not in valid_parts:
            raise ValueError(f"partition must be one of {sorted(valid_parts)}")
        if not (strategy_id or "").strip() or not (symbol or "").strip():
            raise ValueError("strategy_id and symbol are required")
        norm = normalize_result(result)
        audit = audit_split(
            training_range, evaluation_range, embargo_bars=embargo_bars, horizon=horizon,
            parameters_fitted=parameters_fitted, tuned_on_evaluation=tuned_on_evaluation,
            universe_source=universe_source,
        )
        if partition not in VALIDATION_PARTITIONS:
            audit["failures"] = [*audit["failures"], f"partition_{partition}_is_not_validation_evidence"]
            audit["passed"] = False
        row = MemoryBacktest(
            run_id=f"bt-{uuid.uuid4().hex[:20]}", strategy_id=strategy_id.strip(), strategy_version=strategy_version,
            symbol=symbol.strip().upper(), provider=(provider or "").strip().lower(), interval=interval,
            bars=norm["bars"], data_start=data_start, data_end=data_end, partition=partition,
            trades=norm["trades"], win_rate=norm["win_rate"], total_return_pct=norm["total_return_pct"],
            max_drawdown_pct=norm["max_drawdown_pct"], fee_bps=fee_bps, params=params or {},
            result=result, leakage_audit=audit,
            validation_eligible=bool(audit["passed"] and partition in VALIDATION_PARTITIONS),
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def get(self, run_id: str) -> Optional[MemoryBacktest]:
        return self.db.query(MemoryBacktest).filter(MemoryBacktest.run_id == run_id).one_or_none()

    def list(
        self,
        *,
        strategy_id: Optional[str] = None,
        symbol: Optional[str] = None,
        partition: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemoryBacktest]:
        q = self.db.query(MemoryBacktest)
        if strategy_id:
            q = q.filter(MemoryBacktest.strategy_id == strategy_id)
        if symbol:
            q = q.filter(MemoryBacktest.symbol == symbol.strip().upper())
        if partition:
            q = q.filter(MemoryBacktest.partition == partition)
        return q.order_by(MemoryBacktest.created_at.desc()).offset(max(0, offset)).limit(max(1, min(limit, 500))).all()

    def latest_validation(self, strategy_id: str) -> Optional[MemoryBacktest]:
        return (
            self.db.query(MemoryBacktest)
            .filter(MemoryBacktest.strategy_id == strategy_id, MemoryBacktest.validation_eligible.is_(True))
            .order_by(MemoryBacktest.created_at.desc())
            .first()
        )

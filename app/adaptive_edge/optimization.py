"""Adaptive Parameter Optimization within validated bounds."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Optional
import itertools


@dataclass
class ParameterChange:
    strategy_id: str
    parameter: str
    previous: Any
    new: Any
    reason: str
    evidence: list[str]
    validation: dict[str, Any]
    expected_benefit: str
    rollback_conditions: list[str]
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ParameterOptimizer:
    """
    Bounded grid / sensitivity search. No future data. Prefer stable params.
    """

    BOUNDS = {
        "lookback": (10, 50),
        "vol_mult": (1.0, 3.0),
        "exit_bars": (5, 30),
        "rsi_low": (20, 40),
        "rsi_high": (60, 80),
        "atr_mult": (1.0, 3.5),
    }

    def optimize_lookback(
        self,
        strategy_id: str,
        current: dict[str, Any],
        closes: list[float],
        score_fn,
    ) -> Optional[ParameterChange]:
        """Try a small grid on lookback; keep change only if clearly better on in-sample half."""
        if len(closes) < 40:
            return None
        mid = len(closes) // 2
        train = closes[:mid]
        holdout = closes[mid:]

        base_lb = int(current.get("lookback", 20))
        candidates = [lb for lb in range(10, 45, 5) if abs(lb - base_lb) <= 15]
        best_lb = base_lb
        best_score = score_fn(train, {**current, "lookback": base_lb})
        scores = {}
        for lb in candidates:
            s = score_fn(train, {**current, "lookback": lb})
            scores[lb] = s
            if s > best_score:
                best_score = s
                best_lb = lb

        if best_lb == base_lb:
            return None

        holdout_base = score_fn(holdout, {**current, "lookback": base_lb})
        holdout_new = score_fn(holdout, {**current, "lookback": best_lb})
        if holdout_new < holdout_base * 0.7 and holdout_base > 0:
            return None

        return ParameterChange(
            strategy_id=strategy_id,
            parameter="lookback",
            previous=base_lb,
            new=best_lb,
            reason="grid_search_improved_train_score",
            evidence=[f"train_scores={scores}"],
            validation={"holdout_base": holdout_base, "holdout_new": holdout_new},
            expected_benefit=f"score {best_score:.4f} vs prior on train",
            rollback_conditions=["holdout_performance_drop_gt_30pct", "edge_health_degraded"],
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

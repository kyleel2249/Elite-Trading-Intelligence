"""Adaptive Strategy Selection and Rotation."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Optional


@dataclass
class StrategyAllocationDecision:
    strategy_id: str
    action: str  # maintain | increase | reduce | restrict | observe | suspend | replace
    allocation_pct: float
    reasons: list[str]
    replacement_candidate_id: Optional[str] = None
    param_adjustments: Optional[dict] = None
    timestamp: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AdaptiveStrategySelector:
    """
    Reassess strategies on regime change. Do not abandon on 1–2 losses;
    require statistical evidence. Do not keep demonstrably degraded edges.
    """

    MIN_SAMPLE_TO_SUSPEND = 15

    def decide(
        self,
        strategy_id: str,
        edge_status: str,
        sample_size: int,
        regime_suitability: float,
        expected_value: Optional[float],
        correlation_with_active: float = 0.0,
        current_allocation_pct: float = 0.0,
        replacement_candidate_id: Optional[str] = None,
        block_increase: bool = False,
    ) -> StrategyAllocationDecision:
        reasons: list[str] = []
        action = "maintain"
        alloc = current_allocation_pct
        ts = datetime.now(timezone.utc).isoformat()

        if edge_status in ("BROKEN", "DEGRADED") and sample_size >= self.MIN_SAMPLE_TO_SUSPEND:
            action = "suspend"
            alloc = 0.0
            reasons.append(f"edge_status_{edge_status}_sample_{sample_size}")
            if replacement_candidate_id:
                action = "replace"
                reasons.append(f"validated_replacement_{replacement_candidate_id}")
        elif edge_status == "WEAKENING":
            action = "reduce"
            alloc = max(0.0, current_allocation_pct * 0.5)
            reasons.append("weakening_edge_reduce_exposure")
            if regime_suitability < 0.35:
                action = "observe"
                reasons.append("low_regime_suitability")
        elif edge_status in ("HEALTHY", "EXCEPTIONAL") and regime_suitability >= 0.55:
            if block_increase:
                # Rule 14: risk is never raised automatically after losses; it can only be held or reduced.
                action = "maintain"
                reasons.append("increase_blocked_after_recent_losses")
            elif expected_value and expected_value > 0 and correlation_with_active < 0.7:
                action = "increase"
                alloc = min(6.0, max(current_allocation_pct, 1.0) * 1.25)
                reasons.append("healthy_edge_compatible_regime")
            else:
                action = "maintain"
                reasons.append("healthy_maintain")
        elif edge_status == "SUSPENDED":
            action = "suspend"
            alloc = 0.0
            reasons.append("already_suspended")
        elif edge_status == "UNDER_VALIDATION":
            action = "observe"
            alloc = 0.0
            reasons.append("not_yet_validated")
        else:
            action = "maintain"
            reasons.append("default_maintain")

        if correlation_with_active > 0.85 and action in ("increase", "maintain") and current_allocation_pct > 0:
            action = "reduce"
            alloc = current_allocation_pct * 0.6
            reasons.append("high_correlation_with_active_book")

        return StrategyAllocationDecision(
            strategy_id=strategy_id,
            action=action,
            allocation_pct=round(alloc, 4),
            reasons=reasons,
            replacement_candidate_id=replacement_candidate_id if action == "replace" else None,
            timestamp=ts,
        )

"""Autonomous Portfolio Adaptation — recommendations only; orders still risk-gated."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

# Hard constraint mirrored from product rules
MAX_INDIVIDUAL_POSITION_PCT = 6.0


@dataclass
class PortfolioAdaptationPlan:
    plan_id: str
    trigger: str
    actions: list[dict[str, Any]]
    target_cash_pct: float
    notes: list[str]
    requires_risk_checks: bool
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PortfolioAdaptationEngine:
    """
    Propose reallocations when regimes/edges change.
    Holding cash is acceptable. Never exceed 6% single-name.
    Does not place orders — every order must pass the in-process risk engine.
    """

    def plan(
        self,
        trigger: str,
        strategy_decisions: list[dict[str, Any]],
        current_drawdown_pct: float = 0.0,
        change_severity: Optional[str] = None,
    ) -> PortfolioAdaptationPlan:
        actions: list[dict[str, Any]] = []
        notes: list[str] = []
        cash = 0.0
        ts = datetime.now(timezone.utc).isoformat()
        plan_id = f"padapt_{ts.replace(':', '').replace('-', '')[:15]}"

        for d in strategy_decisions:
            action = d.get("action")
            sid = d.get("strategy_id")
            alloc = min(float(d.get("allocation_pct") or 0), MAX_INDIVIDUAL_POSITION_PCT)
            if action in ("suspend", "replace"):
                actions.append({
                    "type": "suspend_strategy",
                    "strategy_id": sid,
                    "allocation_pct": 0.0,
                    "replacement": d.get("replacement_candidate_id"),
                })
                cash += float(d.get("allocation_pct") or 0)
                notes.append(f"suspend_{sid}")
            elif action == "reduce":
                actions.append({
                    "type": "reduce_allocation",
                    "strategy_id": sid,
                    "allocation_pct": alloc,
                })
                notes.append(f"reduce_{sid}_to_{alloc}")
            elif action == "increase":
                actions.append({
                    "type": "increase_allocation",
                    "strategy_id": sid,
                    "allocation_pct": alloc,
                })
                notes.append(f"increase_{sid}_to_{alloc}")
            elif action == "observe":
                actions.append({"type": "observe", "strategy_id": sid, "allocation_pct": 0.0})

        if change_severity in ("MARKET_EMERGENCY", "MAJOR_REGIME_TRANSITION"):
            actions.append({"type": "raise_cash", "target_cash_pct_delta": 15.0})
            cash = max(cash, 15.0)
            notes.append("defensive_cash_raise")
            actions.append({"type": "reassess_open_positions", "detail": "mark_stops_recalc_kelly"})

        if current_drawdown_pct >= 8.0:
            actions.append({"type": "drawdown_brake", "current_drawdown_pct": current_drawdown_pct})
            notes.append("approaching_portfolio_drawdown_limit")

        actions.append({
            "type": "constraint",
            "max_individual_position_pct": MAX_INDIVIDUAL_POSITION_PCT,
            "fractional_kelly_default": True,
            "all_orders_require": "the in-process risk engine (RiskEngine) on every order",
        })

        return PortfolioAdaptationPlan(
            plan_id=plan_id,
            trigger=trigger,
            actions=actions,
            target_cash_pct=round(min(100.0, cash), 2),
            notes=notes,
            requires_risk_checks=True,
            timestamp=ts,
        )

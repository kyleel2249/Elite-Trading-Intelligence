"""Strategy Promotion Authority — staged gatekeeping; never auto-live."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from app.adaptive_edge.research_lab import StrategyCandidate


class PromotionStage(str, Enum):
    HYPOTHESIS = "HYPOTHESIS"
    RESEARCH = "RESEARCH"
    DEVELOPMENT = "DEVELOPMENT"
    BACKTESTING = "BACKTESTING"
    WALK_FORWARD_VALIDATION = "WALK_FORWARD_VALIDATION"
    OUT_OF_SAMPLE_VALIDATION = "OUT_OF_SAMPLE_VALIDATION"
    PAPER_TRADING = "PAPER_TRADING"
    LIMITED_APPROVED_DEPLOYMENT = "LIMITED_APPROVED_DEPLOYMENT"
    PRODUCTION = "PRODUCTION"
    MONITORING = "MONITORING"
    REJECTED = "REJECTED"
    SUSPENDED = "SUSPENDED"


AUTONOMOUS_MAX_STAGE = PromotionStage.PAPER_TRADING

LIVE_STAGES = {
    PromotionStage.LIMITED_APPROVED_DEPLOYMENT,
    PromotionStage.PRODUCTION,
}


@dataclass
class PromotionDecision:
    candidate_id: str
    from_stage: str
    to_stage: str
    approved: bool
    reasons: list[str]
    requires_user_authorization: bool
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class StrategyPromotionAuthority:
    """
    Independent gate. May advance candidates through research → paper.
    Live deployment always requires external authorization and the in-process risk engine.
    """

    MIN_OOS_TRADES = 5
    MIN_PAPER_TRADES = 10
    MIN_PROFIT_FACTOR = 1.15
    MAX_DRAWDOWN_PCT = 30.0

    def evaluate_progression(self, candidate: StrategyCandidate) -> PromotionDecision:
        stage = candidate.stage
        reasons: list[str] = []
        ts = datetime.now(timezone.utc).isoformat()

        if stage == "REJECTED":
            return PromotionDecision(candidate.candidate_id, stage, "REJECTED", False, candidate.rejection_reasons or ["already_rejected"], False, ts)

        if stage == PromotionStage.OUT_OF_SAMPLE_VALIDATION.value:
            oos = candidate.oos_metrics or {}
            trades = oos.get("trades") or 0
            pf = oos.get("profit_factor") or 0
            mdd = oos.get("max_drawdown_pct") or 100
            ret = oos.get("total_return_pct") or 0
            if trades < self.MIN_OOS_TRADES:
                reasons.append(f"oos_trades_{trades}_lt_{self.MIN_OOS_TRADES}")
            if pf < self.MIN_PROFIT_FACTOR:
                reasons.append(f"oos_pf_{pf}_lt_{self.MIN_PROFIT_FACTOR}")
            if mdd > self.MAX_DRAWDOWN_PCT:
                reasons.append(f"oos_mdd_{mdd}_gt_{self.MAX_DRAWDOWN_PCT}")
            if ret <= 0:
                reasons.append("oos_non_positive_return")
            if reasons:
                return PromotionDecision(candidate.candidate_id, stage, "REJECTED", False, reasons, False, ts)
            return PromotionDecision(candidate.candidate_id, stage, PromotionStage.PAPER_TRADING.value, True, ["oos_passed"], False, ts)

        if stage == PromotionStage.PAPER_TRADING.value:
            paper = candidate.paper_metrics or {}
            trades = paper.get("trades") or 0
            if trades < self.MIN_PAPER_TRADES:
                return PromotionDecision(
                    candidate.candidate_id, stage, stage, False,
                    [f"paper_observation_incomplete_trades_{trades}"], False, ts,
                )
            pf = paper.get("profit_factor") or 0
            if pf >= self.MIN_PROFIT_FACTOR and (paper.get("total_return_pct") or 0) > 0:
                return PromotionDecision(
                    candidate.candidate_id, stage,
                    PromotionStage.LIMITED_APPROVED_DEPLOYMENT.value,
                    True,
                    ["paper_passed_recommend_limited_deploy"],
                    True,
                    ts,
                )
            return PromotionDecision(candidate.candidate_id, stage, "REJECTED", False, ["paper_failed_metrics"], False, ts)

        if stage in (s.value for s in LIVE_STAGES):
            return PromotionDecision(
                candidate.candidate_id, stage, stage, False,
                ["live_stages_require_explicit_user_authorization_and_risk_checks"],
                True, ts,
            )

        order = [
            "DEVELOPMENT", "BACKTESTING", "WALK_FORWARD_VALIDATION",
            "OUT_OF_SAMPLE_VALIDATION", "PAPER_TRADING",
        ]
        if stage in order:
            idx = order.index(stage)
            if idx + 1 < len(order):
                return PromotionDecision(candidate.candidate_id, stage, order[idx + 1], True, ["lab_stage_advance"], False, ts)

        return PromotionDecision(candidate.candidate_id, stage, stage, False, ["no_progression_rule"], False, ts)

    def can_authorize_live(self) -> bool:
        """Hard governance: this authority cannot authorize live deployment."""
        return False

"""Strategy Research Lab - candidate strategies moving through staged validation.

Candidates are persisted as ``candidate_state`` events in the adaptive knowledge base (latest event
per candidate wins), so the lab survives restarts. The lab never advances a candidate into a live
stage: ``StrategyPromotionAuthority`` caps autonomous progress at PAPER_TRADING.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Optional

PHASE_FIELDS = {
    "in_sample": "in_sample_metrics",
    "walk_forward": "wf_metrics",
    "oos": "oos_metrics",
    "paper": "paper_metrics",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class StrategyCandidate:
    candidate_id: str
    name: str
    family: str = "general"
    hypothesis_id: Optional[str] = None
    stage: str = "HYPOTHESIS"
    params: dict[str, Any] = field(default_factory=dict)
    in_sample_metrics: dict[str, Any] = field(default_factory=dict)
    wf_metrics: dict[str, Any] = field(default_factory=dict)
    oos_metrics: dict[str, Any] = field(default_factory=dict)
    paper_metrics: dict[str, Any] = field(default_factory=dict)
    rejection_reasons: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "StrategyCandidate":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


class StrategyResearchLab:
    EVENT_TYPE = "candidate_state"

    def __init__(self, db: Any = None):
        self.db = db
        self._mem: dict[str, StrategyCandidate] = {}

    def _persist(self, c: StrategyCandidate) -> None:
        c.updated_at = _now()
        if self.db is None:
            self._mem[c.candidate_id] = c
            return
        from app.adaptive_edge.knowledge_base import AdaptiveKnowledgeBase

        AdaptiveKnowledgeBase(self.db).record(self.EVENT_TYPE, c.candidate_id, c.to_dict(), tags=[c.stage, c.family])

    def create_candidate(
        self,
        hypothesis: Any,
        name: Optional[str] = None,
        family: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
    ) -> StrategyCandidate:
        """Create a candidate from a ResearchHypothesis (or an equivalent dict)."""
        h = hypothesis.to_dict() if hasattr(hypothesis, "to_dict") else dict(hypothesis or {})
        c = StrategyCandidate(
            candidate_id=f"cand_{uuid.uuid4().hex[:12]}",
            name=name or h.get("title") or "unnamed candidate",
            family=family or h.get("category") or "general",
            hypothesis_id=h.get("hypothesis_id"),
            stage="HYPOTHESIS",
            params=dict(params or {}),
            notes=[f"claim: {h.get('measurable_claim')}"] if h.get("measurable_claim") else [],
            created_at=_now(),
        )
        self._persist(c)
        return c

    def get(self, candidate_id: str) -> Optional[StrategyCandidate]:
        if self.db is None:
            return self._mem.get(candidate_id)
        from app.memory.models import AdaptiveEdgeEvent

        row = (
            self.db.query(AdaptiveEdgeEvent)
            .filter(AdaptiveEdgeEvent.event_type == self.EVENT_TYPE, AdaptiveEdgeEvent.ref_id == candidate_id)
            .order_by(AdaptiveEdgeEvent.id.desc())
            .first()
        )
        return StrategyCandidate.from_dict(row.payload or {}) if row else None

    def list(self, limit: int = 50) -> list[StrategyCandidate]:
        if self.db is None:
            return list(self._mem.values())[:limit]
        from app.memory.models import AdaptiveEdgeEvent

        rows = (
            self.db.query(AdaptiveEdgeEvent)
            .filter(AdaptiveEdgeEvent.event_type == self.EVENT_TYPE)
            .order_by(AdaptiveEdgeEvent.id.desc())
            .limit(max(limit * 5, 50))
            .all()
        )
        seen: dict[str, StrategyCandidate] = {}
        for r in rows:
            if r.ref_id not in seen:
                seen[r.ref_id] = StrategyCandidate.from_dict(r.payload or {})
        return list(seen.values())[:limit]

    def record_metrics(self, candidate_id: str, phase: str, metrics: dict[str, Any]) -> StrategyCandidate:
        if phase not in PHASE_FIELDS:
            raise ValueError(f"phase must be one of {sorted(PHASE_FIELDS)}")
        c = self.get(candidate_id)
        if c is None:
            raise LookupError("candidate not found")
        setattr(c, PHASE_FIELDS[phase], dict(metrics))
        self._persist(c)
        return c

    def advance(self, candidate_id: str) -> Any:
        """Ask the promotion authority for the next stage. Live stages are never entered here."""
        from app.adaptive_edge.promotion import LIVE_STAGES, PromotionDecision, StrategyPromotionAuthority

        c = self.get(candidate_id)
        if c is None:
            raise LookupError("candidate not found")
        ts = _now()
        if c.stage == "HYPOTHESIS":
            decision = PromotionDecision(c.candidate_id, c.stage, "RESEARCH", True, ["hypothesis_registered"], False, ts)
        elif c.stage == "RESEARCH":
            ok = bool(c.hypothesis_id or c.notes)
            decision = PromotionDecision(
                c.candidate_id, c.stage, "DEVELOPMENT" if ok else c.stage, ok,
                ["measurable_claim_defined"] if ok else ["no_measurable_claim"], False, ts,
            )
        else:
            decision = StrategyPromotionAuthority().evaluate_progression(c)

        live_values = {s.value for s in LIVE_STAGES}
        if decision.to_stage in live_values:
            c.notes = [*c.notes, "awaiting explicit user authorization and risk-gateway; lab does not enter live stages"]
        elif decision.to_stage == "REJECTED":
            c.stage = "REJECTED"
            c.rejection_reasons = list(decision.reasons)
            if self.db is not None:
                from app.adaptive_edge.knowledge_base import AdaptiveKnowledgeBase

                AdaptiveKnowledgeBase(self.db).record(
                    "strategy_rejected", c.candidate_id, {"reasons": decision.reasons, "name": c.name}, tags=[c.family],
                )
        elif decision.approved:
            c.stage = decision.to_stage
        self._persist(c)
        return decision

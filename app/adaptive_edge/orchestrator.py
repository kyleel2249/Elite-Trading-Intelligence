"""Adaptive Edge Orchestrator - one monitoring cycle across the whole adaptive-edge stack.

Cycle: regime -> edge health -> change detection -> discovery -> selection -> portfolio plan.

Governance (unchanged from the package contract): the engine may *suspend* strategies and propose
replacements; it cannot authorize live deployment and it places no orders.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.adaptive_edge.change_detection import MarketChangeDetector
from app.adaptive_edge.discovery import EdgeDiscoveryEngine
from app.adaptive_edge.edge_health import EdgeHealthMonitor
from app.adaptive_edge.knowledge_base import AdaptiveKnowledgeBase
from app.adaptive_edge.portfolio_adapt import PortfolioAdaptationEngine
from app.adaptive_edge.regime import MarketRegimeEngine, RegimeSnapshot
from app.adaptive_edge.research_lab import StrategyResearchLab
from app.adaptive_edge.selection import AdaptiveStrategySelector
from app.memory.lessons import PriorityService
from app.memory.models import RegimeObservation, StrategyRegistry
from app.memory.regimes import RegimeMemoryService
from app.memory.registry import get_or_create_registry

DEFENSIVE_SEVERITIES = {"MARKET_EMERGENCY", "MAJOR_REGIME_TRANSITION"}
WEAK_STATUSES = {"WEAKENING", "DEGRADED", "BROKEN"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CycleResult:
    cycle_id: str
    symbol: str
    provider: str
    regime: dict[str, Any]
    change_event: Optional[dict[str, Any]]
    strategy_health: dict[str, dict[str, Any]]
    allocation_decisions: list[dict[str, Any]]
    hypotheses: list[dict[str, Any]]
    portfolio_plan: dict[str, Any]
    defensive: bool
    notes: list[str] = field(default_factory=list)
    started_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AdaptiveEdgeOrchestrator:
    def __init__(self, db: Session):
        self.db = db
        self.kb = AdaptiveKnowledgeBase(db)
        self.regime_engine = MarketRegimeEngine()
        self.health = EdgeHealthMonitor()
        self.discovery = EdgeDiscoveryEngine()
        self.selector = AdaptiveStrategySelector()
        self.portfolio = PortfolioAdaptationEngine()
        self.lab = StrategyResearchLab(db)

    def run_cycle(
        self,
        symbol: str,
        provider: str,
        closes: list[float],
        volumes: Optional[list[float]] = None,
        strategy_trades: Optional[dict[str, list[Any]]] = None,
        strategy_meta: Optional[dict[str, dict[str, Any]]] = None,
    ) -> CycleResult:
        symbol = symbol.upper()
        provider = (provider or "").lower()
        cycle_id = f"cyc_{symbol}_{uuid.uuid4().hex[:8]}"
        started = _now()
        notes: list[str] = []

        # 1. regime (point-in-time series is persisted every cycle)
        regime_mem = RegimeMemoryService(self.db)
        prev_obs = regime_mem.latest_as_of(symbol, provider, max_age_seconds=7 * 86400)
        previous = None
        if prev_obs is not None:
            previous = RegimeSnapshot(
                symbol=symbol, provider=provider, primary_regime=prev_obs.primary_regime, coexisting=[],
                probabilities={}, confidence=prev_obs.confidence or 0.0, evidence=[], strategy_suitability={},
                previous_regime=None, transition_ts=None, metrics={}, assessed_at=_now(),
            )
        snap = self.regime_engine.assess(symbol, provider, closes, volumes, previous=previous)
        regime_mem.record(
            symbol, provider, snap.primary_regime, coexisting=snap.coexisting, confidence=snap.confidence,
            metrics={**snap.metrics, "evidence": snap.evidence}, source="adaptive_cycle",
        )
        if snap.previous_regime and snap.previous_regime != snap.primary_regime:
            self.kb.record(
                "regime_transition", f"{symbol}:{provider}",
                {"from": snap.previous_regime, "to": snap.primary_regime, "confidence": snap.confidence},
                tags=[symbol, snap.primary_regime],
            )
            notes.append(f"regime_transition_{snap.previous_regime}_to_{snap.primary_regime}")

        # 2. edge health per strategy
        reports: dict[str, dict[str, Any]] = {}
        registry: dict[str, StrategyRegistry] = {}
        for sid, samples in (strategy_trades or {}).items():
            reg = get_or_create_registry(self.db, sid, **(strategy_meta or {}).get(sid, {}).get("registry", {}))
            registry[sid] = reg
            rep = self.health.assess(
                sid, samples, current_regime=snap.primary_regime,
                regime_suitability=snap.strategy_suitability.get(sid), previous_status=reg.health_status,
                suspended=bool(reg.suspended),
            )
            reg.health_status = rep.status
            reports[sid] = rep.to_dict()

        # 3. change detection (uses the health flags as corroborating evidence)
        flags = [r["status"] for r in reports.values()]
        change = self.change.detect(
            symbol, closes, volumes, previous_regime=snap.previous_regime, current_regime=snap.primary_regime,
            strategy_health_flags=flags or None,
        ) if hasattr(self, "change") else None
        if change is None:
            change = MarketChangeDetector().detect(
                symbol, closes, volumes, previous_regime=snap.previous_regime, current_regime=snap.primary_regime,
                strategy_health_flags=flags or None,
            )
        change_dict = change.to_dict() if change else None
        if change is not None:
            self.kb.record("change_event", change.event_id, change_dict or {}, tags=[symbol, change.severity])

        # 4. discovery
        weakened = [sid for sid, r in reports.items() if r["status"] in WEAK_STATUSES]
        triggers: list[str] = []
        if change is not None:
            triggers.append(f"change:{change.severity}")
        if snap.previous_regime and snap.previous_regime != snap.primary_regime:
            triggers.append("regime_transition")
        hyps: list[dict[str, Any]] = []
        if triggers or weakened:
            existing = {e["ref_id"] for e in self.kb.list_events(event_type="hypothesis", limit=200)}
            prios = PriorityService(self.db)
            for h in self.discovery.discover(
                triggers or ["edge_weakening"], current_regimes={symbol: snap.primary_regime},
                weakened_strategies=weakened or None, existing_hypothesis_ids=existing,
            ):
                d = h.to_dict()
                hyps.append(d)
                self.kb.record("hypothesis", h.hypothesis_id, d, tags=[h.category])
                prios.upsert_absolute(
                    f"research:hypothesis:{h.hypothesis_id}", "research", h.title, h.priority,
                    rationale={"claim": h.measurable_claim, "triggers": triggers},
                )

        # 5. selection (may suspend; never authorises live deployment)
        decisions: list[dict[str, Any]] = []
        for sid, rep in reports.items():
            reg = registry[sid]
            dec = self.selector.decide(
                sid, rep["status"], rep["sample_size"], snap.strategy_suitability.get(sid, 0.5),
                rep.get("expected_value"), current_allocation_pct=reg.allocation_pct or 0.0,
            )
            d = dec.to_dict()
            decisions.append(d)
            reg.allocation_pct = dec.allocation_pct
            if dec.action in ("suspend", "replace") and not reg.suspended:
                reg.suspended = True
                reg.stage = "SUSPENDED"
                self.kb.record("strategy_suspended", sid, {"reasons": dec.reasons, "cycle": cycle_id}, tags=[sid])
                notes.append(f"suspended_{sid}")
        self.db.commit()

        # 6. portfolio adaptation plan (recommendation only)
        severity = change.severity if change else None
        plan = self.portfolio.plan(
            trigger=triggers[0] if triggers else "scheduled_cycle", strategy_decisions=decisions, change_severity=severity,
        )
        defensive = severity in DEFENSIVE_SEVERITIES
        if defensive:
            notes.append("defensive_mode_recommended")

        result = CycleResult(
            cycle_id=cycle_id, symbol=symbol, provider=provider, regime=snap.to_dict(), change_event=change_dict,
            strategy_health=reports, allocation_decisions=decisions, hypotheses=hyps,
            portfolio_plan=plan.to_dict(), defensive=defensive, notes=notes, started_at=started,
        )
        self.kb.record(
            "cycle", cycle_id,
            {"symbol": symbol, "regime": snap.primary_regime, "severity": severity, "defensive": defensive,
             "strategies": {k: v["status"] for k, v in reports.items()}, "notes": notes},
            tags=[symbol],
        )
        return result

    def dashboard_snapshot(self) -> dict[str, Any]:
        rows = self.db.query(RegimeObservation).order_by(RegimeObservation.as_of.desc()).limit(200).all()
        latest: dict[tuple[str, str], RegimeObservation] = {}
        for r in rows:
            latest.setdefault((r.symbol, r.provider), r)
        prios = PriorityService(self.db).list(limit=10)
        return {
            "regimes": [r.to_dict() for r in latest.values()],
            "strategies": [s.to_dict() for s in self.db.query(StrategyRegistry).order_by(StrategyRegistry.strategy_id).all()],
            "recent_events": self.kb.list_events(limit=20),
            "candidates": [c.to_dict() for c in self.lab.list(10)],
            "top_priorities": [p.to_dict() for p in prios],
            "governance": {
                "suspend_strategies": True, "authorize_live_deployment": False, "orders_require_risk_gateway": True,
            },
            "generated_at": _now(),
        }

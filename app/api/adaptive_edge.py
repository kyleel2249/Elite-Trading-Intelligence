"""Adaptive Edge Discovery & Evolution Engine APIs."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.security.auth import require_api_key
from app.adaptive_edge.orchestrator import AdaptiveEdgeOrchestrator
from app.adaptive_edge.edge_health import TradeSample
from app.adaptive_edge.regime import MarketRegimeEngine
from app.adaptive_edge.change_detection import MarketChangeDetector
from app.adaptive_edge.edge_health import EdgeHealthMonitor
from app.adaptive_edge.discovery import EdgeDiscoveryEngine
from app.adaptive_edge.research_lab import StrategyResearchLab
from app.adaptive_edge.promotion import StrategyPromotionAuthority
from app.adaptive_edge.competition import StrategyCompetitionArena
from app.knowledge.strategies import STRATEGY_MODULES

router = APIRouter(prefix="/api/adaptive-edge", tags=["adaptive-edge"])


class CycleRequest(BaseModel):
    symbol: str = Field(default="BTCUSDT", min_length=2, max_length=32)
    provider: str = Field(default="binance")
    closes: list[float] = Field(default_factory=list)
    volumes: Optional[list[float]] = None
    # Optional simulated strategy trade samples: {strategy_id: [{pnl, win, costs?}]}
    strategy_trades: Optional[dict[str, list[dict[str, Any]]]] = None
    strategy_meta: Optional[dict[str, dict[str, Any]]] = None


class HealthAssessRequest(BaseModel):
    strategy_id: str
    trades: list[dict[str, Any]]
    regime_suitability: Optional[float] = 0.5
    suspended: bool = False
    under_validation: bool = False


class RegimeRequest(BaseModel):
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    closes: list[float]
    volumes: Optional[list[float]] = None


@router.get("/dashboard")
def adaptive_dashboard(db: Session = Depends(get_db)):
    """ETI ADAPTIVE EDGE INTELLIGENCE command-center payload."""
    orch = AdaptiveEdgeOrchestrator(db)
    return orch.dashboard_snapshot()


@router.get("/events")
def list_events(
    event_type: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    orch = AdaptiveEdgeOrchestrator(db)
    return {"events": orch.kb.list_events(event_type=event_type, limit=limit)}


@router.post("/cycle")
async def run_adaptive_cycle(
    body: CycleRequest,
    db: Session = Depends(get_db),
    _auth=Depends(require_api_key),
):
    """
    Run one adaptive cycle: regime → change → health → discovery → lab → selection → portfolio plan.
    Does not place live orders. Live path remains risk-gateway gated.
    """
    closes = body.closes
    if len(closes) < 5:
        # Attempt to fetch history when caller omits series
        try:
            from app.config import get_settings
            from app.market.service import MarketService
            hist = await MarketService(get_settings()).get_history(
                body.provider, body.symbol, interval="1h", limit=120
            )
            closes = [float(b["close"]) for b in (hist or []) if b.get("close") is not None]
        except Exception:
            closes = []
    if len(closes) < 5:
        raise HTTPException(status_code=400, detail="Need closes[] with at least 5 bars or reachable market history")

    trades_map: dict[str, list[TradeSample]] = {}
    if body.strategy_trades:
        for sid, rows in body.strategy_trades.items():
            trades_map[sid] = [
                TradeSample(
                    pnl=float(r.get("pnl", 0)),
                    win=bool(r.get("win", r.get("pnl", 0) > 0)),
                    holding_bars=int(r.get("holding_bars", 0)),
                    costs=float(r.get("costs", 0)),
                    regime=r.get("regime"),
                )
                for r in rows
            ]
    else:
        # Seed from known strategy modules with empty samples → UNDER_VALIDATION
        for mid in list(STRATEGY_MODULES.keys())[:4]:
            trades_map[mid] = []

    orch = AdaptiveEdgeOrchestrator(db)
    result = orch.run_cycle(
        symbol=body.symbol.upper(),
        provider=body.provider,
        closes=closes,
        volumes=body.volumes,
        strategy_trades=trades_map,
        strategy_meta=body.strategy_meta,
    )
    return result.to_dict()


@router.post("/regime")
def assess_regime(body: RegimeRequest):
    engine = MarketRegimeEngine()
    snap = engine.assess(body.symbol, body.provider, body.closes, body.volumes)
    return snap.to_dict()


@router.post("/edge-health")
def assess_edge_health(body: HealthAssessRequest):
    mon = EdgeHealthMonitor()
    samples = [
        TradeSample(
            pnl=float(t.get("pnl", 0)),
            win=bool(t.get("win", t.get("pnl", 0) > 0)),
            holding_bars=int(t.get("holding_bars", 0)),
            costs=float(t.get("costs", 0)),
        )
        for t in body.trades
    ]
    report = mon.assess(
        strategy_id=body.strategy_id,
        trades=samples,
        regime_suitability=body.regime_suitability,
        suspended=body.suspended,
        under_validation=body.under_validation,
    )
    return report.to_dict()


@router.post("/discover")
def discover_hypotheses(
    triggers: list[str] = Query(default=["edge_weakening"]),
    weakened: Optional[list[str]] = Query(default=None),
):
    eng = EdgeDiscoveryEngine()
    hyps = eng.discover(triggers=triggers, weakened_strategies=weakened)
    return {"hypotheses": [h.to_dict() for h in hyps]}


@router.get("/promotion/policy")
def promotion_policy():
    auth = StrategyPromotionAuthority()
    return {
        "autonomous_max_stage": "PAPER_TRADING",
        "live_authorization_by_engine": auth.can_authorize_live(),
        "requires_risk_gateway_for_orders": True,
        "max_individual_position_pct": 6.0,
        "stages": [s.value for s in __import__("app.adaptive_edge.promotion", fromlist=["PromotionStage"]).PromotionStage],
    }


@router.post("/competition/rank")
def competition_rank(entries: list[dict[str, Any]], regime: str = "all"):
    arena = StrategyCompetitionArena()
    ranked = arena.rank(entries, regime=regime)
    return {"leaderboard": [e.to_dict() for e in ranked]}


@router.get("/health")
def adaptive_edge_module_health():
    return {
        "module": "adaptive_edge",
        "status": "ok",
        "capabilities": [
            "regime_detection",
            "change_detection",
            "edge_health",
            "discovery",
            "research_lab",
            "promotion_authority",
            "strategy_selection",
            "portfolio_adaptation",
            "competition_arena",
            "knowledge_base",
        ],
        "governance": {
            "suspend_strategies": True,
            "propose_replacements": True,
            "authorize_live_deployment": False,
            "orders_require_risk_gateway": True,
        },
    }

"""
ETI Autonomous Adaptive Edge Discovery & Evolution Engine.

Independent authority that:
- Detects market regime changes
- Monitors strategy edge health
- Discovers and researches new edges
- Validates candidates through staged promotion
- Recommends portfolio adaptations

Governance: may suspend strategies and propose replacements;
cannot independently authorize live deployment. All live orders
must still pass the in-process risk engine (RiskEngine).
"""
from app.adaptive_edge.regime import MarketRegimeEngine, RegimeSnapshot
from app.adaptive_edge.change_detection import MarketChangeDetector, ChangeEvent
from app.adaptive_edge.edge_health import EdgeHealthMonitor, EdgeHealthReport
from app.adaptive_edge.discovery import EdgeDiscoveryEngine, ResearchHypothesis
from app.adaptive_edge.research_lab import StrategyResearchLab, StrategyCandidate
from app.adaptive_edge.selection import AdaptiveStrategySelector
from app.adaptive_edge.optimization import ParameterOptimizer
from app.adaptive_edge.promotion import StrategyPromotionAuthority, PromotionStage
from app.adaptive_edge.portfolio_adapt import PortfolioAdaptationEngine
from app.adaptive_edge.competition import StrategyCompetitionArena
from app.adaptive_edge.knowledge_base import AdaptiveKnowledgeBase
from app.adaptive_edge.orchestrator import AdaptiveEdgeOrchestrator

__all__ = [
    "MarketRegimeEngine",
    "RegimeSnapshot",
    "MarketChangeDetector",
    "ChangeEvent",
    "EdgeHealthMonitor",
    "EdgeHealthReport",
    "EdgeDiscoveryEngine",
    "ResearchHypothesis",
    "StrategyResearchLab",
    "StrategyCandidate",
    "AdaptiveStrategySelector",
    "ParameterOptimizer",
    "StrategyPromotionAuthority",
    "PromotionStage",
    "PortfolioAdaptationEngine",
    "StrategyCompetitionArena",
    "AdaptiveKnowledgeBase",
    "AdaptiveEdgeOrchestrator",
]

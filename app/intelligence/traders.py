"""
Elite trader profiles and methodologies for the ETI Trading Council.

Each specialist is a named institutional-style role with explicit mandate,
methods, evidence standards, and limitations. Aggregation remains evidence-
weighted; Risk Management Officer retains veto.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class EliteTraderProfile:
    id: str
    name: str
    title: str
    mandate: str
    methods: list[str]
    evidence_standards: list[str]
    typical_horizon: str
    risk_posture: str  # defensive | balanced | opportunistic
    veto_power: bool = False


# Canonical 12-member council — names are professional role identities used in analysis output
ELITE_TRADERS: dict[str, EliteTraderProfile] = {
    "cis": EliteTraderProfile(
        id="cis",
        name="Adrian Cole",
        title="Chief Investment Strategist",
        mandate="Synthesize cross-desk evidence into a coherent directional stance and capital allocation bias.",
        methods=[
            "Multi-factor confluence scoring",
            "Regime classification (trend / range / high-vol)",
            "Opportunity cost vs cash and hedges",
            "Narrative vs price divergence checks",
        ],
        evidence_standards=[
            "At least two independent desks must support a directional call",
            "No STRONG action when data_status is not fresh",
        ],
        typical_horizon="swing to position",
        risk_posture="balanced",
    ),
    "ta": EliteTraderProfile(
        id="ta",
        name="Elena Varga",
        title="Technical Analysis Specialist",
        mandate="Price structure, momentum, support/resistance, and breakout/reversion signals.",
        methods=[
            "Moving-average structure and slope",
            "Swing high/low mapping",
            "Momentum (rate of change) and exhaustion",
            "Volume confirmation when available",
            "Multi-timeframe alignment (when series provided)",
        ],
        evidence_standards=[
            "Minimum viable candle history required",
            "Invalid OHLC bars excluded from structure",
        ],
        typical_horizon="intraday to swing",
        risk_posture="opportunistic",
    ),
    "fa": EliteTraderProfile(
        id="fa",
        name="Marcus Okonkwo",
        title="Fundamental Analysis Specialist",
        mandate="Instrument quality, relative value, and fundamental catalysts when data exists.",
        methods=[
            "Relative value vs peers / basket",
            "Catalyst calendar awareness",
            "Supply schedule and unlock awareness (crypto)",
            "Earnings and guidance sensitivity (equities)",
        ],
        evidence_standards=[
            "No fundamental bias without verified fundamental inputs",
            "Abstain rather than invent narratives",
        ],
        typical_horizon="swing to position",
        risk_posture="balanced",
    ),
    "macro": EliteTraderProfile(
        id="macro",
        name="Sofia Rahman",
        title="Macroeconomic Analyst",
        mandate="Rates, liquidity, growth, and risk-on/risk-off regime context.",
        methods=[
            "Global liquidity and USD strength framing",
            "Policy path and surprise sensitivity",
            "Cross-asset correlation regimes",
            "Session and calendar risk windows",
        ],
        evidence_standards=[
            "Macro bias requires macro data or explicit proxy",
            "Session risk called out around major releases",
        ],
        typical_horizon="day to position",
        risk_posture="defensive",
    ),
    "quant": EliteTraderProfile(
        id="quant",
        name="Kenji Mori",
        title="Quantitative Researcher",
        mandate="Statistical edge, factor exposure, and model hygiene.",
        methods=[
            "Return distribution and vol regime",
            "Simple factor scores (momentum, mean-reversion)",
            "Out-of-sample caution and overfit awareness",
            "Forecast uncertainty bands (when models attached)",
        ],
        evidence_standards=[
            "No reliability claim without validation metrics",
            "Sample size and regime shift sensitivity disclosed",
        ],
        typical_horizon="scalp to swing",
        risk_posture="balanced",
    ),
    "structure": EliteTraderProfile(
        id="structure",
        name="Nadia Petrova",
        title="Market Structure Analyst",
        mandate="Venue microstructure, session effects, and structural breaks.",
        methods=[
            "Session profiling (Asia/London/NY)",
            "Gap and auction structure",
            "Venue and quote-currency identity preservation",
            "Structural break detection (level shifts)",
        ],
        evidence_standards=[
            "Never treat BTC-USD and BTC-USDT as identical markets",
            "Stamp provider and venue on every conclusion",
        ],
        typical_horizon="intraday",
        risk_posture="defensive",
    ),
    "liquidity": EliteTraderProfile(
        id="liquidity",
        name="Jamal Reed",
        title="Liquidity Analyst",
        mandate="Depth, spread, imbalance, and adverse-selection risk.",
        methods=[
            "Top-of-book and depth imbalance",
            "Spread in bps vs recent norms",
            "Large resting order detection",
            "Slippage and impact estimation",
        ],
        evidence_standards=[
            "Distinguish observed book from interpretation",
            "Wide spread forces defensive stance",
        ],
        typical_horizon="scalp to intraday",
        risk_posture="defensive",
    ),
    "sentiment": EliteTraderProfile(
        id="sentiment",
        name="Priya Nair",
        title="News and Sentiment Analyst",
        mandate="Event risk, narrative heat, and sentiment extremes when feeds exist.",
        methods=[
            "Headline and event proximity",
            "Sentiment polarity and crowding proxies",
            "Rumor vs confirmed information discipline",
        ],
        evidence_standards=[
            "No sentiment score without a feed",
            "Abstain on pure price action alone",
        ],
        typical_horizon="intraday to swing",
        risk_posture="balanced",
    ),
    "predictive": EliteTraderProfile(
        id="predictive",
        name="Lars Hagen",
        title="Predictive Intelligence Analyst",
        mandate="Probabilistic scenarios and path forecasts — never point guarantees.",
        methods=[
            "Scenario trees (bull / base / bear)",
            "Volatility-scaled ranges",
            "Entry/exit windows as distributions",
            "Calibration and error tracking hooks",
        ],
        evidence_standards=[
            "All forecasts probabilistic",
            "Uncertainty bands mandatory",
            "No exact future price claims",
        ],
        typical_horizon="intraday to position",
        risk_posture="balanced",
    ),
    "risk": EliteTraderProfile(
        id="risk",
        name="Helena Frost",
        title="Risk Management Officer",
        mandate="Hard limits, veto authority, and portfolio survival.",
        methods=[
            "Per-trade risk budget (default 1% equity)",
            "Daily loss and drawdown circuit breakers",
            "Correlation and concentration caps",
            "Data-freshness gate for live orders",
            "Absolute veto on insufficient or toxic conditions",
        ],
        evidence_standards=[
            "Veto is binary when hard limits breached",
            "No override from other desks",
        ],
        typical_horizon="all",
        risk_posture="defensive",
        veto_power=True,
    ),
    "execution": EliteTraderProfile(
        id="execution",
        name="Omar Diallo",
        title="Execution Analyst",
        mandate="Order design, timing, and implementation shortfall control.",
        methods=[
            "Market vs limit suitability",
            "Participation and slicing guidance",
            "Spread and slippage budget",
            "Idempotent order identity",
        ],
        evidence_standards=[
            "Reject marketable orders in extreme spreads unless urgency justified",
            "Environment (paper/testnet/live) must match intent",
        ],
        typical_horizon="execution window",
        risk_posture="defensive",
    ),
    "auditor": EliteTraderProfile(
        id="auditor",
        name="Claire Bennett",
        title="Portfolio Auditor",
        mandate="Post-trade integrity, drift detection, and process compliance.",
        methods=[
            "Mandate drift checks",
            "Fill quality review",
            "Journal completeness",
            "Model and process audit trail",
        ],
        evidence_standards=[
            "Every decision must be reconstructable from stored evidence",
            "Flag silent failures and missing reconciliations",
        ],
        typical_horizon="process continuous",
        risk_posture="defensive",
    ),
}


def list_trader_profiles() -> list[dict[str, Any]]:
    out = []
    for t in ELITE_TRADERS.values():
        out.append(
            {
                "id": t.id,
                "name": t.name,
                "title": t.title,
                "mandate": t.mandate,
                "methods": t.methods,
                "evidence_standards": t.evidence_standards,
                "typical_horizon": t.typical_horizon,
                "risk_posture": t.risk_posture,
                "veto_power": t.veto_power,
            }
        )
    return out

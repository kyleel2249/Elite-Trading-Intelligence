"""Opportunity ranking & conviction. A high score never hides a hard failure."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

DEFAULT_WEIGHTS = {
    "fair_value_discrepancy": 0.20, "fundamental_quality": 0.15, "sentiment": 0.10,
    "technical_confirmation": 0.10, "institutional_activity": 0.10, "liquidity_execution": 0.10,
    "momentum_structure": 0.10, "risk_downside": 0.10, "data_model_reliability": 0.05,
}
# Overrides by asset class / regime (normalised to sum to 1.0).
WEIGHT_PROFILES: dict[str, dict[str, float]] = {
    "default": DEFAULT_WEIGHTS,
    "crypto": {**DEFAULT_WEIGHTS, "fundamental_quality": 0.10, "technical_confirmation": 0.12,
               "momentum_structure": 0.13},
    "high_volatility": {**DEFAULT_WEIGHTS, "risk_downside": 0.15, "momentum_structure": 0.05},
}


def get_weights(asset_class: str = "default", regime: Optional[str] = None) -> dict[str, float]:
    w = dict(WEIGHT_PROFILES.get(regime or "", WEIGHT_PROFILES.get(asset_class, DEFAULT_WEIGHTS)))
    total = sum(w.values())
    return {k: v / total for k, v in w.items()}


@dataclass
class OpportunityInput:
    symbol: str
    components: dict[str, float]          # each 0-100; missing => 0 (not neutral)
    mispricing_pct: Optional[float] = None
    mispricing_confirmed: bool = False
    asset_class: str = "default"
    regime: Optional[str] = None
    engine_votes: dict[str, str] = field(default_factory=dict)   # engine -> bullish|bearish|neutral
    hard_failures: list[str] = field(default_factory=list)       # stale data, risk veto, illiquid ...
    invalidated: bool = False


@dataclass
class OpportunityResult:
    symbol: str
    score: float
    classification: str
    conflict: bool
    conviction: str
    reasons: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


def detect_conflict(votes: dict[str, str]) -> bool:
    vs = [v for v in votes.values() if v in ("bullish", "bearish")]
    return "bullish" in vs and "bearish" in vs


def rank(inp: OpportunityInput) -> OpportunityResult:
    w = get_weights(inp.asset_class, inp.regime)
    score = sum(w[k] * max(0.0, min(100.0, inp.components.get(k, 0.0))) for k in w)
    reasons: list[str] = []
    conflict = detect_conflict(inp.engine_votes)
    if conflict:
        score *= 0.75
        reasons.append("engines disagree: conviction lowered")

    if inp.invalidated:
        return OpportunityResult(inp.symbol, round(score, 2), "INVALIDATED", conflict, "none", ["invalidated"])
    if inp.hard_failures:
        return OpportunityResult(inp.symbol, round(score, 2), "REJECTED", conflict, "none",
                                 [f"hard failure: {f}" for f in inp.hard_failures])

    mp = inp.mispricing_pct
    direction = None if mp is None else ("buy" if mp > 0 else "sell")
    flagged = mp is not None and abs(mp) > 8.0 and inp.mispricing_confirmed
    bull = sum(1 for v in inp.engine_votes.values() if v == "bullish")
    bear = sum(1 for v in inp.engine_votes.values() if v == "bearish")

    if conflict and abs(bull - bear) <= 1 and (bull + bear) >= 4:
        cls, conv = "WATCHLIST", "low"
        reasons.append("balanced bull/bear evidence")
    elif flagged and score >= 75 and not conflict:
        cls, conv = "HIGH-CONVICTION", "high"
    elif flagged and score >= 60:
        cls, conv = ("BUY CANDIDATE" if direction == "buy" else "SELL CANDIDATE"), "medium"
    elif mp is not None and abs(mp) > 8.0:
        cls, conv = "MISPRICED ABOVE 8%", "low"
        reasons.append("mispricing not yet verified")
    elif mp is not None and abs(mp) >= 5.0:
        cls, conv = "DEVELOPING", "low"
    elif score >= 50:
        cls, conv = "WATCHLIST", "low"
    else:
        cls, conv = "HOLD", "none"
    return OpportunityResult(inp.symbol, round(score, 2), cls, conflict, conv, reasons)

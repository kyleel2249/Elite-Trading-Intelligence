"""Mispricing detection.

Mispricing % = (Fair Value - Market Price) / Fair Value * 100
  > 0  market below fair value (undervalued)
  < 0  market above fair value (overvalued)

A flag is research evidence, never a trade instruction.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Optional

FLAG_THRESHOLD_PCT = 8.0  # strictly above


def mispricing_pct(fair_value: float, market_price: float) -> Optional[float]:
    if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (fair_value, market_price)):
        return None
    if fair_value <= 0 or market_price <= 0:
        return None
    return (fair_value - market_price) / fair_value * 100.0


def classify_band(abs_pct: float) -> str:
    if abs_pct > 20:
        return "exceptional"       # heightened verification
    if abs_pct > 12:
        return "significant"
    if abs_pct > FLAG_THRESHOLD_PCT:
        return "material"
    if abs_pct >= 5:
        return "developing"
    if abs_pct >= 3:
        return "minor"
    return "insignificant"


@dataclass
class VerificationEvidence:
    """None = not verified (treated as a failure: fail closed)."""
    price_fresh: Optional[bool] = None
    inputs_complete: Optional[bool] = None
    model_appropriate: Optional[bool] = None
    corporate_action_or_data_error: Optional[bool] = None   # True = problem
    liquidity_adequate: Optional[bool] = None
    round_trip_cost_pct: Optional[float] = None
    fundamental_deterioration: Optional[bool] = None        # True = problem
    unresolved_event_risk: Optional[bool] = None            # True = problem
    independent_models_agree: Optional[bool] = None
    convergence_horizon_days: Optional[float] = None
    max_convergence_days: float = 180.0


@dataclass
class MispricingResult:
    symbol: str
    market_price: float
    fair_value: float
    mispricing_pct: Optional[float]
    abs_mispricing_pct: float = 0.0
    band: str = "invalid"
    direction: str = "none"          # undervalued | overvalued | none
    flagged: bool = False            # |mispricing| > 8%
    confirmed: bool = False          # flagged AND all verification passed
    needs_heightened_verification: bool = False
    failed_checks: list[str] = field(default_factory=list)
    unverified_checks: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def evaluate_mispricing(symbol: str, fair_value: float, market_price: float,
                        evidence: Optional[VerificationEvidence] = None) -> MispricingResult:
    pct = mispricing_pct(fair_value, market_price)
    if pct is None:
        return MispricingResult(symbol, market_price, fair_value, None,
                                failed_checks=["invalid_price_or_fair_value"])
    a = abs(pct)
    res = MispricingResult(
        symbol=symbol, market_price=market_price, fair_value=fair_value,
        mispricing_pct=pct, abs_mispricing_pct=a, band=classify_band(a),
        direction="undervalued" if pct > 0 else ("overvalued" if pct < 0 else "none"),
        flagged=a > FLAG_THRESHOLD_PCT,
        needs_heightened_verification=a > 20,
    )
    if not res.flagged:
        return res

    ev = evidence or VerificationEvidence()
    failed, unverified = [], []

    def need_true(name, val):
        if val is None:
            unverified.append(name)
        elif not val:
            failed.append(name)

    def need_false(name, val):
        if val is None:
            unverified.append(name)
        elif val:
            failed.append(name)

    need_true("price_fresh", ev.price_fresh)
    need_true("inputs_complete", ev.inputs_complete)
    need_true("model_appropriate", ev.model_appropriate)
    need_false("corporate_action_or_data_error", ev.corporate_action_or_data_error)
    need_true("liquidity_adequate", ev.liquidity_adequate)
    if ev.round_trip_cost_pct is None:
        unverified.append("transaction_costs")
    elif ev.round_trip_cost_pct >= a:
        failed.append("transaction_costs_eliminate_edge")
    need_false("fundamental_deterioration", ev.fundamental_deterioration)
    need_false("unresolved_event_risk", ev.unresolved_event_risk)
    need_true("independent_models_agree", ev.independent_models_agree)
    if ev.convergence_horizon_days is None:
        unverified.append("convergence_horizon")
    elif ev.convergence_horizon_days > ev.max_convergence_days:
        failed.append("convergence_horizon_unrealistic")

    res.failed_checks, res.unverified_checks = failed, unverified
    res.confirmed = not failed and not unverified
    return res

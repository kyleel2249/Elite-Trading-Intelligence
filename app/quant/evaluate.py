"""One-instrument valuation pipeline: fair value -> mispricing -> sentiment -> (optional) Kelly sizing.

Pure function: the caller supplies the live price and its freshness (from MarketService) and the bankroll (from the
server-side risk context). Nothing here fetches or invents data; an unsupported valuation, stale price or missing
evidence yields a rejected / unverified result, never a trade plan.
"""
from __future__ import annotations

from typing import Any, Optional

from app.quant.fair_value import estimate_fair_value
from app.quant.kelly import KellyInput, KellyLimits, size_position
from app.quant.mispricing import VerificationEvidence, evaluate_mispricing
from app.quant.sentiment import SentimentResult


def valuation_score(mispricing_pct: Optional[float], confirmed: bool, confidence: float) -> float:
    """0-100 evidence score for downstream ranking (e.g. Global Alpha fusion). Unconfirmed mispricing is capped."""
    if mispricing_pct is None:
        return 0.0
    raw = min(100.0, abs(mispricing_pct) * 5.0) * max(0.0, min(1.0, confidence))
    return round(raw if confirmed else min(raw, 40.0), 2)


def evaluate_instrument(
    *, symbol: str, asset_class: str, price: Optional[float], price_fresh: bool,
    fair_value_inputs: dict[str, dict], sentiment: Optional[SentimentResult] = None,
    win_probability: Optional[float] = None, sample_size: int = 0, bankroll: Optional[float] = None,
    stop_pct: float = 5.0, round_trip_cost_pct: float = 0.30, verification: Optional[dict] = None,
    kelly_limits: Optional[KellyLimits] = None, can_short: bool = False,
) -> dict[str, Any]:
    v = verification or {}
    out: dict[str, Any] = {"symbol": symbol.upper(), "asset_class": asset_class, "price": price,
                           "price_fresh": price_fresh}
    if price is None or price <= 0:
        out.update(status="no_market_data", classification="REJECTED", reasons=["no valid live price"])
        return out
    fv = estimate_fair_value(symbol, asset_class, price, fair_value_inputs)
    out["fair_value"] = fv.to_dict()
    if sentiment is not None:
        out["sentiment"] = sentiment.to_dict()       # evidence only; can_trigger_order is always False
    if not fv.supported:
        out.update(status="valuation_unsupported", classification="UNSUPPORTED", reasons=fv.reasons,
                   valuation_score=0.0)
        return out
    vals = [e["value"] for e in fv.estimates]
    agree = len(vals) >= 2 and (all(x > price for x in vals) or all(x < price for x in vals))
    ev = VerificationEvidence(
        price_fresh=price_fresh, inputs_complete=fv.confidence >= 0.4, model_appropriate=True,
        corporate_action_or_data_error=v.get("corporate_action"), liquidity_adequate=v.get("liquidity_adequate"),
        round_trip_cost_pct=round_trip_cost_pct, fundamental_deterioration=v.get("fundamental_deterioration"),
        unresolved_event_risk=v.get("unresolved_event_risk"), independent_models_agree=agree,
        convergence_horizon_days=v.get("convergence_horizon_days"))
    mp = evaluate_mispricing(symbol, fv.fair_value, price, ev)
    out["mispricing"] = mp.to_dict()
    out["valuation_score"] = valuation_score(mp.mispricing_pct, mp.confirmed, fv.confidence)
    if not mp.flagged:
        out.update(status="evaluated", classification="NOT_MISPRICED_ABOVE_8PCT", reasons=[])
        return out
    if not price_fresh:
        out.update(status="evaluated", classification="REJECTED", reasons=["price is stale; cannot confirm mispricing"])
        return out
    out["classification"] = ("CONFIRMED_UNDERVALUED" if mp.direction == "undervalued" else "CONFIRMED_OVERVALUED") \
        if mp.confirmed else "MISPRICED_UNVERIFIED"
    out["status"] = "evaluated"
    out["sizing"] = None
    if not mp.confirmed or win_probability is None or not bankroll:
        return out
    side = "buy" if mp.direction == "undervalued" else "sell"
    if side == "sell" and not can_short:
        out["sizing"] = {"approved": False, "reasons": ["overvalued: shorting is not available on this venue"]}
        return out
    stop = price * (1 - stop_pct / 100) if side == "buy" else price * (1 + stop_pct / 100)
    gap = abs(fv.fair_value - price)
    target = price + gap if side == "buy" else price - gap
    k = size_position(KellyInput(bankroll=bankroll, entry_price=price, stop_price=stop, target_price=target,
                                 win_probability=win_probability, sample_size=sample_size, side=side,
                                 **(v.get("kelly_extra") or {})), kelly_limits)
    out["sizing"] = k.to_dict()
    if k.approved:
        out["trade_plan"] = {"side": side, "entry": price, "stop_loss": stop, "tp1": price + (target - price) * 0.5,
                             "tp2": target, "fair_value": fv.fair_value, "quantity": k.quantity,
                             "invalidation": ["price beyond stop", "fair value re-estimated against the thesis",
                                              "data becomes stale", "material negative event"]}
    return out

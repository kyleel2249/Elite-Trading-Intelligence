"""Independent fair-value engine.

Each model returns a ModelEstimate or None when its inputs are missing/invalid.
Models are only applied to asset classes where they are defensible
(e.g. no equity DCF on tokens). If fewer than ``MIN_MODELS`` valid models
remain, the result is marked ``insufficiently_supported`` and carries no
fair value, so downstream code cannot trade on it.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Optional

MIN_MODELS = 2
MIN_CONFIDENCE = 0.40


@dataclass
class ModelEstimate:
    model: str
    value: float
    assumptions: dict[str, Any]
    sensitivities: dict[str, float] = field(default_factory=dict)
    risks: list[str] = field(default_factory=list)


@dataclass
class FairValueResult:
    symbol: str
    asset_class: str
    market_price: float
    fair_value: Optional[float]
    lower_bound: Optional[float]
    upper_bound: Optional[float]
    confidence: float
    supported: bool
    methodology: list[str]
    estimates: list[dict]
    dropped_models: dict[str, str]
    valuation_ts: str
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _ok(*xs: Optional[float]) -> bool:
    return all(isinstance(x, (int, float)) and math.isfinite(x) for x in xs)


# ---------------- equity / ETF ----------------
def _dcf_value(inp: dict, discount_rate: float) -> Optional[float]:
    fcf, g, tg = inp.get("fcf_per_share"), inp.get("growth_rate"), inp.get("terminal_growth")
    years = int(inp.get("years", 5))
    r = discount_rate
    if not _ok(fcf, g, tg, r) or fcf <= 0 or r <= tg or r <= 0 or years < 1:
        return None
    pv, cf = 0.0, fcf
    for t in range(1, years + 1):
        cf *= (1 + g)
        pv += cf / (1 + r) ** t
    tv = cf * (1 + tg) / (r - tg)
    value = pv + tv / (1 + r) ** years - (inp.get("net_debt_per_share", 0.0) or 0.0)
    return value if value > 0 else None


def dcf(inp: dict) -> Optional[ModelEstimate]:
    r = inp.get("discount_rate")
    value = _dcf_value(inp, r) if _ok(r) else None
    if value is None:
        return None
    up, dn = _dcf_value(inp, r - 0.01), _dcf_value(inp, r + 0.01)
    return ModelEstimate("dcf", value,
                         {"fcf_per_share": inp["fcf_per_share"], "growth_rate": inp["growth_rate"],
                          "terminal_growth": inp["terminal_growth"], "discount_rate": r,
                          "years": int(inp.get("years", 5))},
                         {"discount_rate_-1pp": (up if up else value) - value,
                          "discount_rate_+1pp": (dn if dn else value) - value},
                         ["terminal value dominates; sensitive to discount rate"])


def ddm(inp: dict) -> Optional[ModelEstimate]:
    d, g, r = inp.get("dividend_per_share"), inp.get("dividend_growth"), inp.get("cost_of_equity")
    if not _ok(d, g, r) or d <= 0 or r <= g:
        return None
    return ModelEstimate("dividend_discount", d * (1 + g) / (r - g),
                         {"dividend_per_share": d, "dividend_growth": g, "cost_of_equity": r},
                         risks=["Gordon growth is unstable when r is close to g"])


def multiples(inp: dict) -> Optional[ModelEstimate]:
    """Peer-relative: metric per share * peer median multiple (P/E, P/S, EV/EBITDA per share ...)."""
    metric, mult = inp.get("peer_metric_per_share"), inp.get("peer_median_multiple")
    if not _ok(metric, mult) or metric <= 0 or mult <= 0:
        return None
    return ModelEstimate("peer_multiple", metric * mult,
                         {"metric_per_share": metric, "peer_median_multiple": mult,
                          "multiple_name": inp.get("multiple_name", "unspecified")},
                         risks=["peer set comparability"])


def historical_range(inp: dict) -> Optional[ModelEstimate]:
    metric, hist = inp.get("peer_metric_per_share"), inp.get("historical_multiples")
    if not _ok(metric) or not hist or len(hist) < 8 or not all(_ok(h) and h > 0 for h in hist):
        return None
    return ModelEstimate("historical_multiple_median", metric * statistics.median(hist),
                         {"observations": len(hist)}, risks=["mean reversion may fail after regime change"])


# ---------------- crypto ----------------
def protocol_revenue(inp: dict) -> Optional[ModelEstimate]:
    rev, mult, supply = inp.get("annual_protocol_revenue_usd"), inp.get("peer_ps_multiple"), inp.get("circulating_supply")
    if not _ok(rev, mult, supply) or rev <= 0 or mult <= 0 or supply <= 0:
        return None
    haircut = inp.get("unlock_dilution_pct", 0.0) or 0.0
    fair_mcap = rev * mult * (1 - min(0.9, max(0.0, haircut)))
    return ModelEstimate("protocol_revenue_multiple", fair_mcap / supply,
                         {"annual_protocol_revenue_usd": rev, "peer_ps_multiple": mult,
                          "unlock_dilution_pct": haircut},
                         risks=["token may not accrue protocol revenue", "emissions/unlocks dilute holders"])


def nvt(inp: dict) -> Optional[ModelEstimate]:
    vol, target, supply = inp.get("daily_onchain_tx_volume_usd"), inp.get("target_nvt"), inp.get("circulating_supply")
    if not _ok(vol, target, supply) or vol <= 0 or target <= 0 or supply <= 0:
        return None
    return ModelEstimate("network_value_to_transactions", vol * 365 / target / supply,
                         {"daily_onchain_tx_volume_usd": vol, "target_nvt": target},
                         risks=["on-chain volume is noisy and can be wash activity"])


def tvl_multiple(inp: dict) -> Optional[ModelEstimate]:
    tvl, mult, supply = inp.get("tvl_usd"), inp.get("peer_mcap_to_tvl"), inp.get("circulating_supply")
    if not _ok(tvl, mult, supply) or tvl <= 0 or mult <= 0 or supply <= 0:
        return None
    return ModelEstimate("mcap_to_tvl_peer", tvl * mult / supply, {"tvl_usd": tvl, "peer_mcap_to_tvl": mult},
                         risks=["TVL can be mercenary capital"])


# ---------------- commodities / FX / futures ----------------
def cost_of_carry(inp: dict) -> Optional[ModelEstimate]:
    spot, r, t = inp.get("spot"), inp.get("risk_free_rate"), inp.get("years_to_expiry")
    if not _ok(spot, r, t) or spot <= 0 or t <= 0:
        return None
    storage, conv = inp.get("storage_cost_rate", 0.0) or 0.0, inp.get("convenience_yield", 0.0) or 0.0
    return ModelEstimate("cost_of_carry_forward", spot * math.exp((r + storage - conv) * t),
                         {"spot": spot, "r": r, "storage": storage, "convenience_yield": conv, "T": t})


def interest_rate_parity(inp: dict) -> Optional[ModelEstimate]:
    spot, rd, rf, t = inp.get("spot"), inp.get("domestic_rate"), inp.get("foreign_rate"), inp.get("years_to_expiry")
    if not _ok(spot, rd, rf, t) or spot <= 0 or t <= 0:
        return None
    return ModelEstimate("covered_interest_parity_forward", spot * ((1 + rd) / (1 + rf)) ** t,
                         {"spot": spot, "domestic_rate": rd, "foreign_rate": rf, "T": t})


MODELS: dict[str, Callable[[dict], Optional[ModelEstimate]]] = {
    "dcf": dcf, "ddm": ddm, "multiples": multiples, "historical_range": historical_range,
    "protocol_revenue": protocol_revenue, "nvt": nvt, "tvl_multiple": tvl_multiple,
    "cost_of_carry": cost_of_carry, "interest_rate_parity": interest_rate_parity,
}

ALLOWED: dict[str, set[str]] = {
    "equity": {"dcf", "ddm", "multiples", "historical_range"},
    "etf": {"multiples", "historical_range"},
    "crypto": {"protocol_revenue", "nvt", "tvl_multiple"},
    "commodity": {"cost_of_carry"},
    "futures": {"cost_of_carry"},
    "forex": {"interest_rate_parity"},
}


def estimate_fair_value(symbol: str, asset_class: str, market_price: float, inputs: dict[str, dict]) -> FairValueResult:
    """``inputs`` maps model name -> that model's input dict (data must come from real providers)."""
    ts = datetime.now(timezone.utc).isoformat()
    ac = asset_class.lower()
    allowed = ALLOWED.get(ac, set())
    dropped: dict[str, str] = {}
    ests: list[ModelEstimate] = []
    for name, data in (inputs or {}).items():
        if name not in MODELS:
            dropped[name] = "unknown model"
        elif name not in allowed:
            dropped[name] = f"model not defensible for asset class '{ac}'"
        else:
            est = MODELS[name](data or {})
            if est is None:
                dropped[name] = "missing or invalid inputs"
            else:
                ests.append(est)

    def unsupported(reason: str) -> FairValueResult:
        return FairValueResult(symbol, ac, market_price, None, None, None, 0.0, False,
                               [e.model for e in ests], [asdict(e) for e in ests], dropped, ts, [reason])

    if len(ests) < MIN_MODELS:
        return unsupported(f"insufficiently supported: {len(ests)} valid model(s), need {MIN_MODELS}")

    vals = sorted(e.value for e in ests)
    fv = statistics.median(vals)
    spread = (vals[-1] - vals[0]) / fv if fv > 0 else 1.0
    agreement = max(0.0, 1.0 - spread)               # 1 = identical models
    coverage = min(1.0, len(ests) / 3.0)
    confidence = round(0.6 * agreement + 0.4 * coverage, 3)
    if confidence < MIN_CONFIDENCE:
        return unsupported(f"model disagreement too large (confidence {confidence})")
    return FairValueResult(symbol, ac, market_price, fv, vals[0], vals[-1], confidence, True,
                           [e.model for e in ests], [asdict(e) for e in ests], dropped, ts)

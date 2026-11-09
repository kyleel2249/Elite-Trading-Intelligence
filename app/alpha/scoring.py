"""Early Alpha Score (0-100) and lifecycle stage classification.

Asset-class-specific weights. A component that cannot be measured is EXCLUDED
(not scored as neutral): the score is rescaled over available evidence and the
result reports evidence coverage, so missing data lowers confidence instead of
being silently invented. A high score is a research priority, never a BUY.
"""
from __future__ import annotations

from typing import Any, Optional

COMPONENTS = (
    "accumulation", "volume_anomaly", "momentum", "relative_strength", "catalyst",
    "institutional", "onchain", "liquidity", "valuation", "regime",
)

WEIGHTS: dict[str, dict[str, float]] = {
    "equity": {"accumulation": 18, "volume_anomaly": 12, "momentum": 10, "relative_strength": 14,
               "catalyst": 12, "institutional": 12, "onchain": 0, "liquidity": 6, "valuation": 10, "regime": 6},
    "etf": {"accumulation": 18, "volume_anomaly": 12, "momentum": 14, "relative_strength": 20,
            "catalyst": 4, "institutional": 8, "onchain": 0, "liquidity": 10, "valuation": 6, "regime": 8},
    "crypto": {"accumulation": 18, "volume_anomaly": 12, "momentum": 12, "relative_strength": 14,
               "catalyst": 8, "institutional": 4, "onchain": 14, "liquidity": 10, "valuation": 4, "regime": 4},
    "token": {"accumulation": 12, "volume_anomaly": 10, "momentum": 8, "relative_strength": 4,
              "catalyst": 8, "institutional": 0, "onchain": 26, "liquidity": 28, "valuation": 4, "regime": 0},
    "forex": {"accumulation": 8, "volume_anomaly": 4, "momentum": 22, "relative_strength": 24,
              "catalyst": 14, "institutional": 6, "onchain": 0, "liquidity": 4, "valuation": 8, "regime": 10},
    "commodity": {"accumulation": 14, "volume_anomaly": 10, "momentum": 18, "relative_strength": 14,
                  "catalyst": 14, "institutional": 6, "onchain": 0, "liquidity": 6, "valuation": 10, "regime": 8},
}

STAGES = (
    "PRE_ACCUMULATION", "EARLY_ACCUMULATION", "BREAKOUT_FORMATION", "BREAKOUT_CONFIRMATION",
    "TREND_EXPANSION", "MOMENTUM_EXHAUSTION", "DISTRIBUTION", "REVERSAL_RISK",
)


def _clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def _lin(x: Optional[float], x0: float, x1: float) -> Optional[float]:
    """Map x from [x0,x1] onto [0,100] (x0 -> 0, x1 -> 100); None passes through."""
    if x is None:
        return None
    if x1 == x0:
        return None
    return _clamp((x - x0) / (x1 - x0) * 100)


def components_from_features(f: dict[str, Any], asset_class: str = "crypto") -> dict[str, Optional[float]]:
    """Derive the measurable components from OHLCV features. Others stay None."""
    if not f.get("sufficient"):
        return {c: None for c in COMPONENTS}
    ud, ad = _lin(f.get("ud_volume_ratio"), 0.8, 1.6), _lin(f.get("ad_slope"), -0.15, 0.25)
    parts = [p for p in (ud, ad) if p is not None]
    accumulation = sum(parts) / len(parts) if parts else None
    # volume anomaly: elevated volume that is not yet a price blow-off
    rvol = f.get("rvol")
    vol_anom = _lin(rvol, 0.8, 2.5)
    if vol_anom is not None and (f.get("ret_7") or 0) > (0.6 if asset_class in ("crypto", "token") else 0.25):
        vol_anom *= 0.5  # volume that arrives after the move is not "early"
    # momentum improvement: positive but not extended; penalise overextension
    ext = f.get("extension_50")
    momentum = None
    if ext is not None:
        cap = 0.5 if asset_class in ("crypto", "token") else 0.2
        momentum = _lin(ext, -cap, cap * 0.5) if ext <= cap * 0.5 else _clamp(100 - (ext - cap * 0.5) / cap * 100)
    rs = _lin(f.get("rel_strength_30"), -0.10, 0.20)
    liq = None
    dv = f.get("dollar_volume_20")
    if dv is not None:
        floor = {"equity": 1e6, "etf": 1e6, "crypto": 1e6, "token": 5e4, "forex": 1e7, "commodity": 1e6}.get(asset_class, 1e6)
        liq = _lin(dv, floor * 0.25, floor * 10)
    regime = None
    if f.get("sma50") and f.get("sma200"):
        regime = 70.0 if f["sma50"] > f["sma200"] else 30.0
    elif f.get("sma50_slope") is not None:
        regime = _lin(f["sma50_slope"], -0.05, 0.05)
    return {"accumulation": accumulation, "volume_anomaly": vol_anom, "momentum": momentum,
            "relative_strength": rs, "catalyst": None, "institutional": None, "onchain": None,
            "liquidity": liq, "valuation": None, "regime": regime}


def score_early_alpha(asset_class: str, components: dict[str, Optional[float]]) -> dict[str, Any]:
    weights = WEIGHTS.get(asset_class) or WEIGHTS["crypto"]
    applicable = {k: w for k, w in weights.items() if w > 0}
    total_w = sum(applicable.values())
    used = {k: components[k] for k in applicable if components.get(k) is not None}
    used_w = sum(applicable[k] for k in used)
    coverage = used_w / total_w if total_w else 0.0
    if not used_w:
        return {"score": None, "coverage": 0.0, "uncertainty": 1.0, "band": None, "used": {}, "missing": sorted(applicable),
                "note": "No measurable evidence; no score assigned"}
    raw = sum(used[k] * applicable[k] for k in used) / used_w
    # Thin evidence is shrunk toward 50 so sparse data cannot produce a headline score.
    shrunk = 50 + (raw - 50) * min(1.0, 0.4 + 0.6 * coverage)
    uncertainty = round(1 - coverage, 3)
    half = 5 + 20 * uncertainty
    return {
        "score": round(_clamp(shrunk), 1), "raw_score": round(raw, 1), "coverage": round(coverage, 3),
        "uncertainty": uncertainty,
        "band": [round(_clamp(shrunk - half), 1), round(_clamp(shrunk + half), 1)],
        "band_note": "heuristic uncertainty band from evidence coverage, not a statistical interval",
        "used": {k: round(v, 1) for k, v in used.items()},
        "missing": sorted(k for k in applicable if k not in used),
        "weights": applicable,
    }


def classify_stage(f: dict[str, Any], asset_class: str = "crypto") -> dict[str, Any]:
    """Assign one of 8 lifecycle stages from raw features (or NONE with reasons)."""
    if not f.get("sufficient"):
        return {"stage": None, "reasons": ["insufficient history"]}
    last, sma50, sma200 = f["last"], f.get("sma50"), f.get("sma200")
    dist = f.get("dist_to_high")
    ud, ad = f.get("ud_volume_ratio"), f.get("ad_slope")
    rvol = f.get("rvol")
    vc, ext, rsi14 = f.get("vol_contraction"), f.get("extension_50"), f.get("rsi14")
    hot = 0.5 if asset_class in ("crypto", "token") else 0.25
    below50 = sma50 is not None and last < sma50
    if below50 and ad is not None and ad < 0 and dist is not None and dist > 0.15:
        return {"stage": "REVERSAL_RISK", "reasons": ["price below 50-bar mean", "negative A/D", f"{dist:.0%} below high"]}
    if dist is not None and dist < 0.05 and ud is not None and ud < 0.85 and (rvol or 0) > 1.2:
        return {"stage": "DISTRIBUTION", "reasons": ["near highs", f"up/down volume {ud:.2f}", "elevated volume"]}
    if (ext is not None and ext > hot and (rvol or 1) < 0.9) or (rsi14 is not None and rsi14 > 80):
        return {"stage": "MOMENTUM_EXHAUSTION", "reasons": [f"extension {ext:.0%}" if ext is not None else "overbought", "volume fading or RSI>80"]}
    uptrend = bool(sma50 and sma200 and last > sma50 > sma200 and (f.get("sma50_slope") or 0) > 0)
    if f.get("breakout_recent") and (rvol or 0) >= 1.3 and not below50:
        return {"stage": "BREAKOUT_CONFIRMATION", "reasons": ["closed above prior 20-bar high within 3 bars", f"rvol {rvol:.2f}"]}
    if uptrend and dist is not None and dist < 0.03 and (ext or 0) < hot:
        return {"stage": "TREND_EXPANSION", "reasons": ["price>SMA50>SMA200 with rising SMA50", "within 3% of high"]}
    if dist is not None and dist <= 0.04 and vc is not None and vc < 0.85 and (ud or 0) >= 1.0:
        return {"stage": "BREAKOUT_FORMATION", "reasons": ["within 4% of high", f"volatility contraction {vc:.2f}", "buyers not losing volume battle"]}
    tight = f.get("range_tight_10")
    if (ud or 0) >= 1.15 and (ad or 0) > 0 and (f.get("off_low_20") or 0) > 0.02 and (dist or 0) > 0.04 and (tight is None or tight < 0.25):
        return {"stage": "EARLY_ACCUMULATION", "reasons": [f"up/down volume {ud:.2f}", "positive A/D slope", "base holding above 20-bar low"]}
    if vc is not None and vc < 0.9 and ud is not None and 0.9 <= ud < 1.15 and not uptrend:
        return {"stage": "PRE_ACCUMULATION", "reasons": ["volatility contracting", "selling pressure easing"]}
    return {"stage": None, "reasons": ["no stage criteria met"]}

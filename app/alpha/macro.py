"""Macro regime evaluators from FRED (liquidity, growth/inflation quadrant, credit cycle).

They describe the CURRENT environment using public series; they are ETI parameterizations of widely
described frameworks (liquidity direction, growth x inflation regimes, spread-based credit-cycle caution),
not the investors' proprietary models, and they are not backtested here. FRED series used:
DFF, WALCL, T10Y2Y, CPIAUCSL, UNRATE, BAMLH0A0HYM2."""
from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Optional

from app.config import Settings
from app.intelligence.feeds import fetch_fred_series

Points = list[dict[str, Any]]
SERIES_LIMITS = {"DFF": 300, "WALCL": 40, "T10Y2Y": 5, "CPIAUCSL": 20, "UNRATE": 12, "BAMLH0A0HYM2": 800}
NOTE = "Descriptive ETI parameterization of public frameworks; not a forecast and not backtested."
_CACHE: dict[str, Any] = {"ts": 0.0, "data": None}
CACHE_SECONDS = 6 * 3600


def _vals(pts: Optional[Points]) -> list[float]:
    return [float(p["value"]) for p in (pts or []) if p.get("value") is not None]


def liquidity_regime(series: dict[str, Points]) -> dict[str, Any]:
    ev: list[str] = []
    score, known = 0.0, 0
    dff = _vals(series.get("DFF"))
    if len(dff) >= 127:
        ch = dff[-1] - dff[-127]
        known += 1
        if ch <= -0.25:
            score += 1
        elif ch >= 0.25:
            score -= 1
        ev.append(f"policy rate change over ~6 months: {ch:+.2f} pts")
    walcl = _vals(series.get("WALCL"))
    if len(walcl) >= 14 and walcl[-14] > 0:
        ch = walcl[-1] / walcl[-14] - 1
        known += 1
        if ch >= 0.01:
            score += 1
        elif ch <= -0.01:
            score -= 1
        ev.append(f"Fed balance sheet over 13 weeks: {ch:+.1%}")
    curve = _vals(series.get("T10Y2Y"))
    inverted = None
    if curve:
        known += 1
        inverted = curve[-1] < 0
        if inverted:
            score -= 0.5
        ev.append(f"10y-2y spread {curve[-1]:+.2f} ({'inverted' if inverted else 'positive'})")
    if known < 2:
        return {"regime": "UNKNOWN", "evidence": ev, "note": NOTE, "reason": "fewer than 2 of 3 inputs available"}
    regime = "EASING_LIQUIDITY" if score >= 1 else "TIGHTENING_LIQUIDITY" if score <= -1 else "MIXED"
    return {"regime": regime, "score": score, "evidence": ev, "curve_inverted": inverted, "note": NOTE}


def growth_inflation_quadrant(series: dict[str, Points]) -> dict[str, Any]:
    cpi, un = _vals(series.get("CPIAUCSL")), _vals(series.get("UNRATE"))
    if len(cpi) < 16 or len(un) < 8:
        return {"quadrant": "UNKNOWN", "reason": "needs 16 months of CPI and 8 of unemployment", "note": NOTE}
    yoy_now, yoy_prev = cpi[-1] / cpi[-13] - 1, cpi[-4] / cpi[-16] - 1
    infl = "UP" if yoy_now - yoy_prev > 0.002 else "DOWN" if yoy_now - yoy_prev < -0.002 else "FLAT"
    d = un[-1] - un[-7]
    growth = "UP" if d <= -0.2 else "DOWN" if d >= 0.2 else "FLAT"  # falling unemployment = growth proxy rising
    q = f"GROWTH_{growth}_INFLATION_{infl}"
    return {"quadrant": q, "inflation_yoy": round(yoy_now, 4), "inflation_trend": infl, "unemployment_change_6m": round(d, 2),
            "growth_proxy": growth, "note": NOTE + " Growth is proxied by the unemployment trend."}


def credit_cycle(series: dict[str, Points]) -> dict[str, Any]:
    hy = _vals(series.get("BAMLH0A0HYM2"))
    if len(hy) < 250:
        return {"state": "UNKNOWN", "reason": f"{len(hy)} observations; need 250", "note": NOTE}
    pct = sum(1 for x in hy if x <= hy[-1]) / len(hy)
    state = "TIGHT_SPREADS_LATE_CYCLE_CAUTION" if pct <= 0.2 else "WIDE_SPREADS_STRESS_OR_OPPORTUNITY" if pct >= 0.8 else "NEUTRAL"
    return {"state": state, "hy_spread": hy[-1], "percentile_in_window": round(pct, 3), "window_obs": len(hy), "note": NOTE}


def evaluate(series: dict[str, Points]) -> dict[str, Any]:
    return {"liquidity": liquidity_regime(series), "growth_inflation": growth_inflation_quadrant(series), "credit": credit_cycle(series)}


async def load_macro(settings: Settings, fetch: Callable[..., Awaitable[dict[str, Any]]] = fetch_fred_series, use_cache: bool = True) -> dict[str, Any]:
    if not settings.fred_configured:
        return {"status": "not_configured", "detail": "FRED_API_KEY not set"}
    if use_cache and _CACHE["data"] and time.time() - _CACHE["ts"] < CACHE_SECONDS:
        return _CACHE["data"]
    series: dict[str, Points] = {}
    failed: list[str] = []
    for sid, lim in SERIES_LIMITS.items():
        r = await fetch(sid, lim, settings)
        if r.get("status") == "ok":
            series[sid] = r["points"]
        else:
            failed.append(sid)
    out = {"status": "ok" if series else "error", "failed_series": failed, **evaluate(series)}
    if use_cache and series:
        _CACHE.update(ts=time.time(), data=out)
    return out

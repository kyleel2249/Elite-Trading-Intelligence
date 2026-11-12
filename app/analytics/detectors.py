"""Unusual volume and volatility breakout detection."""
from __future__ import annotations

from typing import Any, Sequence

from .stats import atr, closes_of, mean, stdev, true_ranges


def unusual_volume(klines: Sequence[dict[str, Any]], window: int = 20, z_threshold: float = 3.0,
                   rvol_threshold: float = 2.0) -> dict[str, Any]:
    vols = []
    for k in klines:
        try:
            v = float(k.get("volume"))
        except (TypeError, ValueError):
            continue
        if v >= 0:
            vols.append(v)
    if len(vols) < window + 1:
        return {"status": "insufficient_data", "required_bars": window + 1, "provided_bars": len(vols)}
    base, last = vols[-window - 1:-1], vols[-1]
    m, sd = mean(base), stdev(base)
    rvol = last / m if m > 0 else None
    z = (last - m) / sd if sd > 0 else None
    flagged = (rvol is not None and rvol >= rvol_threshold) and (z is None or z >= z_threshold)
    return {"status": "ok", "unusual": bool(flagged), "relative_volume": None if rvol is None else round(rvol, 3),
            "z_score": None if z is None else round(z, 3), "baseline_mean": round(m, 4), "latest_volume": last,
            "thresholds": {"rvol": rvol_threshold, "z": z_threshold}}


def volatility_breakout(klines: Sequence[dict[str, Any]], channel: int = 20, squeeze_pct: float = 25.0,
                        atr_expansion: float = 1.3) -> dict[str, Any]:
    closes = closes_of(klines)
    need = channel * 3
    if len(closes) < need or len(true_ranges(klines)) < need:
        return {"status": "insufficient_data", "required_bars": need, "provided_bars": len(closes)}
    widths = []
    for i in range(channel, len(closes) + 1):
        w = closes[i - channel:i]
        m, sd = mean(w), stdev(w)
        widths.append(4 * sd / m if m else 0.0)
    squeezed = (sum(1 for x in widths[:-1] if x <= widths[-2]) / (len(widths) - 1) * 100) <= squeeze_pct
    prior = closes[-channel - 1:-1]
    upper, lower = max(prior), min(prior)
    a_now = atr(klines, 14)
    trs = true_ranges(klines)
    a_prev = mean(trs[-channel - 14:-channel]) if len(trs) >= channel + 14 else None
    expanding = bool(a_now and a_prev and a_now / a_prev >= atr_expansion)
    direction = "up" if closes[-1] > upper else "down" if closes[-1] < lower else None
    return {"status": "ok", "alert": bool(direction and expanding), "direction": direction,
            "prior_squeeze": bool(squeezed), "atr_expanding": expanding, "channel_high": upper, "channel_low": lower,
            "atr": a_now, "last_close": closes[-1],
            "notes": ["An alert is a watch trigger, not an entry signal; breakouts fail often."]}

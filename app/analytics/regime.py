"""Market regime detection from OHLC candles."""
from __future__ import annotations

from typing import Any, Sequence

from .stats import closes_of, ema, pct_returns, percentile, stdev

MIN_BARS = 60


def _efficiency_ratio(closes: Sequence[float], n: int) -> float:
    if len(closes) <= n:
        return 0.0
    net = abs(closes[-1] - closes[-1 - n])
    path = sum(abs(closes[i] - closes[i - 1]) for i in range(len(closes) - n, len(closes)))
    return net / path if path else 0.0


def detect_regime(klines: Sequence[dict[str, Any]], er_window: int = 20) -> dict[str, Any]:
    closes = closes_of(klines)
    if len(closes) < MIN_BARS:
        return {"status": "insufficient_data", "required_bars": MIN_BARS, "provided_bars": len(closes)}
    e20, e50 = ema(closes, 20), ema(closes, 50)
    er = _efficiency_ratio(closes, er_window)
    rets = pct_returns(closes)
    vols = [stdev(rets[i - er_window:i]) for i in range(er_window, len(rets) + 1)]
    vol_now = vols[-1]
    vol_pct = sum(1 for v in vols if v <= vol_now) / len(vols) * 100
    direction = "up" if e20[-1] > e50[-1] and closes[-1] > e50[-1] else "down" if e20[-1] < e50[-1] and closes[-1] < e50[-1] else "mixed"
    trending = er >= 0.3 and direction != "mixed"
    if trending:
        trend = f"trending_{direction}"
    else:
        trend = "ranging"
    vol_state = "high_volatility" if vol_pct >= 80 else "low_volatility" if vol_pct <= 20 else "normal_volatility"
    return {"status": "ok", "regime": trend, "volatility_state": vol_state, "label": f"{trend}/{vol_state}",
            "efficiency_ratio": round(er, 4), "volatility_percentile": round(vol_pct, 1),
            "ema_20": round(e20[-1], 6), "ema_50": round(e50[-1], 6), "bars": len(closes),
            "notes": ["Rule-based classification on the supplied window; regimes lag and flip near thresholds."]}

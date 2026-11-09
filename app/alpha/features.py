"""Pure-python OHLCV feature extraction for early-alpha detection.

All functions are deterministic and use only data available up to the last bar.
Bars are dicts with open/high/low/close/volume.
"""
from __future__ import annotations

from typing import Any, Optional, Sequence

MIN_BARS = 60


def _f(bar: dict[str, Any], key: str) -> float:
    v = bar.get(key)
    return float(v) if v is not None else 0.0


def sma(values: Sequence[float], n: int) -> Optional[float]:
    if n <= 0 or len(values) < n:
        return None
    return sum(values[-n:]) / n


def ema_series(values: Sequence[float], n: int) -> list[float]:
    out: list[float] = []
    k = 2 / (n + 1)
    for i, v in enumerate(values):
        out.append(v if i == 0 else v * k + out[-1] * (1 - k))
    return out


def true_ranges(bars: Sequence[dict[str, Any]]) -> list[float]:
    trs: list[float] = []
    for i in range(1, len(bars)):
        h, l, pc = _f(bars[i], "high"), _f(bars[i], "low"), _f(bars[i - 1], "close")
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return trs


def atr(bars: Sequence[dict[str, Any]], n: int = 14) -> Optional[float]:
    trs = true_ranges(bars)
    if len(trs) < n:
        return None
    v = sum(trs[:n]) / n
    for t in trs[n:]:
        v = (v * (n - 1) + t) / n
    return v


def rsi(closes: Sequence[float], n: int = 14) -> Optional[float]:
    if len(closes) < n + 1:
        return None
    gain = loss = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gain += max(d, 0.0)
        loss += max(-d, 0.0)
    gain /= n
    loss /= n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (n - 1) + max(d, 0.0)) / n
        loss = (loss * (n - 1) + max(-d, 0.0)) / n
    if loss == 0:
        return 50.0 if gain == 0 else 100.0
    return 100 - 100 / (1 + gain / loss)


def relative_volume(volumes: Sequence[float], recent: int = 3, base: int = 20) -> Optional[float]:
    if len(volumes) < recent + base:
        return None
    base_avg = sum(volumes[-(recent + base):-recent]) / base
    if base_avg <= 0:
        return None
    return (sum(volumes[-recent:]) / recent) / base_avg


def up_down_volume_ratio(bars: Sequence[dict[str, Any]], n: int = 20) -> Optional[float]:
    """Volume on up-closes / volume on down-closes over the last n bars."""
    if len(bars) < n + 1:
        return None
    up = down = 0.0
    for i in range(len(bars) - n, len(bars)):
        d = _f(bars[i], "close") - _f(bars[i - 1], "close")
        v = _f(bars[i], "volume")
        if d > 0:
            up += v
        elif d < 0:
            down += v
    if down <= 0:
        return None if up <= 0 else 3.0
    return min(up / down, 3.0)


def accumulation_distribution_slope(bars: Sequence[dict[str, Any]], n: int = 20) -> Optional[float]:
    """Chaikin A/D change over n bars, normalised by total volume (range -1..1)."""
    if len(bars) < n:
        return None
    total_v = 0.0
    ad = 0.0
    for b in bars[-n:]:
        h, l, c, v = _f(b, "high"), _f(b, "low"), _f(b, "close"), _f(b, "volume")
        rng = h - l
        clv = ((c - l) - (h - c)) / rng if rng > 0 else 0.0
        ad += clv * v
        total_v += v
    return ad / total_v if total_v > 0 else None


def volatility_contraction(bars: Sequence[dict[str, Any]]) -> Optional[float]:
    """ATR(10)/ATR(50). Below ~0.8 means volatility is contracting."""
    a_short, a_long = atr(bars[-30:], 10), atr(bars, 50) if len(bars) >= 55 else None
    if a_short is None or a_long is None or a_long <= 0:
        return None
    return a_short / a_long


def range_tightness(bars: Sequence[dict[str, Any]], n: int = 10) -> Optional[float]:
    """(high-low)/close of the last n bars; smaller is tighter."""
    if len(bars) < n:
        return None
    w = bars[-n:]
    hi, lo, c = max(_f(b, "high") for b in w), min(_f(b, "low") for b in w), _f(w[-1], "close")
    return (hi - lo) / c if c > 0 else None


def pct_return(closes: Sequence[float], n: int) -> Optional[float]:
    if len(closes) <= n or closes[-n - 1] <= 0:
        return None
    return closes[-1] / closes[-n - 1] - 1


def relative_strength(closes: Sequence[float], bench: Optional[Sequence[float]], n: int = 30) -> Optional[float]:
    if not bench:
        return None
    a, b = pct_return(closes, n), pct_return(bench, n)
    if a is None or b is None:
        return None
    return a - b


def dollar_volume(bars: Sequence[dict[str, Any]], n: int = 20) -> Optional[float]:
    if len(bars) < n:
        return None
    return sum(_f(b, "close") * _f(b, "volume") for b in bars[-n:]) / n


def compute_features(
    bars: Sequence[dict[str, Any]], bench_closes: Optional[Sequence[float]] = None
) -> dict[str, Any]:
    """Return a feature dict, or {'sufficient': False} when history is too short."""
    if len(bars) < MIN_BARS:
        return {"sufficient": False, "bars": len(bars), "reason": f"need >= {MIN_BARS} bars"}
    closes = [_f(b, "close") for b in bars]
    vols = [_f(b, "volume") for b in bars]
    last = closes[-1]
    sma20, sma50 = sma(closes, 20), sma(closes, 50)
    sma200 = sma(closes, 200)
    sma50_prev = sum(closes[-60:-10]) / 50 if len(closes) >= 60 else None
    hi20_prior = max(_f(b, "high") for b in bars[-21:-1])
    hi_n = max(_f(b, "high") for b in bars[-min(len(bars), 120):])
    lo20 = min(_f(b, "low") for b in bars[-20:])
    breakout_recent = any(closes[-k] > max(_f(b, "high") for b in bars[-k - 20:-k]) for k in (1, 2, 3))
    return {
        "sufficient": True,
        "bars": len(bars),
        "last": last,
        "sma20": sma20, "sma50": sma50, "sma200": sma200,
        "sma50_slope": (sma50 / sma50_prev - 1) if sma50 and sma50_prev else None,
        "extension_50": (last / sma50 - 1) if sma50 else None,
        "rsi14": rsi(closes, 14),
        "atr14": atr(bars, 14),
        "atr_pct": (atr(bars, 14) or 0) / last if last else None,
        "rvol": relative_volume(vols),
        "ud_volume_ratio": up_down_volume_ratio(bars),
        "ad_slope": accumulation_distribution_slope(bars),
        "vol_contraction": volatility_contraction(bars),
        "range_tight_10": range_tightness(bars, 10),
        "range_tight_30": range_tightness(bars, 30),
        "dist_to_high": (hi_n - last) / hi_n if hi_n else None,
        "high_n": hi_n,
        "prior_high_20": hi20_prior,
        "low_20": lo20,
        "off_low_20": (last / lo20 - 1) if lo20 else None,
        "breakout_recent": breakout_recent,
        "ret_7": pct_return(closes, 7),
        "ret_30": pct_return(closes, 30),
        "rel_strength_30": relative_strength(closes, bench_closes, 30),
        "dollar_volume_20": dollar_volume(bars, 20),
    }

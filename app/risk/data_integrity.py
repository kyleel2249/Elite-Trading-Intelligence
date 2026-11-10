"""Market-data integrity checks used by the strategy quarantine system (pure logic).

Returns short flag names. Any flag fed to ``StrategyLiveStats.integrity_flags``
quarantines the strategies that relied on the data.
"""
from __future__ import annotations

import math
from typing import Any, Iterable, Optional

_INTERVAL_MS = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}


def interval_ms(interval: str) -> Optional[int]:
    try:
        return int(interval[:-1]) * _INTERVAL_MS[interval[-1]]
    except (KeyError, ValueError, IndexError):
        return None


def _num(x: Any) -> Optional[float]:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def check_klines(klines: Iterable[dict[str, Any]], *, interval: Optional[str] = None,
                 now_ms: Optional[int] = None, max_stale_intervals: float = 3.0) -> list[str]:
    """Flags: empty_series, nan_values, non_positive_price, invalid_ohlc, duplicate_bars, out_of_order, gap, stale_data."""
    rows = list(klines)
    flags: set[str] = set()
    if not rows:
        return ["empty_series"]
    prev_t: Optional[float] = None
    step = interval_ms(interval) if interval else None
    for r in rows:
        o, h, l, c = (_num(r.get(k)) for k in ("open", "high", "low", "close"))
        if None in (o, h, l, c):
            flags.add("nan_values")
            continue
        if min(o, h, l, c) <= 0:
            flags.add("non_positive_price")
        if h < max(o, c) or l > min(o, c) or h < l:
            flags.add("invalid_ohlc")
        v = r.get("volume")
        if v is not None and (_num(v) is None or _num(v) < 0):
            flags.add("nan_values")
        t = _num(r.get("open_time"))
        if t is not None:
            if prev_t is not None:
                if t == prev_t:
                    flags.add("duplicate_bars")
                elif t < prev_t:
                    flags.add("out_of_order")
                elif step and (t - prev_t) > step * 1.5:
                    flags.add("gap")
            prev_t = t
    if now_ms is not None and step:
        last_close = _num(rows[-1].get("close_time"))
        if last_close is not None and (now_ms - last_close) > step * max_stale_intervals:
            flags.add("stale_data")
    return sorted(flags)

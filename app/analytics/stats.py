"""Small numeric helpers (stdlib only)."""
from __future__ import annotations

import math
from typing import Any, Iterable, Optional, Sequence


def closes_of(klines: Sequence[dict[str, Any]]) -> list[float]:
    out: list[float] = []
    for k in klines:
        if k.get("data_status") == "invalid":
            continue
        v = k.get("close")
        if v is None:
            continue
        f = float(v)
        if math.isfinite(f) and f > 0:
            out.append(f)
    return out


def pct_returns(prices: Sequence[float]) -> list[float]:
    return [prices[i] / prices[i - 1] - 1.0 for i in range(1, len(prices)) if prices[i - 1] > 0]


def mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs: Sequence[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))


def percentile(xs: Sequence[float], q: float) -> float:
    """Linear-interpolated percentile, q in [0, 100]."""
    if not xs:
        raise ValueError("percentile of empty sequence")
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    pos = (len(s) - 1) * min(max(q, 0.0), 100.0) / 100.0
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def max_drawdown(equity: Sequence[float]) -> float:
    """Maximum peak-to-trough drawdown as a positive fraction."""
    peak = float("-inf")
    worst = 0.0
    for e in equity:
        peak = max(peak, e)
        if peak > 0:
            worst = max(worst, (peak - e) / peak)
    return worst


def sharpe(returns: Sequence[float], periods_per_year: float = 365.0) -> Optional[float]:
    sd = stdev(returns)
    if len(returns) < 2 or sd == 0:
        return None
    return mean(returns) / sd * math.sqrt(periods_per_year)


def pearson(a: Sequence[float], b: Sequence[float]) -> Optional[float]:
    n = min(len(a), len(b))
    if n < 3:
        return None
    a, b = a[-n:], b[-n:]
    ma, mb = mean(a), mean(b)
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va == 0 or vb == 0:
        return None
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    return max(-1.0, min(1.0, cov / math.sqrt(va * vb)))


def ema(xs: Sequence[float], period: int) -> list[float]:
    if not xs:
        return []
    k = 2.0 / (period + 1)
    out = [xs[0]]
    for x in xs[1:]:
        out.append(x * k + out[-1] * (1 - k))
    return out


def sma(xs: Sequence[float], period: int) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    run = 0.0
    for i, x in enumerate(xs):
        run += x
        if i >= period:
            run -= xs[i - period]
        out.append(run / period if i >= period - 1 else None)
    return out


def true_ranges(klines: Sequence[dict[str, Any]]) -> list[float]:
    trs: list[float] = []
    prev_close: Optional[float] = None
    for k in klines:
        try:
            h, l, c = float(k["high"]), float(k["low"]), float(k["close"])
        except (KeyError, TypeError, ValueError):
            continue
        tr = h - l if prev_close is None else max(h - l, abs(h - prev_close), abs(l - prev_close))
        trs.append(tr)
        prev_close = c
    return trs


def atr(klines: Sequence[dict[str, Any]], period: int = 14) -> Optional[float]:
    trs = true_ranges(klines)
    if len(trs) < period:
        return None
    return mean(trs[-period:])

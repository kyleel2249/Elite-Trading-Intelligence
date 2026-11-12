"""Pure-Python indicators. Every function is causal: value[i] uses data up to and including index i only."""
from __future__ import annotations

import math
from typing import Optional, Sequence

NaN = float("nan")


def isnan(x: Optional[float]) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def sma(v: Sequence[float], n: int) -> list[float]:
    out = [NaN] * len(v)
    s = 0.0
    for i, x in enumerate(v):
        s += x
        if i >= n:
            s -= v[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(v: Sequence[float], n: int) -> list[float]:
    out = [NaN] * len(v)
    if len(v) < n:
        return out
    k = 2.0 / (n + 1)
    prev = sum(v[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(v)):
        prev = v[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def stdev(v: Sequence[float], n: int) -> list[float]:
    out = [NaN] * len(v)
    for i in range(n - 1, len(v)):
        w = v[i - n + 1 : i + 1]
        m = sum(w) / n
        out[i] = math.sqrt(sum((x - m) ** 2 for x in w) / max(n - 1, 1))
    return out


def highest(v: Sequence[float], n: int, shift: int = 0) -> list[float]:
    """Rolling max of the n values ending `shift` bars ago (shift=1 excludes the current bar)."""
    out = [NaN] * len(v)
    for i in range(n - 1 + shift, len(v)):
        out[i] = max(v[i - n + 1 - shift : i + 1 - shift])
    return out


def lowest(v: Sequence[float], n: int, shift: int = 0) -> list[float]:
    out = [NaN] * len(v)
    for i in range(n - 1 + shift, len(v)):
        out[i] = min(v[i - n + 1 - shift : i + 1 - shift])
    return out


def true_range(h: Sequence[float], l: Sequence[float], c: Sequence[float]) -> list[float]:
    out = [h[0] - l[0]] if h else []
    for i in range(1, len(h)):
        out.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    return out


def atr(h: Sequence[float], l: Sequence[float], c: Sequence[float], n: int = 14) -> list[float]:
    """Wilder ATR."""
    tr = true_range(h, l, c)
    out = [NaN] * len(tr)
    if len(tr) < n:
        return out
    prev = sum(tr[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(tr)):
        prev = (prev * (n - 1) + tr[i]) / n
        out[i] = prev
    return out


def rsi(c: Sequence[float], n: int = 14) -> list[float]:
    out = [NaN] * len(c)
    if len(c) <= n:
        return out
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    ag, al = gains / n, losses / n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(c)):
        d = c[i] - c[i - 1]
        ag = (ag * (n - 1) + max(d, 0.0)) / n
        al = (al * (n - 1) + max(-d, 0.0)) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def adx(h: Sequence[float], l: Sequence[float], c: Sequence[float], n: int = 14) -> list[float]:
    N = len(c)
    out = [NaN] * N
    if N < 2 * n + 1:
        return out
    tr = true_range(h, l, c)
    pdm = [0.0] * N
    mdm = [0.0] * N
    for i in range(1, N):
        up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
        pdm[i] = up if up > dn and up > 0 else 0.0
        mdm[i] = dn if dn > up and dn > 0 else 0.0
    str_ = sum(tr[1 : n + 1]); sp = sum(pdm[1 : n + 1]); sm = sum(mdm[1 : n + 1])
    dx: list[float] = []
    for i in range(n, N):
        if i > n:
            str_ = str_ - str_ / n + tr[i]
            sp = sp - sp / n + pdm[i]
            sm = sm - sm / n + mdm[i]
        pdi = 100 * sp / str_ if str_ else 0.0
        mdi = 100 * sm / str_ if str_ else 0.0
        dx.append(100 * abs(pdi - mdi) / (pdi + mdi) if (pdi + mdi) else 0.0)
    if len(dx) < n:
        return out
    prev = sum(dx[:n]) / n
    out[2 * n - 1] = prev
    for j in range(n, len(dx)):
        prev = (prev * (n - 1) + dx[j]) / n
        out[n + j] = prev
    return out


def returns(c: Sequence[float]) -> list[float]:
    return [NaN] + [c[i] / c[i - 1] - 1 if c[i - 1] else NaN for i in range(1, len(c))]


def roc(c: Sequence[float], n: int) -> list[float]:
    out = [NaN] * len(c)
    for i in range(n, len(c)):
        out[i] = c[i] / c[i - n] - 1 if c[i - n] else NaN
    return out


def zscore(v: Sequence[float], n: int) -> list[float]:
    m, s = sma(v, n), stdev(v, n)
    return [NaN if isnan(m[i]) or isnan(s[i]) or s[i] == 0 else (v[i] - m[i]) / s[i] for i in range(len(v))]


def realized_vol(c: Sequence[float], n: int = 20) -> list[float]:
    """Rolling stdev of simple returns (per-bar, not annualised)."""
    r = returns(c)
    out = [NaN] * len(c)
    for i in range(n, len(c)):
        w = r[i - n + 1 : i + 1]
        m = sum(w) / n
        out[i] = math.sqrt(sum((x - m) ** 2 for x in w) / (n - 1))
    return out


def percent_rank(v: Sequence[float], n: int) -> list[float]:
    """Fraction of the previous n values (excluding current) that are <= current."""
    out = [NaN] * len(v)
    for i in range(n, len(v)):
        if isnan(v[i]):
            continue
        w = [x for x in v[i - n : i] if not isnan(x)]
        if len(w) >= n // 2:
            out[i] = sum(1 for x in w if x <= v[i]) / len(w)
    return out


def ols(y: Sequence[float], x: Sequence[float]) -> tuple[float, float]:
    """Return (alpha, beta) of y = alpha + beta*x."""
    n = len(y)
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x)
    if sxx == 0:
        return my, 0.0
    beta = sum((a - mx) * (b - my) for a, b in zip(x, y)) / sxx
    return my - beta * mx, beta


def adf_stat(v: Sequence[float]) -> float:
    """Dickey-Fuller t-statistic (no lags, constant): d_v[t] = a + g*v[t-1] + e. Strongly negative => stationary.
    Rough guide: 5% critical value ~ -2.86 (large samples). Used only as a screening diagnostic."""
    y = [v[i] - v[i - 1] for i in range(1, len(v))]
    x = list(v[:-1])
    n = len(y)
    if n < 20:
        return NaN
    a, g = ols(y, x)
    res = [yy - a - g * xx for yy, xx in zip(y, x)]
    s2 = sum(r * r for r in res) / (n - 2)
    mx = sum(x) / n
    sxx = sum((xx - mx) ** 2 for xx in x)
    if sxx == 0 or s2 == 0:
        return NaN
    return g / math.sqrt(s2 / sxx)

"""Correlation analysis across aligned return series."""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from .stats import pearson, pct_returns


def correlation_matrix(prices: Mapping[str, Sequence[float]], min_obs: int = 30, high: float = 0.8) -> dict[str, Any]:
    names = sorted(prices)
    n = min((len(prices[s]) for s in names), default=0)
    if len(names) < 2 or n - 1 < min_obs:
        return {"status": "insufficient_data", "required_observations": min_obs, "symbols": names}
    rets = {s: pct_returns(list(prices[s])[-n:]) for s in names}
    matrix: dict[str, dict[str, float | None]] = {}
    pairs = []
    for i, a in enumerate(names):
        matrix[a] = {}
        for j, b in enumerate(names):
            c = 1.0 if a == b else pearson(rets[a], rets[b])
            matrix[a][b] = None if c is None else round(c, 4)
            if j > i and c is not None:
                pairs.append({"a": a, "b": b, "correlation": round(c, 4)})
    pairs.sort(key=lambda p: -abs(p["correlation"]))
    flagged = [p for p in pairs if abs(p["correlation"]) >= high]
    return {"status": "ok", "observations": n - 1, "matrix": matrix, "top_pairs": pairs[:10],
            "concentration_warnings": flagged,
            "notes": ["Pearson correlation of simple returns on aligned tails; correlations are unstable and rise in stress."]}


def rolling_correlation(a: Sequence[float], b: Sequence[float], window: int = 30) -> list[float | None]:
    ra, rb = pct_returns(a), pct_returns(b)
    n = min(len(ra), len(rb))
    ra, rb = ra[-n:], rb[-n:]
    return [None if i + 1 < window else (lambda c: None if c is None else round(c, 4))(pearson(ra[i + 1 - window:i + 1], rb[i + 1 - window:i + 1]))
            for i in range(n)]

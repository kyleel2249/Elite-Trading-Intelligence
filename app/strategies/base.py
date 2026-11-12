"""Strategy base class + shared causal helpers."""
from __future__ import annotations

import itertools
import math
from typing import Any, Optional, Sequence

from app.strategies import indicators as ind
from app.strategies.types import Bars, CostModel, MissingData, Plan, StrategySpec

NaN = float("nan")


def ok(*xs: Optional[float]) -> bool:
    return all(x is not None and not (isinstance(x, float) and math.isnan(x)) for x in xs)


class Strategy:
    spec: StrategySpec

    def __init__(self, **params: Any):
        unknown = set(params) - set(self.spec.params_default)
        if unknown:
            raise ValueError(f"Unknown parameters for {self.spec.id}: {sorted(unknown)}")
        self.params: dict[str, Any] = {**self.spec.params_default, **params}

    # -- contract -----------------------------------------------------------------
    def plan(self, bars: Bars, aux: Optional[dict[str, Any]] = None) -> Plan:  # pragma: no cover
        raise NotImplementedError

    def default_costs(self) -> CostModel:
        e = self.spec.expected_costs
        return CostModel(e.get("fee_bps_per_side", 5.0), e.get("slippage_bps_per_side", 2.0),
                         e.get("half_spread_bps", 1.0), e.get("short_carry_bps_per_bar", 0.0), 0.0)

    # -- helpers ------------------------------------------------------------------
    def require_ohlc(self, bars: Bars) -> None:
        if not bars.ohlc_complete:
            raise MissingData(self.spec.id, ["open/high/low"], "close-only data cannot evaluate this method")

    def require_volume(self, bars: Bars) -> None:
        if bars.v is None:
            raise MissingData(self.spec.id, ["volume"])

    def require_aux(self, aux: Optional[dict[str, Any]], keys: Sequence[str], n: int) -> dict[str, Any]:
        aux = aux or {}
        missing = [k for k in keys if aux.get(k) in (None, [], {})]
        if missing:
            raise MissingData(self.spec.id, missing)
        for k in keys:
            val = aux[k]
            seqs = val.values() if isinstance(val, dict) else [val]
            for s in seqs:
                if isinstance(s, (list, tuple)) and len(s) != n:
                    raise MissingData(self.spec.id, [k], f"series length {len(s)} != bars {n}; align point-in-time to bars")
        return aux

    def empty_trade_plan(self, n: int) -> Plan:
        return Plan(mode="trade", signal=[0] * n, exit_signal=[False] * n, stop_dist=[NaN] * n)

    def short_ok(self) -> bool:
        return bool(self.params.get("allow_short", False)) and self.spec.supports_short


def param_combos(grid: dict[str, list[Any]]) -> list[dict[str, Any]]:
    if not grid:
        return [{}]
    keys = list(grid)
    return [dict(zip(keys, vals)) for vals in itertools.product(*(grid[k] for k in keys))]


def swing_pivots(h: Sequence[float], l: Sequence[float], k: int = 3):
    """Causal swing pivots. A pivot at bar j is only *confirmed* (known) at bar j+k.
    Returns (swing_highs, swing_lows): lists of (pivot_index, confirm_index, price)."""
    highs, lows = [], []
    n = len(h)
    for j in range(k, n - k):
        if h[j] == max(h[j - k : j + k + 1]) and h[j] > max(h[j - k : j]):
            highs.append((j, j + k, h[j]))
        if l[j] == min(l[j - k : j + k + 1]) and l[j] < min(l[j - k : j]):
            lows.append((j, j + k, l[j]))
    return highs, lows


def last_confirmed(pivots, n: int, depth: int = 1):
    """For each bar i, the price of the `depth`-th most recent pivot confirmed at or before i (NaN if none)."""
    out = [NaN] * n
    p = 0
    for i in range(n):
        while p < len(pivots) and pivots[p][1] <= i:
            p += 1
        if p >= depth:
            out[i] = pivots[p - depth][2]
    return out


def vol_ratio(v: Optional[Sequence[float]], n: int) -> list[float]:
    """Volume / average volume of the previous n bars (excludes current)."""
    if v is None:
        return []
    m = ind.sma(v, n)
    out = [NaN] * len(v)
    for i in range(n, len(v)):
        out[i] = v[i] / m[i - 1] if ok(m[i - 1]) and m[i - 1] > 0 else NaN
    return out

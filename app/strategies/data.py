"""Alignment helpers: put every supplementary series on the main bar index WITHOUT look-ahead."""
from __future__ import annotations

import bisect
import math
from typing import Any, Optional

from app.strategies.types import Bars, MissingData


def align_bars(main: Bars, others: dict[str, Bars]) -> tuple[Bars, dict[str, list[float]]]:
    """Keep only timestamps present in every series (inner join on bar open time). Returns the reduced main bars and
    the aligned close series of each other asset. Raises MissingData if timestamps are unavailable or no overlap."""
    if main.t is None or any(o.t is None for o in others.values()):
        raise MissingData("data", ["timestamps"], "bars need open_time to be aligned")
    maps = {k: {t: i for i, t in enumerate(o.t)} for k, o in others.items()}
    keep = [i for i, t in enumerate(main.t) if all(t in m for m in maps.values())]
    if len(keep) < 50:
        raise MissingData("data", ["overlap"], f"only {len(keep)} common bars across symbols")
    sub = main.subset(keep)
    closes = {k: [others[k].c[maps[k][main.t[i]]] for i in keep] for k in others}
    return sub, closes


def align_asof(bar_ts: list[Any], series: list[list[float]]) -> list[Optional[float]]:
    """Point-in-time alignment. `series` = [[effective_ts, value], ...] sorted ascending, where effective_ts is when the
    value became PUBLIC. Each bar receives the latest value with effective_ts <= bar open time (None before the first)."""
    pairs = []
    for row in series:
        try:
            ts, val = row[0], row[1]
            if val is None or (isinstance(val, float) and math.isnan(val)):
                continue
            pairs.append((float(ts), float(val)))
        except (TypeError, ValueError, IndexError):
            raise MissingData("data", ["series"], "each observation must be [effective_ts_ms, value]")
    pairs.sort(key=lambda x: x[0])
    xs = [p[0] for p in pairs]
    out: list[Optional[float]] = []
    for t in bar_ts:
        j = bisect.bisect_right(xs, float(t)) - 1
        out.append(pairs[j][1] if j >= 0 else None)
    return out


def events_to_indices(bar_ts: list[Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map [{ts, surprise, kind}] to the bar during which the information became public. The strategy then acts after
    that bar's close, so the event can never be traded on information not yet released."""
    out = []
    ts_f = [float(t) for t in bar_ts]
    for e in events:
        try:
            ts, s = float(e["ts"]), float(e["surprise"])
        except (KeyError, TypeError, ValueError):
            raise MissingData("data", ["events"], "each event needs numeric ts (ms) and surprise")
        j = bisect.bisect_right(ts_f, ts) - 1
        if j < 0 or j >= len(ts_f) or math.isnan(s):
            continue  # event outside the tested window
        out.append({"index": j, "surprise": s, "kind": str(e.get("kind", "event"))})
    return out


def build_aux(bars: Bars, *, closes: Optional[dict[str, list[float]]] = None, pair_symbol: Optional[str] = None,
              basket_symbols: Optional[list[str]] = None, benchmark_symbol: Optional[str] = None,
              fundamentals: Optional[dict[str, list]] = None, macro: Optional[dict[str, list]] = None,
              events: Optional[list[dict]] = None, sentiment: Optional[list] = None) -> dict[str, Any]:
    aux: dict[str, Any] = {}
    closes = closes or {}
    if pair_symbol and pair_symbol in closes: aux["pair_close"] = closes[pair_symbol]
    if basket_symbols:
        aux["basket_closes"] = {s: closes[s] for s in basket_symbols if s in closes}
    if benchmark_symbol and benchmark_symbol in closes: aux["benchmark_close"] = closes[benchmark_symbol]
    ts = bars.t or []
    if fundamentals: aux["fundamentals"] = {k: align_asof(ts, v) for k, v in fundamentals.items()}
    if macro: aux["macro"] = {k: align_asof(ts, v) for k, v in macro.items()}
    if sentiment: aux["sentiment"] = align_asof(ts, sentiment)
    if events: aux["events"] = events_to_indices(ts, events)
    return aux

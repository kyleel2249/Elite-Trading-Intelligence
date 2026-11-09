"""Pure scoring + aggregate metrics. No I/O, no database."""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Callable, Iterable, Optional

NEUTRAL_BAND = 0.005  # neutral call is right if |return| <= 0.5%
MIN_SAMPLE = 30
SCORED_STATUSES = ("resolved", "invalidated")  # on-time outcomes; "late" is stored but not scored


def lateness_tolerance(horizon_seconds: int) -> float:
    return max(300.0, 0.10 * horizon_seconds)


def score_prediction(pred: dict[str, Any], realized_price: float, neutral_band: float = NEUTRAL_BAND) -> dict[str, Any]:
    entry = float(pred["entry_reference"])
    ret = realized_price / entry - 1.0
    d = pred["direction"]
    if d == "up":
        correct = realized_price > entry
    elif d == "down":
        correct = realized_price < entry
    else:
        correct = abs(ret) <= neutral_band

    lo, hi = pred.get("target_low"), pred.get("target_high")
    in_range = (min(lo, hi) <= realized_price <= max(lo, hi)) if lo is not None and hi is not None else None

    ref = pred.get("target_base")
    if ref is None and lo is not None and hi is not None:
        ref = (lo + hi) / 2.0
    abs_err = abs(realized_price - ref) if ref is not None else None
    pct_err = (realized_price - ref) / ref if ref else None

    inv = pred.get("invalidation_price")
    invalidated = False
    if inv is not None:
        invalidated = (realized_price <= inv) if d == "up" else (realized_price >= inv) if d == "down" else False

    return {
        "return_pct": ret, "direction_correct": correct, "in_target_range": in_range,
        "abs_error": abs_err, "pct_error": pct_err, "invalidated": invalidated,
    }


def _mean(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def calibration_bins(rows: list[dict[str, Any]], width: float = 0.1) -> list[dict[str, Any]]:
    nbins = int(round(1 / width))
    buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        buckets[min(int(r["probability"] / width), nbins - 1)].append(r)
    out = []
    for b in sorted(buckets):
        g = buckets[b]
        out.append({
            "bin": f"{b * width:.1f}-{(b + 1) * width:.1f}", "n": len(g),
            "mean_probability": _mean([x["probability"] for x in g]),
            "observed_frequency": _mean([1.0 if x["direction_correct"] else 0.0 for x in g]),
        })
    return out


def compute_metrics(rows: Iterable[dict[str, Any]], min_sample: int = MIN_SAMPLE) -> dict[str, Any]:
    """rows: flat dicts with prediction fields + outcome fields (status, direction_correct, ...)."""
    rows = list(rows)
    scored = [r for r in rows if r.get("status") in SCORED_STATUSES and r.get("direction_correct") is not None]
    n = len(scored)
    res: dict[str, Any] = {
        "n_scored": n, "n_late_excluded": sum(1 for r in rows if r.get("status") == "late"),
        "n_invalidated": sum(1 for r in scored if r.get("invalidated")),
        "sufficient_sample": n >= min_sample, "min_sample": min_sample,
    }
    if not n:
        res.update(directional_accuracy=None, target_range_hit_rate=None, n_with_targets=0,
                   mean_abs_pct_error=None, mean_abs_error=None, brier_score=None,
                   brier_skill_vs_coinflip=None, expected_calibration_error=None,
                   mean_probability=None, calibration_gap=None, calibration=[])
        return res
    acc = sum(1 for r in scored if r["direction_correct"]) / n
    tg = [r for r in scored if r.get("in_target_range") is not None]
    brier = _mean([(r["probability"] - (1.0 if r["direction_correct"] else 0.0)) ** 2 for r in scored])
    bins = calibration_bins(scored)
    ece = sum(b["n"] / n * abs(b["mean_probability"] - b["observed_frequency"]) for b in bins)
    mp = _mean([r["probability"] for r in scored])
    res.update(
        directional_accuracy=acc,
        target_range_hit_rate=(sum(1 for r in tg if r["in_target_range"]) / len(tg)) if tg else None,
        n_with_targets=len(tg),
        mean_abs_pct_error=_mean([abs(r["pct_error"]) for r in scored if r.get("pct_error") is not None]),
        mean_abs_error=_mean([r["abs_error"] for r in scored if r.get("abs_error") is not None]),
        brier_score=brier, brier_skill_vs_coinflip=1 - brier / 0.25,
        expected_calibration_error=ece, mean_probability=mp, calibration_gap=mp - acc, calibration=bins,
    )
    if not res["sufficient_sample"]:
        res["warning"] = f"Only {n} scored predictions (< {min_sample}); statistics are not reliable."
    return res


def group_metrics(rows: Iterable[dict[str, Any]], key: Callable[[dict[str, Any]], str]) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[key(r) or "unspecified"].append(r)
    out = {}
    for k, g in sorted(groups.items()):
        m = compute_metrics(g)
        m.pop("calibration", None)
        out[k] = m
    return out


def breakdowns(rows: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    return {
        "by_asset": group_metrics(rows, lambda r: r.get("asset")),
        "by_market": group_metrics(rows, lambda r: r.get("market")),
        "by_timeframe": group_metrics(rows, lambda r: r.get("horizon_label")),
        "by_regime": group_metrics(rows, lambda r: r.get("market_regime")),
        "by_strategy": group_metrics(rows, lambda r: r.get("strategy")),
    }

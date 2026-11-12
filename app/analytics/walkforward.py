"""Walk-forward optimisation: fit parameters in-sample, score only on the next unseen window."""
from __future__ import annotations

import itertools
from typing import Any, Callable, Mapping, Sequence

from .stats import max_drawdown, mean, sharpe

Signals = Callable[[Sequence[float], Mapping[str, Any]], list[int]]


def sma_cross_signals(closes: Sequence[float], p: Mapping[str, Any]) -> list[int]:
    fast, slow = int(p["fast"]), int(p["slow"])
    out = [0] * len(closes)
    for i in range(slow - 1, len(closes)):
        f = sum(closes[i - fast + 1:i + 1]) / fast
        s = sum(closes[i - slow + 1:i + 1]) / slow
        out[i] = 1 if f > s else 0
    return out


def breakout_signals(closes: Sequence[float], p: Mapping[str, Any]) -> list[int]:
    n = int(p["lookback"])
    out, pos = [0] * len(closes), 0
    for i in range(n, len(closes)):
        if closes[i] > max(closes[i - n:i]):
            pos = 1
        elif closes[i] < min(closes[i - n:i]):
            pos = 0
        out[i] = pos
    return out


STRATEGIES: dict[str, Signals] = {"sma_cross": sma_cross_signals, "channel_breakout": breakout_signals}


def simulate(closes: Sequence[float], signals: Sequence[int], fee_bps: float = 5.0, start: float = 10000.0) -> dict[str, Any]:
    """Long/flat; the signal at bar i is applied to the return of bar i+1 (no look-ahead)."""
    fee = fee_bps / 10000.0
    eq, curve, rets, pos, trades = start, [start], [], 0, 0
    for i in range(len(closes) - 1):
        target = signals[i]
        cost = 0.0
        if target != pos:
            cost = fee
            trades += 1 if target == 1 else 0
            pos = target
        r = pos * (closes[i + 1] / closes[i] - 1.0) - cost
        eq *= 1.0 + r
        rets.append(r)
        curve.append(eq)
    return {"return_pct": (eq / start - 1) * 100, "max_drawdown_pct": max_drawdown(curve) * 100,
            "trades": trades, "sharpe": sharpe(rets, 365.0), "returns": rets}


def _grid(grid: Mapping[str, Sequence[Any]]) -> list[dict[str, Any]]:
    keys = list(grid)
    return [dict(zip(keys, vals)) for vals in itertools.product(*(grid[k] for k in keys))]


def walk_forward(closes: Sequence[float], strategy: str, grid: Mapping[str, Sequence[Any]], train_bars: int = 120,
                 test_bars: int = 30, fee_bps: float = 5.0, min_trades: int = 3) -> dict[str, Any]:
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy '{strategy}'; choose from {sorted(STRATEGIES)}")
    fn = STRATEGIES[strategy]
    combos = _grid(grid)
    if not combos or len(combos) > 500:
        raise ValueError("parameter grid must have between 1 and 500 combinations")
    if len(closes) < train_bars + test_bars:
        return {"status": "insufficient_data", "required_bars": train_bars + test_bars, "provided_bars": len(closes)}
    folds, i = [], 0
    while i + train_bars + test_bars <= len(closes):
        train = closes[i:i + train_bars]
        best, best_score = None, None
        for p in combos:
            try:
                res = simulate(train, fn(train, p), fee_bps)
            except (ValueError, ZeroDivisionError):
                continue
            if res["trades"] < min_trades:
                continue
            score = res["return_pct"]
            if best_score is None or score > best_score:
                best, best_score = (p, res), score
        # test window gets `slow` warm-up bars from the training tail so indicators are defined at its start
        warm = max([int(v) for k, v in (best[0].items() if best else []) if isinstance(v, (int, float))] or [0])
        seg_start = i + train_bars - min(warm, train_bars)
        seg = closes[seg_start:i + train_bars + test_bars]
        if best is None:
            folds.append({"fold": len(folds), "status": "no_valid_parameters", "start_index": i + train_bars})
        else:
            sig = fn(seg, best[0])
            skip = i + train_bars - seg_start
            test = simulate(seg[skip:], sig[skip:], fee_bps)
            folds.append({"fold": len(folds), "status": "ok", "start_index": i + train_bars, "params": best[0],
                          "in_sample_return_pct": round(best_score, 3), "out_of_sample_return_pct": round(test["return_pct"], 3),
                          "out_of_sample_max_drawdown_pct": round(test["max_drawdown_pct"], 3), "trades": test["trades"]})
        i += test_bars
    ok = [f for f in folds if f["status"] == "ok"]
    if not ok:
        return {"status": "no_valid_folds", "folds": folds}
    is_avg = mean([f["in_sample_return_pct"] for f in ok])
    oos_avg = mean([f["out_of_sample_return_pct"] for f in ok])
    compounded = 1.0
    for f in ok:
        compounded *= 1 + f["out_of_sample_return_pct"] / 100
    ratio = oos_avg / is_avg if is_avg > 0 else None
    distinct = len({tuple(sorted(f["params"].items())) for f in ok})
    return {"status": "ok", "strategy": strategy, "folds": folds, "fold_count": len(ok),
            "oos_compounded_return_pct": round((compounded - 1) * 100, 3), "mean_oos_return_pct": round(oos_avg, 3),
            "mean_is_return_pct": round(is_avg, 3), "efficiency_ratio": None if ratio is None else round(ratio, 3),
            "distinct_parameter_sets": distinct,
            "overfit_warning": bool(ratio is not None and ratio < 0.3) or distinct > max(1, len(ok) // 2 + 1),
            "oos_positive_fold_share": round(sum(1 for f in ok if f["out_of_sample_return_pct"] > 0) / len(ok), 3),
            "notes": ["Parameters are chosen using training data only; reported performance is on later unseen windows.",
                      "Includes a flat fee per position change; excludes slippage, funding and market impact.",
                      "Past out-of-sample results do not guarantee future performance."]}


def compare_strategies(closes: Sequence[float], candidates: Sequence[Mapping[str, Any]], fee_bps: float = 5.0) -> dict[str, Any]:
    """Side-by-side metrics (same data, same costs). Candidates: {name, strategy, params}. Full-sample figures are in-sample."""
    rows = []
    for c in candidates:
        fn = STRATEGIES.get(c["strategy"])
        if fn is None:
            raise ValueError(f"unknown strategy '{c['strategy']}'")
        res = simulate(closes, fn(closes, c["params"]), fee_bps)
        rows.append({"name": c["name"], "strategy": c["strategy"], "params": c["params"], "return_pct": round(res["return_pct"], 3),
                     "max_drawdown_pct": round(res["max_drawdown_pct"], 3), "trades": res["trades"],
                     "sharpe": None if res["sharpe"] is None else round(res["sharpe"], 3)})
    buy_hold = (closes[-1] / closes[0] - 1) * 100 if len(closes) > 1 else 0.0
    rows.sort(key=lambda r: -r["return_pct"])
    return {"status": "ok", "bars": len(closes), "buy_and_hold_return_pct": round(buy_hold, 3), "results": rows,
            "notes": ["Full-sample comparison is in-sample; use walk-forward before trusting any ranking."]}

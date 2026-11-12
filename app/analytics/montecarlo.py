"""Monte Carlo simulation by (block) bootstrap of observed returns."""
from __future__ import annotations

import random
from typing import Any, Sequence

from .stats import max_drawdown, mean, percentile

MIN_RETURNS = 30
MAX_PATHS = 20000
MAX_HORIZON = 5000


def monte_carlo(
    returns: Sequence[float],
    horizon: int = 252,
    n_paths: int = 2000,
    start_equity: float = 10000.0,
    block_size: int = 1,
    seed: int | None = 42,
    ruin_threshold: float = 0.5,
) -> dict[str, Any]:
    rets = [float(r) for r in returns if r == r and abs(r) < 1.0]
    if len(rets) < MIN_RETURNS:
        return {"status": "insufficient_data", "required_returns": MIN_RETURNS, "provided_returns": len(rets)}
    if not (1 <= horizon <= MAX_HORIZON and 1 <= n_paths <= MAX_PATHS and start_equity > 0 and block_size >= 1):
        raise ValueError("horizon, n_paths, start_equity or block_size out of range")
    rng = random.Random(seed)
    block = min(block_size, len(rets))
    terminals: list[float] = []
    drawdowns: list[float] = []
    for _ in range(n_paths):
        eq = start_equity
        curve = [eq]
        while len(curve) <= horizon:
            start = rng.randrange(0, len(rets) - block + 1)
            for r in rets[start:start + block]:
                eq *= 1.0 + r
                curve.append(eq)
                if len(curve) > horizon:
                    break
        terminals.append(curve[-1])
        drawdowns.append(max_drawdown(curve))
    total = [t / start_equity - 1.0 for t in terminals]
    var95 = -percentile(total, 5)
    tail = [x for x in total if x <= -var95]
    return {
        "status": "ok",
        "method": "iid bootstrap" if block == 1 else f"block bootstrap (block={block})",
        "paths": n_paths, "horizon": horizon, "seed": seed, "start_equity": start_equity,
        "terminal_equity": {f"p{q}": round(percentile(terminals, q), 2) for q in (5, 25, 50, 75, 95)},
        "mean_terminal_equity": round(mean(terminals), 2),
        "probability_of_loss": round(sum(1 for x in total if x < 0) / n_paths, 4),
        "probability_of_ruin": round(sum(1 for t in terminals if t <= start_equity * ruin_threshold) / n_paths, 4),
        "ruin_threshold_fraction": ruin_threshold,
        "var_95_pct": round(var95 * 100, 3),
        "cvar_95_pct": round(-mean(tail) * 100, 3) if tail else round(var95 * 100, 3),
        "max_drawdown_pct": {f"p{q}": round(percentile(drawdowns, q) * 100, 3) for q in (50, 95)},
        "notes": [
            "Resamples past returns; assumes the future resembles the sample. Regime shifts and fat tails beyond the sample are not modelled.",
            "Research output, not a forecast or investment advice.",
        ],
    }

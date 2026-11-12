"""Pure, testable evaluation of a signal's assumptions against what actually happened.

Only assumption types with an objective check are evaluated. Everything else is reported as
``not_evaluable`` - the system never guesses whether an assumption held.

Context keys (all optional unless noted)::
    side            'long' | 'short'                       (required)
    exit_price      volume-weighted exit price
    gross_pnl       realized P/L before fees
    holding_seconds
    stop_price, target_price, horizon_seconds
    mfe_price, mae_price   best / worst marked price seen while the trade was open
    regime_entry, regime_exit
    entry_slippage_bps, exit_slippage_bps (adverse positive)
    slippage_alert_bps
"""
from __future__ import annotations

from typing import Any, Callable, Optional

HELD = "held"
FAILED = "failed"
NOT_EVALUABLE = "not_evaluable"


def _param(a: dict[str, Any], ctx: dict[str, Any], name: str, ctx_key: Optional[str] = None) -> Any:
    params = a.get("params") or {}
    if params.get(name) is not None:
        return params[name]
    return ctx.get(ctx_key or name)


def _direction(a: dict[str, Any], c: dict[str, Any]) -> tuple[str, str]:
    g = c.get("gross_pnl")
    if g is None:
        return NOT_EVALUABLE, "no realized pnl"
    return (HELD if g > 0 else FAILED), f"gross_pnl={g:.6f}"


def _target_reached(a: dict[str, Any], c: dict[str, Any]) -> tuple[str, str]:
    target = _param(a, c, "price", "target_price")
    if target is None:
        return NOT_EVALUABLE, "no target price"
    side = c.get("side")
    seen = [x for x in (c.get("exit_price"), c.get("mfe_price")) if x is not None]
    if not seen or side not in ("long", "short"):
        return NOT_EVALUABLE, "no price path"
    best = max(seen) if side == "long" else min(seen)
    basis = "mfe+exit" if c.get("mfe_price") is not None else "exit_only"
    reached = best >= target if side == "long" else best <= target
    return (HELD if reached else FAILED), f"best={best} target={target} basis={basis}"


def _stop_respected(a: dict[str, Any], c: dict[str, Any]) -> tuple[str, str]:
    stop = _param(a, c, "price", "stop_price")
    if stop is None or stop <= 0:
        return NOT_EVALUABLE, "no stop price"
    side = c.get("side")
    seen = [x for x in (c.get("exit_price"), c.get("mae_price")) if x is not None]
    if not seen or side not in ("long", "short"):
        return NOT_EVALUABLE, "no price path"
    worst = min(seen) if side == "long" else max(seen)
    breach_bps = ((stop - worst) if side == "long" else (worst - stop)) / stop * 1e4
    tol = float((a.get("params") or {}).get("tolerance_bps", 10.0))
    return (HELD if breach_bps <= tol else FAILED), f"breach_bps={breach_bps:.2f} tolerance_bps={tol}"


def _horizon(a: dict[str, Any], c: dict[str, Any]) -> tuple[str, str]:
    horizon = _param(a, c, "seconds", "horizon_seconds")
    held_for = c.get("holding_seconds")
    if horizon is None or held_for is None:
        return NOT_EVALUABLE, "no horizon or holding time"
    return (HELD if held_for <= horizon else FAILED), f"held={held_for:.0f}s horizon={horizon}s"


def _regime_stable(a: dict[str, Any], c: dict[str, Any]) -> tuple[str, str]:
    r0, r1 = c.get("regime_entry"), c.get("regime_exit")
    bad = (None, "", "unknown", "unclassified")
    if r0 in bad or r1 in bad:
        return NOT_EVALUABLE, f"regime unclassified entry={r0} exit={r1}"
    return (HELD if r0 == r1 else FAILED), f"entry={r0} exit={r1}"


def _max_slippage(a: dict[str, Any], c: dict[str, Any]) -> tuple[str, str]:
    limit = float((a.get("params") or {}).get("max_bps", c.get("slippage_alert_bps", 10.0)))
    vals = [v for v in (c.get("entry_slippage_bps"), c.get("exit_slippage_bps")) if v is not None]
    if not vals:
        return NOT_EVALUABLE, "no expected price to measure slippage against"
    worst = max(max(vals), 0.0)
    return (HELD if worst <= limit else FAILED), f"worst_bps={worst:.2f} limit_bps={limit}"


_CHECKS: dict[str, Callable[[dict[str, Any], dict[str, Any]], tuple[str, str]]] = {
    "direction": _direction,
    "target_reached": _target_reached,
    "stop_respected": _stop_respected,
    "horizon": _horizon,
    "regime_stable": _regime_stable,
    "max_slippage_bps": _max_slippage,
}

SUPPORTED_TYPES = tuple(_CHECKS.keys())


def evaluate_assumptions(assumptions: Optional[list[dict[str, Any]]], ctx: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in assumptions or []:
        if not isinstance(a, dict):
            continue
        t = str(a.get("type") or "").lower()
        base = {"id": a.get("id") or t or "unnamed", "type": t or "custom", "statement": a.get("statement")}
        fn = _CHECKS.get(t)
        if fn is None:
            out.append({**base, "result": NOT_EVALUABLE, "detail": "no automatic check for this assumption type"})
            continue
        try:
            result, detail = fn(a, ctx)
        except Exception:  # a malformed assumption must never break the learning loop
            result, detail = NOT_EVALUABLE, "check_error"
        out.append({**base, "result": result, "detail": detail})
    return out


def split_results(evaluated: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    return {
        "held": [e for e in evaluated if e["result"] == HELD],
        "failed": [e for e in evaluated if e["result"] == FAILED],
        "not_evaluable": [e for e in evaluated if e["result"] == NOT_EVALUABLE],
    }

"""Protective stop-loss / take-profit planning for a filled long position (pure, no I/O).

Spot venues protect a long with a SELL one-cancels-the-other (OCO) order: a take-profit limit above the market and a
stop-loss below it. A plan with several targets becomes several OCO tranches that share the stop. Prices and
quantities are rounded to the venue's tick and lot size, tranches that fall under the venue's minimum size are
merged into the next target, and an unprotectable plan is reported as problems rather than guessed at.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from . import guards
from .domain import InstrumentRules, Side

MAX_TARGETS = 3
STOP_LIMIT_BUFFER = 0.002        # the stop's limit price sits 0.2% below its trigger so the stop can actually fill


@dataclass
class Tranche:
    qty: float
    take_profit: float
    stop_price: float
    stop_limit: float


def plan_protection(filled_qty: float, avg_price: float, stop_loss, take_profits, rules: InstrumentRules,
                    fee_buffer_pct: float = 0.25) -> tuple:
    """Returns (tranches, problems). take_profits: [{"price": float, "fraction": float}], fractions summing to at most 1."""
    problems: list = []
    try:
        stop = float(stop_loss)
        tps = [(float(t["price"]), float(t["fraction"])) for t in (take_profits or [])]
    except (TypeError, ValueError, KeyError):
        return [], ["Protective plan is malformed (stop_loss and take_profits[{price, fraction}] are required)"]
    if not (avg_price > 0 and filled_qty > 0):
        return [], ["No filled quantity to protect"]
    if not (stop > 0) or stop >= avg_price:
        problems.append(f"Stop-loss {stop} must be below the fill price {avg_price} for a long position")
    if not tps or len(tps) > MAX_TARGETS:
        problems.append(f"Between 1 and {MAX_TARGETS} take-profit targets are required")
    elif any(p <= avg_price or f <= 0 or f > 1 for p, f in tps) or sorted(p for p, _ in tps) != [p for p, _ in tps]:
        problems.append("Take-profits must be ascending, above the fill price, with fractions in (0, 1]")
    elif sum(f for _, f in tps) > 1 + 1e-9:
        problems.append("Take-profit fractions sum to more than 1")
    if problems:
        return [], problems
    # Exchange fees taken in the base asset reduce the sellable balance, so protect slightly less than was bought.
    sellable = guards.round_down(filled_qty * (1 - fee_buffer_pct / 100.0), rules.step_size) if rules.step_size else filled_qty * (1 - fee_buffer_pct / 100.0)
    total_fraction = sum(f for _, f in tps)
    raw = []
    for i, (price, f) in enumerate(tps):
        q = sellable * f / total_fraction
        raw.append([guards.round_down(q, rules.step_size) if rules.step_size else q, price])
    # Merge tranches below the venue minimums into the next (higher) target; the last merges into the previous one.
    changed = True
    while changed and len(raw) > 0:
        changed = False
        for i, (q, price) in enumerate(raw):
            if guards.rules_problems(q, price, rules):
                if len(raw) == 1:
                    return [], [f"Protected quantity {q} is below the venue minimum size: {'; '.join(guards.rules_problems(q, price, rules))}"]
                j = i + 1 if i + 1 < len(raw) else i - 1
                raw[j][0] = (guards.round_down(raw[j][0] + q, rules.step_size) if rules.step_size else raw[j][0] + q)
                del raw[i]
                changed = True
                break
    tick = rules.tick_size
    stop_r = guards.round_price(stop, tick, Side.SELL) if tick else stop
    limit_r = guards.round_price(stop * (1 - STOP_LIMIT_BUFFER), tick, Side.SELL) if tick else stop * (1 - STOP_LIMIT_BUFFER)
    limit_r = min(limit_r, stop_r)
    out = []
    for q, price in raw:
        tp_r = guards.round_price(price, tick, Side.SELL) if tick else price
        out.append(Tranche(q, tp_r, stop_r, limit_r))
    bad = [t for t in out if not (t.stop_limit > 0 and t.stop_price < t.take_profit)]
    if bad:
        return [], ["Rounded stop and take-profit prices are not in a valid order at this tick size"]
    return out, []


# ---------------------------------------------------------------------------------------------------------------------
# Stop management after take-profits fill (Phase 9). Tighten-only: a stop is never moved down, and never moved to a level the
# market has already crossed. Stages: 0 original stop; 1 break-even (after TP1 filled); 2 trail to TP1 (after TP2 filled).
STAGE_TAGS = {0: "orig", 1: "be", 2: "trail"}
STAGE_RANK = {"orig": 0, "be": 1, "trail": 2}
BREAKEVEN_COST_PCT = 0.25            # entry plus round-trip fees/slippage: a "break-even" stop that really breaks even
MARKET_MARGIN = 0.002                # a SELL stop must sit at least this far below the bid, or it would trigger immediately


def desired_stage(filled_tranches: int) -> int:
    return 2 if filled_tranches >= 2 else 1 if filled_tranches == 1 else 0


def plan_stop_adjustment(stage: int, entry_price: float, tp1_price, current_stop: float, bid: float, rules: InstrumentRules):
    """Return (stop, stop_limit, None) for a valid tightening, or (None, None, reason) when the stop must be left alone."""
    if stage <= 0:
        return None, None, "no take-profit has filled yet"
    target = entry_price * (1 + BREAKEVEN_COST_PCT / 100.0) if stage == 1 else (tp1_price if tp1_price else None)
    if not target or target <= 0:
        return None, None, "no reference level for the new stop"
    tick = rules.tick_size or 0.0
    snap = (lambda x: math.floor(x / tick + 1e-9) * tick) if tick else (lambda x: x)
    stop = snap(min(target, bid * (1 - MARKET_MARGIN)))
    if stage == 1 and stop < target - (tick or 0):
        return None, None, "market is too close to entry for a break-even stop"
    if stop <= current_stop * (1 + 1e-9) + (tick or 0) * 0.5:
        return None, None, "not tighter than the current stop"
    limit = snap(stop * (1 - STOP_LIMIT_BUFFER))
    if limit <= 0 or limit >= stop:
        return None, None, "stop-limit would be invalid"
    return round(stop, 8), round(limit, 8), None

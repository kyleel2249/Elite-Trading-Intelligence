"""Cost-aware backtest engine.

Guarantees (each covered by tests):
* No look-ahead: signals formed on the close of bar i are filled at the open of bar i+1.
* Stops are checked intrabar against the low/high; if stop and target both lie inside a bar the STOP wins.
* Gaps through a stop fill at the (worse) open, not at the stop price.
* Every fill pays fees + slippage + half-spread against the trader; shorts pay carry.
* Position size = risk% of equity / stop distance, capped by max leverage. No pyramiding.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

from app.strategies.types import Bars, CostModel, Plan, RiskModel

NaN = float("nan")

BARS_PER_YEAR_24x7 = {"1m": 525600, "3m": 175200, "5m": 105120, "15m": 35040, "30m": 17520, "1h": 8760,
                      "2h": 4380, "4h": 2190, "6h": 1460, "8h": 1095, "12h": 730, "1d": 365, "3d": 122, "1w": 52}
BARS_PER_YEAR_EQUITY = {"1m": 98280, "5m": 19656, "15m": 6552, "30m": 3276, "1h": 1638, "4h": 410, "1d": 252, "1w": 52}


def bars_per_year(interval: str, calendar: str = "24x7") -> float:
    table = BARS_PER_YEAR_24x7 if calendar == "24x7" else BARS_PER_YEAR_EQUITY
    return float(table.get(interval, 252 if calendar != "24x7" else 365))


@dataclass
class RunResult:
    trades: list[dict[str, Any]] = field(default_factory=list)
    bar_returns: list[float] = field(default_factory=list)     # net per-bar strategy returns over [start, end)
    equity: list[float] = field(default_factory=list)
    exposure_bars: int = 0
    costs_paid: float = 0.0
    start: int = 0
    end: int = 0


def _fill(px: float, side: int, cost: CostModel) -> float:
    """Adverse price after slippage + half-spread. side=+1 buying, -1 selling."""
    adj = (cost.slippage_bps + cost.half_spread_bps) / 1e4
    return px * (1 + adj) if side > 0 else px * (1 - adj)


def run_trade(bars: Bars, plan: Plan, cost: CostModel, risk: RiskModel, start: int = 0, end: Optional[int] = None) -> RunResult:
    n = len(bars)
    end = n if end is None else min(end, n)
    o, h, l, c = bars.o, bars.h, bars.l, bars.c
    eq = risk.initial_equity
    res = RunResult(start=start, end=end)
    pos = 0; qty = 0.0; entry_px = 0.0; stop = NaN; sdist = NaN; entry_i = 0; target = NaN; entry_fee = 0.0
    pend_exit = False; pend_entry: Optional[tuple[int, float]] = None
    prev_close_eq = eq

    def close_pos(i: int, px: float, reason: str, apply_slip: bool = True) -> None:
        nonlocal eq, pos, qty, entry_fee
        side = -pos
        fp = _fill(px, side, cost) if apply_slip else px
        notional = qty * fp
        fee = notional * cost.fee_bps / 1e4
        gross = pos * qty * (fp - entry_px)
        pnl = gross - fee - entry_fee
        res.costs_paid += fee
        eq += gross - fee
        risk_amt = qty * sdist if sdist and not math.isnan(sdist) else NaN
        res.trades.append({"entry_i": entry_i, "exit_i": i, "dir": pos, "entry_px": entry_px, "exit_px": fp,
                           "qty": qty, "pnl": pnl, "pnl_pct": pnl / max(eq - pnl, 1e-9) * 100,
                           "r": (pnl / risk_amt) if risk_amt and not math.isnan(risk_amt) and risk_amt > 0 else NaN,
                           "bars": i - entry_i, "reason": reason})
        pos = 0; qty = 0.0; entry_fee = 0.0

    for i in range(start, end):
        # 1) fills at the open
        if pos != 0 and pend_exit:
            close_pos(i, o[i], "signal_exit"); pend_exit = False
        if pos == 0 and pend_entry is not None and eq > 0:
            d, sd = pend_entry
            if sd > 0 and not math.isnan(sd):
                fp = _fill(o[i], d, cost)
                units = (eq * risk.risk_pct / 100.0) / sd
                units = min(units, eq * risk.max_leverage / fp)
                if units > 0:
                    fee = units * fp * cost.fee_bps / 1e4
                    eq -= fee; res.costs_paid += fee
                    pos, qty, entry_px, entry_i, sdist, entry_fee = d, units, fp, i, sd, fee
                    stop = fp - d * sd
                    target = fp + d * sd * plan.take_profit_r if plan.take_profit_r else NaN
        pend_entry = None
        # 2) intrabar risk checks
        if pos != 0:
            if pos > 0 and l[i] <= stop:
                close_pos(i, min(o[i], stop), "stop")
            elif pos < 0 and h[i] >= stop:
                close_pos(i, max(o[i], stop), "stop")
            elif not math.isnan(target) and ((pos > 0 and h[i] >= target) or (pos < 0 and l[i] <= target)):
                close_pos(i, target if (o[i] < target if pos > 0 else o[i] > target) else o[i], "target", apply_slip=True)
        # 3) mark to market at the close, charge carry
        if pos != 0:
            res.exposure_bars += 1
            carry = (cost.long_carry_bps_per_bar if pos > 0 else cost.short_carry_bps_per_bar) / 1e4 * qty * c[i]
            if carry:
                eq -= carry; res.costs_paid += carry
            mtm = eq + pos * qty * (c[i] - entry_px)
        else:
            mtm = eq
        res.bar_returns.append(mtm / prev_close_eq - 1 if prev_close_eq > 0 else 0.0)
        res.equity.append(mtm); prev_close_eq = mtm
        # 4) decisions on the close of bar i -> executed next open
        if pos != 0:
            if plan.trail:
                ns = c[i] - pos * sdist
                stop = max(stop, ns) if pos > 0 else min(stop, ns)
            if plan.max_hold and i - entry_i >= plan.max_hold:
                pend_exit = True
            if plan.exit_signal[i]:
                pend_exit = True
            if plan.reverse and plan.signal[i] == -pos:
                pend_exit = True
                pend_entry = (plan.signal[i], plan.stop_dist[i])
        elif plan.signal[i] != 0 and not math.isnan(plan.stop_dist[i]):
            pend_entry = (plan.signal[i], plan.stop_dist[i])
    # Close any open position at the final close so every trade is realised in the stats
    if pos != 0 and end > start:
        close_pos(end - 1, c[end - 1], "end_of_data")
        if res.equity:
            res.equity[-1] = eq
            res.bar_returns[-1] = eq / (res.equity[-2] if len(res.equity) > 1 else risk.initial_equity) - 1
    return res


def run_exposure(closes: list[float], plan: Plan, cost: CostModel, risk: RiskModel, start: int = 0, end: Optional[int] = None) -> RunResult:
    n = len(closes)
    end = n if end is None else min(end, n)
    rets = plan.asset_returns or ([NaN] + [closes[i] / closes[i - 1] - 1 for i in range(1, n)])
    eq = risk.initial_equity
    res = RunResult(start=start, end=end)
    prev_e = 0.0
    trade_ret = 1.0; trade_start = 0; trade_dir = 0
    side_cost = cost.per_side_bps / 1e4 * plan.cost_multiplier
    for i in range(start, end):
        e = plan.exposure[i - 1] if i >= 1 else 0.0
        e = 0.0 if (e is None or math.isnan(e)) else max(-risk.max_leverage, min(risk.max_leverage, e))
        r = rets[i] if i < len(rets) and not math.isnan(rets[i]) else 0.0
        turnover = abs(e - prev_e)
        c_frac = turnover * side_cost
        if e < 0:
            c_frac += abs(e) * cost.short_carry_bps_per_bar / 1e4
        elif e > 0:
            c_frac += e * cost.long_carry_bps_per_bar / 1e4
        br = e * r - c_frac
        eq *= (1 + br); res.costs_paid += c_frac * (eq / (1 + br) if (1 + br) else eq)
        res.bar_returns.append(br); res.equity.append(eq)
        if e != 0:
            res.exposure_bars += 1
        d = 0 if e == 0 else (1 if e > 0 else -1)
        if d != trade_dir:
            if trade_dir != 0:
                res.trades.append({"entry_i": trade_start, "exit_i": i, "dir": trade_dir, "pnl_pct": (trade_ret - 1) * 100,
                                   "pnl": (trade_ret - 1) * risk.initial_equity, "r": NaN, "bars": i - trade_start, "reason": "exposure_change"})
            trade_dir, trade_start, trade_ret = d, i, 1.0
        if trade_dir != 0:
            trade_ret *= (1 + br)
        prev_e = e
    if trade_dir != 0:
        res.trades.append({"entry_i": trade_start, "exit_i": end - 1, "dir": trade_dir, "pnl_pct": (trade_ret - 1) * 100,
                           "pnl": (trade_ret - 1) * risk.initial_equity, "r": NaN, "bars": end - 1 - trade_start, "reason": "end_of_data"})
    return res


def run(bars: Bars, plan: Plan, cost: CostModel, risk: RiskModel, start: int = 0, end: Optional[int] = None) -> RunResult:
    return run_exposure(bars.c, plan, cost, risk, start, end) if plan.mode == "exposure" else run_trade(bars, plan, cost, risk, start, end)


# ------------------------------------------------------------------ metrics
def _mean(x): return sum(x) / len(x) if x else 0.0


def _std(x):
    if len(x) < 2: return 0.0
    m = _mean(x); return math.sqrt(sum((a - m) ** 2 for a in x) / (len(x) - 1))


def max_drawdown_pct(returns: list[float]) -> float:
    peak = eq = 1.0; mdd = 0.0
    for r in returns:
        eq *= 1 + r; peak = max(peak, eq); mdd = max(mdd, (peak - eq) / peak if peak else 0)
    return mdd * 100


def metrics(returns: list[float], trades: list[dict[str, Any]], bpy: float, exposure_bars: int = 0, costs_paid: float = 0.0,
            initial_equity: float = 10_000.0) -> dict[str, Any]:
    n = len(returns)
    growth = 1.0
    for r in returns: growth *= 1 + r
    total = (growth - 1) * 100
    years = n / bpy if bpy else 0
    cagr = ((growth ** (1 / years) - 1) * 100) if years > 0.25 and growth > 0 else None
    sd = _std(returns); m = _mean(returns)
    down = [min(r, 0.0) for r in returns]
    dsd = math.sqrt(sum(d * d for d in down) / n) if n else 0.0
    sharpe = (m / sd * math.sqrt(bpy)) if sd > 0 else None
    sortino = (m / dsd * math.sqrt(bpy)) if dsd > 0 else None
    mdd = max_drawdown_pct(returns)
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]; losses = [t["pnl"] for t in trades if t["pnl"] <= 0]
    gp, gl = sum(wins), -sum(losses)
    pf = (gp / gl) if gl > 0 else (None if gp == 0 else float("inf"))
    rs = [t["r"] for t in trades if t.get("r") is not None and not math.isnan(t["r"])]
    return {
        "bars": n, "trades": len(trades), "total_return_pct": round(total, 4),
        "cagr_pct": None if cagr is None else round(cagr, 4),
        "annual_vol_pct": round(sd * math.sqrt(bpy) * 100, 4) if sd else 0.0,
        "sharpe": None if sharpe is None else round(sharpe, 4), "sortino": None if sortino is None else round(sortino, 4),
        "max_drawdown_pct": round(mdd, 4), "calmar": round(cagr / mdd, 4) if cagr is not None and mdd > 0 else None,
        "win_rate": round(len(wins) / len(trades), 4) if trades else None,
        "profit_factor": None if pf is None else (round(pf, 4) if pf != float("inf") else 999.0),
        "expectancy_pct": round(_mean([t["pnl_pct"] for t in trades]), 4) if trades else None,
        "avg_r": round(_mean(rs), 4) if rs else None,
        "avg_bars_held": round(_mean([t["bars"] for t in trades]), 2) if trades else None,
        "exposure_pct": round(exposure_bars / n * 100, 2) if n else 0.0,
        "costs_paid_pct_of_start_equity": round(costs_paid / initial_equity * 100, 4),
    }

"""Performance, health-score and report maths computed from stored fills. Pure functions, no I/O.

Everything is derived from realized P&L on SELL fills (fee-inclusive, average-cost accounting from the paper
engine). Unrealized P&L is shown separately by the account summary and is not part of these ratios.
"""
from __future__ import annotations

import csv
import io
import math
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

MIN_RATIO_DAYS = 30            # Sharpe / Sortino need at least this many days with a closed trade
RANGE_DAYS = {"1D": 1, "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "ALL": None}
MAX_CURVE_POINTS = 400


def parse_ts(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def closed_trades(fills: list[dict]) -> list[dict]:
    """Each SELL fill realizes P&L; that is one closed (partial) trade."""
    out = []
    for f in fills:
        ts, pnl = parse_ts(f.get("ts")), f.get("realized_pnl")
        if f.get("side") != "sell" or ts is None or not _finite(pnl):
            continue
        out.append({"ts": ts, "symbol": f.get("symbol"), "pnl": float(pnl), "fee": float(f.get("fee") or 0.0),
                    "qty": float(f.get("qty") or 0.0), "price": float(f.get("price") or 0.0)})
    out.sort(key=lambda t: t["ts"])
    return out


def average_holding_seconds(fills: list[dict]) -> Optional[float]:
    """FIFO-match sells to earlier buys per symbol; quantity-weighted mean holding time."""
    lots: dict[str, deque] = defaultdict(deque)
    total_w = total = 0.0
    for f in sorted(fills, key=lambda x: parse_ts(x.get("ts")) or datetime.min.replace(tzinfo=timezone.utc)):
        ts, qty, sym = parse_ts(f.get("ts")), f.get("qty"), f.get("symbol")
        if ts is None or not _finite(qty) or qty <= 0:
            continue
        if f.get("side") == "buy":
            lots[sym].append([float(qty), ts])
        elif f.get("side") == "sell":
            rem = float(qty)
            while rem > 1e-12 and lots[sym]:
                lot = lots[sym][0]
                take = min(rem, lot[0])
                total += (ts - lot[1]).total_seconds() * take
                total_w += take
                lot[0] -= take
                rem -= take
                if lot[0] <= 1e-12:
                    lots[sym].popleft()
    return total / total_w if total_w > 0 else None


def _downsample(points: list[dict]) -> list[dict]:
    if len(points) <= MAX_CURVE_POINTS:
        return points
    step = math.ceil(len(points) / MAX_CURVE_POINTS)
    out = points[::step]
    if out[-1] is not points[-1]:
        out.append(points[-1])
    return out


def performance(fills: list[dict], starting_cash: float, range_key: str = "ALL",
                now: Optional[datetime] = None) -> dict[str, Any]:
    key = (range_key or "ALL").upper()
    if key not in RANGE_DAYS:
        raise ValueError(f"range must be one of {', '.join(RANGE_DAYS)}")
    now = now or datetime.now(timezone.utc)
    days = RANGE_DAYS[key]
    start = now - timedelta(days=days) if days else None

    all_trades = closed_trades(fills)
    trades = [t for t in all_trades if start is None or t["ts"] >= start]
    in_range = [f for f in fills if start is None or ((parse_ts(f.get("ts")) or start - timedelta(days=1)) >= start)]

    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] < 0]
    gross_profit, gross_loss = sum(wins), -sum(losses)
    n = len(trades)
    net = sum(t["pnl"] for t in trades)

    if gross_loss > 0:
        pf, pf_note = gross_profit / gross_loss, None
    else:
        pf, pf_note = None, ("no losing trades in range" if wins else "no closed trades in range")

    # Realized equity curve inside the range (starts from equity at range start).
    base = starting_cash + sum(t["pnl"] for t in all_trades if start is not None and t["ts"] < start)
    eq, peak, max_dd_abs, max_dd_pct = base, base, 0.0, 0.0
    curve = [{"ts": (start or (trades[0]["ts"] if trades else now)).isoformat(), "equity": base}]
    day_start_equity: dict[str, float] = {}
    day_pnl: dict[str, float] = defaultdict(float)
    for t in trades:
        d = t["ts"].date().isoformat()
        day_start_equity.setdefault(d, eq)
        day_pnl[d] += t["pnl"]
        eq += t["pnl"]
        peak = max(peak, eq)
        dd = peak - eq
        if dd > max_dd_abs:
            max_dd_abs = dd
            max_dd_pct = dd / peak * 100.0 if peak > 0 else 0.0
        curve.append({"ts": t["ts"].isoformat(), "equity": eq})

    rets = [day_pnl[d] / day_start_equity[d] for d in sorted(day_pnl) if day_start_equity[d] > 0]
    sharpe = sortino = None
    ratio_note = None
    if len(rets) >= MIN_RATIO_DAYS:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        sd = math.sqrt(var)
        sharpe = mean / sd * math.sqrt(365) if sd > 0 else None
        dsd = math.sqrt(sum(min(r, 0.0) ** 2 for r in rets) / len(rets))
        sortino = mean / dsd * math.sqrt(365) if dsd > 0 else None
    else:
        ratio_note = f"Sharpe/Sortino need >= {MIN_RATIO_DAYS} days with closed trades (have {len(rets)}); not computed"

    def rolling(d: int) -> float:
        cut = now - timedelta(days=d)
        return sum(t["pnl"] for t in all_trades if t["ts"] >= cut)

    return {
        "range": key, "starting_cash": starting_cash, "trades": n, "wins": len(wins), "losses": len(losses),
        "win_rate": len(wins) / n if n else None,
        "gross_profit": gross_profit, "gross_loss": gross_loss, "profit_factor": pf, "profit_factor_note": pf_note,
        "net_realized_pnl": net,
        "avg_win": sum(wins) / len(wins) if wins else None,
        "avg_loss": sum(losses) / len(losses) if losses else None,
        "payoff_ratio": (sum(wins) / len(wins)) / (-sum(losses) / len(losses)) if wins and losses else None,
        "expectancy": net / n if n else None,
        "best_trade": max((t["pnl"] for t in trades), default=None),
        "worst_trade": min((t["pnl"] for t in trades), default=None),
        "fees_paid": sum(float(f.get("fee") or 0.0) for f in in_range if _finite(f.get("fee"))),
        "volume": sum(float(f["qty"]) * float(f["price"]) for f in in_range if _finite(f.get("qty")) and _finite(f.get("price"))),
        "avg_holding_seconds": average_holding_seconds(in_range),
        "max_drawdown_pct": max_dd_pct, "max_drawdown_abs": max_dd_abs,
        "recovery_factor": net / max_dd_abs if max_dd_abs > 0 else None,
        "sharpe": sharpe, "sortino": sortino, "ratio_note": ratio_note,
        "equity_curve": _downsample(curve),
        "rolling_pnl": {"daily": rolling(1), "weekly": rolling(7), "monthly": rolling(30)},
        "basis": "Realized, fee-inclusive P&L on closed (sell) fills. Unrealized P&L is reported separately.",
    }


_WEIGHTS = {"drawdown": 30, "exposure": 15, "concentration": 15, "daily_pnl": 10, "data_connection": 15, "background_jobs": 15}


def health_score(*, drawdown_pct: Optional[float] = None, exposure_pct: Optional[float] = None,
                 max_position_pct: Optional[float] = None, daily_pnl_pct: Optional[float] = None,
                 data_connected: Optional[bool] = None, jobs_total: int = 0, jobs_errored: int = 0,
                 halted: bool = False) -> dict[str, Any]:
    """Trading-health score from defined, measurable criteria. Unmeasured criteria are excluded (and reported),
    never assumed to be fine."""
    spec = {
        "drawdown": (None if drawdown_pct is None else 1 - drawdown_pct / 20.0,
                     "1.0 at 0% drawdown, 0 at >= 20%"),
        "exposure": (None if exposure_pct is None else 1 - max(0.0, exposure_pct - 50.0) / 50.0,
                     "1.0 up to 50% of equity invested, 0 at 100%"),
        "concentration": (None if max_position_pct is None else 1 - max(0.0, max_position_pct - 25.0) / 75.0,
                          "1.0 while the largest position is <= 25% of equity, 0 at 100%"),
        "daily_pnl": (None if daily_pnl_pct is None else 1 + min(0.0, daily_pnl_pct) / 3.0,
                      "1.0 at break-even or better, 0 at a -3% day"),
        "data_connection": (None if data_connected is None else (1.0 if data_connected else 0.0),
                            "live market stream connected"),
        "background_jobs": (None if jobs_total <= 0 else 1 - jobs_errored / jobs_total,
                            "share of background agents without errors"),
    }
    comps = [{"name": k, "weight": _WEIGHTS[k], "score": None if v[0] is None else round(_clamp(v[0]), 3),
              "rule": v[1]} for k, v in spec.items()]
    ev = [c for c in comps if c["score"] is not None]
    wsum = sum(c["weight"] for c in ev)
    score = round(sum(c["weight"] * c["score"] for c in ev) / wsum * 100) if wsum else None
    label = None if score is None else ("Excellent" if score >= 85 else "Good" if score >= 70 else "Fair" if score >= 50 else "Poor")
    dd, ex, dp = drawdown_pct or 0.0, exposure_pct or 0.0, daily_pnl_pct
    if not ev:
        risk = None
    elif dd >= 10 or ex >= 90 or (dp is not None and dp <= -3):
        risk = "High"
    elif dd >= 5 or ex >= 60 or (dp is not None and dp <= -1):
        risk = "Moderate"
    else:
        risk = "Low"
    if halted:
        readiness = "halted"
    elif data_connected is False:
        readiness = "not_ready"
    elif score is None:
        readiness = "unknown"
    else:
        readiness = "ready" if score >= 50 else "degraded"
    return {"score": score, "label": label, "risk_level": risk, "readiness": readiness, "components": comps,
            "coverage": wsum / sum(_WEIGHTS.values())}


def _safe_cell(v: Any) -> Any:
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v          # neutralise spreadsheet formula injection
    return v


def fills_csv(fills: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ts", "symbol", "side", "qty", "price", "fee", "liquidity", "realized_pnl", "order_id", "fill_id"])
    for f in fills:
        w.writerow([_safe_cell(f.get(k)) for k in ("ts", "symbol", "side", "qty", "price", "fee", "liquidity", "realized_pnl", "order_id", "id")])
    return buf.getvalue()


def _fmt(x: Optional[float], d: int = 2, pct: bool = False) -> str:
    if x is None:
        return "n/a"
    return f"{x * 100:.{d}f}%" if pct else f"{x:,.{d}f}"


def report_markdown(kind: str, perf: dict, summary: dict, generated_at: datetime, health: dict) -> str:
    L = [f"# ETI {kind.capitalize()} Trading Report", "",
         f"- Generated: {generated_at.isoformat()}",
         f"- Period: {perf['range']} (rolling)",
         "- Data source: INTERNAL PAPER account (simulated fills; not exchange or live results)", "",
         "## Key metrics", "",
         f"- Equity: {_fmt(summary.get('equity'))} (starting {_fmt(summary.get('starting_cash'))})",
         f"- Realized P&L (period): {_fmt(perf['net_realized_pnl'])}",
         f"- Unrealized P&L (open positions): {_fmt(summary.get('unrealized_pnl'))}",
         f"- Closed trades: {perf['trades']} (wins {perf['wins']}, losses {perf['losses']}); win rate {_fmt(perf['win_rate'], 1, True)}",
         f"- Profit factor: {_fmt(perf['profit_factor'])}" + (f" ({perf['profit_factor_note']})" if perf['profit_factor_note'] else ""),
         f"- Expectancy per closed trade: {_fmt(perf['expectancy'])}",
         f"- Max drawdown (realized curve): {_fmt(perf['max_drawdown_pct'])}%",
         f"- Fees paid: {_fmt(perf['fees_paid'])}; volume: {_fmt(perf['volume'])}",
         f"- Sharpe / Sortino: {_fmt(perf['sharpe'])} / {_fmt(perf['sortino'])}" + (f" - {perf['ratio_note']}" if perf['ratio_note'] else ""),
         "", "## Risk observations", "",
         f"- Trading health: {health.get('score', 'n/a')} ({health.get('label') or 'not evaluated'}); risk level {health.get('risk_level') or 'not evaluated'}; readiness {health.get('readiness')}",
         f"- Open positions: {len(summary.get('positions') or [])}; open orders: {summary.get('open_orders', 0)}",
         "", "## Method", "", perf["basis"], "",
         "_Research output, not investment advice. Past simulated performance does not predict future results._"]
    return "\n".join(L)

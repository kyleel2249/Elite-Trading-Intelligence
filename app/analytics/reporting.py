"""Transaction/tax-lot reporting, multi-currency valuation and live-vs-backtest comparison.

Support tooling only: not tax advice. Wash-sale, jurisdiction rules and cost-basis elections must be reviewed
by a qualified tax professional. FX rates are never guessed; missing rates are reported.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from typing import Any, Mapping, Sequence

from .stats import mean, stdev

METHODS = ("FIFO", "LIFO", "HIFO")
LONG_TERM_DAYS = 365


def _ts(v: Any) -> datetime:
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def realized_gains(transactions: Sequence[Mapping[str, Any]], method: str = "FIFO") -> dict[str, Any]:
    """Match sells to open lots per symbol. Transactions: {id, ts, symbol, side, qty, price, fee?}. Long-only lots."""
    method = method.upper()
    if method not in METHODS:
        raise ValueError(f"method must be one of {METHODS}")
    txs = sorted(transactions, key=lambda t: (_ts(t["ts"]), str(t.get("id", ""))))
    lots: dict[str, list[dict[str, Any]]] = defaultdict(list)
    rows, issues = [], []
    for t in txs:
        sym, side = str(t["symbol"]).upper(), str(t["side"]).lower()
        qty, px, fee = float(t["qty"]), float(t["price"]), float(t.get("fee", 0.0))
        if not (qty > 0 and px >= 0 and fee >= 0 and math.isfinite(qty + px + fee)) or side not in ("buy", "sell"):
            issues.append({"id": t.get("id"), "issue": "invalid transaction"})
            continue
        if side == "buy":
            lots[sym].append({"ts": _ts(t["ts"]), "qty": qty, "unit_cost": (qty * px + fee) / qty, "id": t.get("id")})
            continue
        remaining, proceeds_unit = qty, (qty * px - fee) / qty
        pool = lots[sym]
        while remaining > 1e-12 and pool:
            idx = {"FIFO": 0, "LIFO": len(pool) - 1}.get(method)
            if idx is None:
                idx = max(range(len(pool)), key=lambda i: pool[i]["unit_cost"])
            lot = pool[idx]
            take = min(remaining, lot["qty"])
            days = (_ts(t["ts"]) - lot["ts"]).days
            rows.append({"symbol": sym, "sell_id": t.get("id"), "buy_id": lot["id"], "qty": take,
                         "proceeds": round(take * proceeds_unit, 2), "cost_basis": round(take * lot["unit_cost"], 2),
                         "gain": round(take * (proceeds_unit - lot["unit_cost"]), 2), "holding_days": days,
                         "term": "long" if days > LONG_TERM_DAYS else "short", "sold_at": str(t["ts"])})
            lot["qty"] -= take
            remaining -= take
            if lot["qty"] <= 1e-12:
                pool.pop(idx)
        if remaining > 1e-12:
            issues.append({"id": t.get("id"), "issue": f"sell exceeds known lots by {remaining:g}; short sales/transfers-in not supported"})
    return {"status": "ok", "method": method, "rows": rows, "issues": issues,
            "totals": {"short_term_gain": round(sum(r["gain"] for r in rows if r["term"] == "short"), 2),
                       "long_term_gain": round(sum(r["gain"] for r in rows if r["term"] == "long"), 2),
                       "net_gain": round(sum(r["gain"] for r in rows), 2)},
            "open_lots": {s: [{"qty": l["qty"], "unit_cost": round(l["unit_cost"], 6), "acquired": l["ts"].isoformat()} for l in v]
                          for s, v in lots.items() if v},
            "notes": ["Not tax advice. Wash-sale rules, income/staking events, transfers and jurisdiction rules are not applied.",
                      "Holding period uses a 365-day threshold; confirm the rule for your jurisdiction."]}


def transactions_csv(rows: Sequence[Mapping[str, Any]]) -> str:
    cols = ["symbol", "sell_id", "buy_id", "qty", "proceeds", "cost_basis", "gain", "holding_days", "term", "sold_at"]
    esc = lambda v: '"' + str(v).replace('"', '""') + '"' if any(c in str(v) for c in ',"\n') else str(v)
    return "\n".join([",".join(cols)] + [",".join(esc(r.get(c, "")) for c in cols) for r in rows]) + "\n"


def convert_portfolio(holdings: Sequence[Mapping[str, Any]], base_currency: str, fx_rates: Mapping[str, float]) -> dict[str, Any]:
    """Value holdings {account, symbol, value, currency} in base_currency. ``fx_rates['EUR']`` = base units per 1 EUR."""
    base = base_currency.upper()
    rates = {k.upper(): float(v) for k, v in fx_rates.items()}
    rates[base] = 1.0
    total, by_account, by_ccy, missing = 0.0, defaultdict(float), defaultdict(float), set()
    lines = []
    for h in holdings:
        ccy = str(h["currency"]).upper()
        r = rates.get(ccy)
        if r is None or not r > 0:
            missing.add(ccy)
            continue
        v = float(h["value"]) * r
        total += v
        by_account[str(h.get("account", "default"))] += v
        by_ccy[ccy] += v
        lines.append({"account": h.get("account", "default"), "symbol": h.get("symbol"), "native_value": h["value"],
                      "currency": ccy, "value_base": round(v, 2)})
    return {"status": "ok" if not missing else "partial", "base_currency": base, "total_value": round(total, 2),
            "by_account": {k: round(v, 2) for k, v in by_account.items()},
            "currency_exposure": {k: round(v, 2) for k, v in by_ccy.items()}, "lines": lines,
            "missing_fx_rates": sorted(missing),
            "notes": ["Rates are caller-supplied; ETI does not invent FX rates.", "Holdings with missing rates are excluded from totals."]}


def live_vs_backtest(live_returns: Sequence[float], backtest_returns: Sequence[float], min_obs: int = 20) -> dict[str, Any]:
    if len(live_returns) < min_obs or len(backtest_returns) < min_obs:
        return {"status": "insufficient_data", "required_each": min_obs,
                "live": len(live_returns), "backtest": len(backtest_returns)}
    ml, mb = mean(live_returns), mean(backtest_returns)
    sl, sb = stdev(live_returns), stdev(backtest_returns)
    se = math.sqrt(sl ** 2 / len(live_returns) + sb ** 2 / len(backtest_returns))
    t = (ml - mb) / se if se > 0 else None
    return {"status": "ok", "live": {"n": len(live_returns), "mean": round(ml, 6), "stdev": round(sl, 6)},
            "backtest": {"n": len(backtest_returns), "mean": round(mb, 6), "stdev": round(sb, 6)},
            "mean_gap_per_trade": round(ml - mb, 6), "welch_t": None if t is None else round(t, 3),
            "degradation": bool(t is not None and t < -2.0),
            "verdict": "live significantly underperforms backtest (|t|>2)" if t is not None and t < -2.0
            else "no statistically clear gap at this sample size",
            "notes": ["Welch t-test on per-trade returns; assumes independent trades. Small samples are weak evidence."]}

"""Pure calculations for the Executive Command Centre (no I/O): positions, budgets, forecasts, payment roll-ups."""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from app.accounting.money import fmt

BANK, EXCHANGE, RESERVE, WALLET, POSITIONS, SUSPENSE = "1010", "1020", "1030", "1210", "1300", "1990"
AP, ACCRUED, TAXES = "2000", "2100", "2200"
WEEKS = 13
SCENARIOS = {
    "base": {"label": "Base", "ar_delay_days": 7, "overdue_ar_collect": Decimal("0.5"), "burn_multiplier": Decimal("1.0"), "include_pending": False},
    "downside": {"label": "Downside", "ar_delay_days": 30, "overdue_ar_collect": Decimal("0"), "burn_multiplier": Decimal("1.2"), "include_pending": True},
    "upside": {"label": "Upside", "ar_delay_days": 0, "overdue_ar_collect": Decimal("1"), "burn_multiplier": Decimal("0.9"), "include_pending": False},
}


def m(units) -> str:
    return fmt(int(units), 2)


def pct(a, b) -> Optional[float]:
    return round(a * 100.0 / b, 1) if b else None


def natural_balances(rows, currency: str) -> dict:
    out = {}
    for r in rows:
        if r["currency"] != currency:
            continue
        sign = 1 if r["type"] in ("asset", "expense") else -1
        out[r["account"]] = {"name": r["name"], "type": r["type"], "units": sign * (r["debit_units"] - r["credit_units"])}
    return out


def bal(b: dict, code: str) -> int:
    return b.get(code, {}).get("units", 0)


def total(b: dict, kind: str) -> int:
    return sum(v["units"] for v in b.values() if v["type"] == kind)


def _rows(b: dict, kind: str) -> list:
    return [{"account": c, "name": v["name"], "amount": m(v["units"])} for c, v in sorted(b.items()) if v["type"] == kind and v["units"]]


def position(b: dict) -> dict:
    assets, liab, eq_acc = total(b, "asset"), total(b, "liability"), total(b, "equity")
    earnings = total(b, "revenue") - total(b, "expense")
    diff = assets - liab - (eq_acc + earnings)
    return {"total_assets": m(assets), "total_liabilities": m(liab), "net_equity": m(assets - liab),
            "equity_per_books": m(eq_acc + earnings), "accumulated_earnings": m(earnings), "balanced": diff == 0,
            "difference": m(diff), "assets": _rows(b, "asset"), "liabilities": _rows(b, "liability"), "equity": _rows(b, "equity")}


def liquidity(b: dict, accts: dict, committed: int, reserve_target: int, monthly_burn: int) -> dict:
    op, ex, rs = bal(b, BANK), bal(b, EXCHANGE), bal(b, RESERVE)
    cash = [{"account": c, "name": a.name, "balance": m(bal(b, c))} for c, a in sorted(accts.items()) if a.cash and a.active]
    return {"operating_cash": m(op), "exchange_cash": m(ex), "reserve_held": m(rs), "committed_payments": m(committed),
            "available_operating": m(op - committed), "open_positions_at_cost": m(bal(b, POSITIONS)),
            "trading_capital": m(ex + bal(b, POSITIONS)), "treasury_wallet_book": m(bal(b, WALLET)),
            "reserve_target": m(reserve_target), "reserve_shortfall": m(max(0, reserve_target - rs)),
            "reserve_coverage_pct": pct(rs, reserve_target), "monthly_operating_burn": m(monthly_burn),
            "runway_months": round((op + rs) / monthly_burn, 1) if monthly_burn > 0 else None, "cash_accounts": cash,
            "formula": "available = operating bank cash - approved-but-unpaid payments; reserve and exchange cash are held separately"}


def range_start(key: str, as_of: date, first: Optional[date]) -> date:
    if key == "mtd":
        return as_of.replace(day=1)
    if key == "qtd":
        return date(as_of.year, (as_of.month - 1) // 3 * 3 + 1, 1)
    if key == "ytd":
        return date(as_of.year, 1, 1)
    if key == "12m":
        return as_of - timedelta(days=364)
    if key == "all":
        return first or date(as_of.year, 1, 1)
    raise ValueError("range must be one of mtd, qtd, ytd, 12m, all")


def budget_rows(budgets: list, actual: dict, today: date) -> dict:
    year = today.year
    annual, monthly = {}, {}
    for x in budgets:
        p, d = x["period"], x["department"]
        if p == str(year):
            annual[d] = x["amount_units"]
        elif len(p) == 7 and p[:4] == str(year):
            monthly[d] = monthly.get(d, 0) + x["amount_units"]
    plan = {**monthly, **annual}
    days = 366 if calendar.isleap(year) else 365
    pace = min(1.0, max(0.0, ((today - date(year, 1, 1)).days + 1) / days))
    rows, tb, ta = [], 0, 0
    for d in sorted(set(plan) | set(actual)):
        bud, act = plan.get(d, 0), actual.get(d, 0)
        tb, ta = tb + bud, ta + act
        util, expected = pct(act, bud), int(bud * pace)
        pacing = pct(act, expected)
        if bud == 0 and act > 0:
            st = "unbudgeted"
        elif act > bud:
            st = "over"
        elif (util or 0) >= 80 or (pacing or 0) > 110:
            st = "watch"
        else:
            st = "ok"
        rows.append({"department": d, "budget": m(bud), "actual_ytd": m(act), "remaining": m(bud - act), "utilisation_pct": util,
                     "expected_to_date": m(expected), "pacing_pct": pacing,
                     "projected_year_end": m(int(act / pace)) if pace >= 0.08 else None, "status": st})
    return {"year": year, "rows": rows, "total_budget": m(tb), "total_actual": m(ta), "utilisation_pct": pct(ta, tb),
            "year_elapsed_pct": round(pace * 100, 1),
            "basis": "annual budget (or the sum of that year's monthly budgets) vs year-to-date ledger expenses"}


def _scale(units: int, factor: Decimal) -> int:
    return int((Decimal(units) * factor).to_integral_value())


def forecast(as_of: date, opening: int, receivables: list, payables: list, requests: list, monthly_burn: int, weeks: int = WEEKS) -> dict:
    out = {}
    wk = lambda d: (d - as_of).days // 7
    for key, sc in SCENARIOS.items():
        inflow, outflow = [0] * weeks, [0] * weeks
        beyond_in = beyond_out = uncollected = 0
        for r in receivables:
            due, amt = date.fromisoformat(r["due_date"]), r["outstanding_units"]
            if due < as_of:
                got = _scale(amt, sc["overdue_ar_collect"])
                uncollected += amt - got
                i = min(3, weeks - 1)
            else:
                got, i = amt, wk(due + timedelta(days=sc["ar_delay_days"]))
            if i >= weeks:
                beyond_in += got
            else:
                inflow[i] += got
        pay = [(date.fromisoformat(r["due_date"]), r["outstanding_units"]) for r in payables]
        pay += [(date.fromisoformat(r["due_date"]), r["amount_units"]) for r in requests
                if not r.get("document_id") and (r["status"] == "approved" or (r["status"] == "pending" and sc["include_pending"]))]
        for due, amt in pay:
            i = max(0, wk(due))
            if i >= weeks:
                beyond_out += amt
            else:
                outflow[i] += amt
        weekly = _scale(monthly_burn, sc["burn_multiplier"] * 12 / 52)
        cur, rows, low, low_w, neg = opening, [], None, None, None
        for i in range(weeks):
            net = inflow[i] - outflow[i] - weekly
            cur += net
            if low is None or cur < low:
                low, low_w = cur, i + 1
            if cur < 0 and neg is None:
                neg = i + 1
            s = as_of + timedelta(days=7 * i)
            rows.append({"week": i + 1, "start": s.isoformat(), "end": (s + timedelta(days=6)).isoformat(), "inflow": m(inflow[i]),
                         "outflow": m(outflow[i] + weekly), "net": m(net), "closing": m(cur)})
        out[key] = {"label": sc["label"], "assumptions": {"receivables_delay_days": sc["ar_delay_days"],
                    "overdue_receivables_collected": str(sc["overdue_ar_collect"]), "burn_multiplier": str(sc["burn_multiplier"]),
                    "includes_unapproved_requests": sc["include_pending"]},
                    "weeks": rows, "opening": m(opening), "ending": m(cur), "min_closing": m(low), "min_week": low_w,
                    "first_negative_week": neg, "uncollected_overdue_receivables": m(uncollected),
                    "beyond_horizon": {"inflow": m(beyond_in), "outflow": m(beyond_out)}}
    return {"as_of": as_of.isoformat(), "weeks": weeks, "scenarios": out,
            "notes": ["Opening balance is operating bank cash only (exchange and reserve cash excluded).",
                      "Trading profits are never forecast. Recurring burn is applied on top of scheduled bills, which can overstate outflows slightly (conservative).",
                      "Bill-linked payment requests are not counted twice: the bill itself is scheduled."]}


def payment_rollup(reqs: list, cur: str, today: date) -> dict:
    rows = [r for r in reqs if r["currency"] == cur]
    agg = lambda sel: {"count": len(sel), "total": m(sum(r["amount_units"] for r in sel))}
    openr = [r for r in rows if r["status"] in ("pending", "approved")]
    month = today.isoformat()[:7]
    return {"pending": agg([r for r in rows if r["status"] == "pending"]), "approved": agg([r for r in rows if r["status"] == "approved"]),
            "paid_mtd": agg([r for r in rows if r["status"] == "paid" and (r.get("paid_at") or "")[:7] == month]),
            "pending_withdrawals": agg([r for r in openr if r["kind"] == "withdrawal"]),
            "overdue": agg([r for r in openr if r["due_date"] < today.isoformat()]),
            "queue": openr[:100], "recent": [r for r in rows if r["status"] in ("paid", "rejected", "cancelled")][:30]}

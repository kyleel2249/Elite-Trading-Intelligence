"""Financial statements and management reports. Everything is derived from the journal; nothing is stored twice."""
from __future__ import annotations

import calendar
from collections import defaultdict
from typing import Iterator, Optional

from app.accounting import coa
from app.accounting.domain import SCOPES, Entry, Line, ValidationError, parse_date
from app.accounting.money import fmt

DEFAULT_CURRENCY = "USD"
SIM_NOTE = "SIMULATED: paper/testnet results are not real money and are not evidence of profitability."


def _scope_envs(scope: str, environment_only: Optional[str]) -> tuple:
    if environment_only:
        return (environment_only,)
    if scope not in SCOPES:
        raise ValidationError(f"scope must be one of {tuple(SCOPES)}")
    return SCOPES[scope]


def _iter(ledger, date_from=None, date_to=None, scope="real", environment_only=None) -> Iterator[tuple[Entry, Line]]:
    envs = _scope_envs(scope, environment_only)
    for e in ledger.store.entries(date_from, date_to):
        if e.environment in envs:
            for l in e.lines:
                yield e, l


def _currencies(ledger, scope, environment_only=None) -> list[str]:
    return sorted({l.currency for _, l in _iter(ledger, scope=scope, environment_only=environment_only)})


def _natural(acct, d: int, c: int) -> int:
    return d - c if acct.debit_normal else c - d


def _money(u: int) -> str:
    return fmt(u, 2)


# --------------------------------------------------------------------------------------------- trial balance
def trial_balance(ledger, as_of: str, date_from: Optional[str] = None, scope: str = "real",
                  currency: Optional[str] = None, environment_only: Optional[str] = None) -> dict:
    parse_date(as_of)
    accts = ledger.accounts()
    agg: dict[tuple, list] = defaultdict(lambda: [0, 0])
    for _, l in _iter(ledger, date_from, as_of, scope, environment_only):
        if currency and l.currency != currency:
            continue
        a = agg[(l.account, l.currency)]
        a[0] += l.debit
        a[1] += l.credit
    rows, totals = [], defaultdict(lambda: [0, 0])
    for (code, cur), (d, c) in sorted(agg.items()):
        a = accts[code]
        rows.append({"account": code, "name": a.name, "type": a.type, "currency": cur, "debit_units": d, "credit_units": c,
                     "debit": fmt(d), "credit": fmt(c), "balance": fmt(_natural(a, d, c))})
        totals[cur][0] += d
        totals[cur][1] += c
    return {"as_of": as_of, "from": date_from, "scope": scope, "rows": rows,
            "totals": {cur: {"debit": fmt(d), "credit": fmt(c), "balanced": d == c} for cur, (d, c) in totals.items()},
            "balanced": all(d == c for d, c in totals.values())}


# --------------------------------------------------------------------------------------------- income statement
def income_statement(ledger, date_from: str, date_to: str, scope: str = "real", currency: str = DEFAULT_CURRENCY) -> dict:
    parse_date(date_from), parse_date(date_to)
    accts = ledger.accounts()
    bal: dict[str, int] = defaultdict(int)
    for e, l in _iter(ledger, date_from, date_to, scope):
        if e.source == "year_close":      # closing entries are bookkeeping, not performance
            continue
        if l.currency == currency and accts[l.account].type in ("revenue", "expense"):
            bal[l.account] += (l.credit - l.debit) if accts[l.account].type == "revenue" else (l.debit - l.credit)

    def section(kind):
        groups: dict[str, list] = defaultdict(list)
        for code, v in sorted(bal.items()):
            if accts[code].type == kind and v != 0:
                groups[accts[code].group or kind].append({"account": code, "name": accts[code].name, "amount": fmt(v), "units": v})
        return [{"group": g, "accounts": rows, "subtotal": fmt(sum(r["units"] for r in rows))} for g, rows in groups.items()]

    rev = sum(v for k, v in bal.items() if accts[k].type == "revenue")
    exp = sum(v for k, v in bal.items() if accts[k].type == "expense")
    return {"statement": "income_statement", "from": date_from, "to": date_to, "scope": scope, "currency": currency,
            "currencies_present": _currencies(ledger, scope), "revenue": section("revenue"), "expenses": section("expense"),
            "total_revenue": fmt(rev), "total_expenses": fmt(exp), "net_income": fmt(rev - exp),
            "net_income_units": rev - exp, "simulated_included": scope != "real",
            "note": SIM_NOTE if scope != "real" else None}


# --------------------------------------------------------------------------------------------- balance sheet
def balance_sheet(ledger, as_of: str, scope: str = "real", currency: str = DEFAULT_CURRENCY) -> dict:
    parse_date(as_of)
    accts = ledger.accounts()
    d_: dict[str, list] = defaultdict(lambda: [0, 0])
    for _, l in _iter(ledger, None, as_of, scope):
        if l.currency == currency:
            d_[l.account][0] += l.debit
            d_[l.account][1] += l.credit
    sec: dict[str, list] = {"asset": [], "liability": [], "equity": []}
    earnings = 0
    for code, (d, c) in sorted(d_.items()):
        a = accts[code]
        if a.type in ("revenue", "expense"):
            earnings += c - d
            continue
        v = _natural(a, d, c)
        if v != 0:
            sec[a.type].append({"account": code, "name": a.name, "amount": fmt(v), "units": v})
    total = {k: sum(r["units"] for r in v) for k, v in sec.items()}
    equity_total = total["equity"] + earnings
    return {"statement": "balance_sheet", "as_of": as_of, "scope": scope, "currency": currency,
            "currencies_present": _currencies(ledger, scope),
            "assets": sec["asset"], "liabilities": sec["liability"], "equity": sec["equity"],
            "current_period_earnings": fmt(earnings), "total_assets": fmt(total["asset"]),
            "total_liabilities": fmt(total["liability"]), "total_equity": fmt(equity_total),
            "balanced": total["asset"] == total["liability"] + equity_total,
            "difference": fmt(total["asset"] - total["liability"] - equity_total)}


# --------------------------------------------------------------------------------------------- cash flow
def cash_flow(ledger, date_from: str, date_to: str, scope: str = "real", currency: str = DEFAULT_CURRENCY) -> dict:
    """Direct method. For each entry, the cash change is attributed to the non-cash lines in the same entry by the
    cash-flow category of each counter account (the entry balances, so attribution is exact)."""
    parse_date(date_from), parse_date(date_to)
    accts = ledger.accounts()
    envs = SCOPES[scope]
    opening = closing = 0
    cats: dict[str, dict] = {k: defaultdict(int) for k in ("operating", "investing", "financing")}
    for e in ledger.store.entries(None, date_to):
        if e.environment not in envs:
            continue
        ls = [l for l in e.lines if l.currency == currency]
        cash = sum(l.debit - l.credit for l in ls if accts[l.account].cash)
        if cash == 0 and not any(accts[l.account].cash for l in ls):
            continue
        closing += cash
        if e.date < date_from:
            opening += cash
            continue
        for l in ls:
            a = accts[l.account]
            if not a.cash:
                cats[a.cashflow][f"{l.account} {a.name}"] += -(l.debit - l.credit)
    out = {k: {"lines": [{"account": n, "amount": fmt(v)} for n, v in sorted(m.items()) if v], "net": fmt(sum(m.values()))}
           for k, m in cats.items()}
    net = sum(sum(m.values()) for m in cats.values())
    return {"statement": "cash_flow", "method": "direct", "from": date_from, "to": date_to, "scope": scope,
            "currency": currency, "operating": out["operating"], "investing": out["investing"], "financing": out["financing"],
            "net_change_in_cash": fmt(net), "opening_cash": fmt(opening), "closing_cash": fmt(closing),
            "reconciles": opening + net == closing}


# --------------------------------------------------------------------------------------------- departmental expenses
def department_expenses(ledger, date_from: str, date_to: str, scope: str = "real", currency: str = DEFAULT_CURRENCY) -> dict:
    parse_date(date_from), parse_date(date_to)
    accts = ledger.accounts()
    cell: dict[tuple, int] = defaultdict(int)
    monthly: dict[tuple, int] = defaultdict(int)
    for e, l in _iter(ledger, date_from, date_to, scope):
        a = accts[l.account]
        if l.currency != currency or a.type != "expense" or e.source == "year_close":
            continue
        dep = l.department or "Unassigned"
        v = l.debit - l.credit
        cell[(dep, l.account)] += v
        monthly[(dep, e.period)] += v
    deps: dict[str, dict] = {}
    for (dep, code), v in sorted(cell.items()):
        d = deps.setdefault(dep, {"department": dep, "accounts": [], "total_units": 0})
        d["accounts"].append({"account": code, "name": accts[code].name, "amount": fmt(v), "units": v})
        d["total_units"] += v
    total = sum(d["total_units"] for d in deps.values())
    for d in deps.values():
        d["total"] = fmt(d["total_units"])
        d["share_pct"] = f"{(d['total_units'] * 100 / total):.2f}" if total else "0.00"
        d["by_month"] = {p: fmt(v) for (dd, p), v in sorted(monthly.items()) if dd == d["department"]}
    return {"report": "departmental_expenses", "from": date_from, "to": date_to, "scope": scope, "currency": currency,
            "departments": sorted(deps.values(), key=lambda x: -x["total_units"]), "total": fmt(total),
            "unassigned_total": fmt(deps.get("Unassigned", {}).get("total_units", 0))}


# --------------------------------------------------------------------------------------------- trading P&L
def _stats(pnls: list[int], gross_p: int, gross_l: int, fees: int, funding: int) -> dict:
    n = len(pnls)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    net = gross_p - gross_l - fees + funding
    return {"trades": n, "wins": len(wins), "losses": len(losses),
            "win_rate": f"{len(wins) * 100 / n:.2f}" if n else None,
            "gross_profit": fmt(gross_p), "gross_loss": fmt(gross_l), "fees": fmt(fees), "funding": fmt(funding),
            "net_pnl": fmt(net), "net_units": net,
            "profit_factor": f"{gross_p / gross_l:.3f}" if gross_l else None,
            "avg_win": fmt(sum(wins) // len(wins)) if wins else None,
            "avg_loss": fmt(sum(losses) // len(losses)) if losses else None,
            "expectancy_per_trade_after_fees": fmt(net // n) if n else None}


def trading_pnl(ledger, date_from: str, date_to: str, currency: str = DEFAULT_CURRENCY, scope: str = "all") -> dict:
    parse_date(date_from), parse_date(date_to)
    tg = {coa.TRADING_GAINS, coa.TRADING_LOSSES, coa.EXCHANGE_FEES, coa.FUNDING_INCOME}
    envs = SCOPES[scope]
    result = {}
    for env in envs:
        per_trade: dict[str, int] = defaultdict(int)
        by_sym: dict[str, dict] = defaultdict(lambda: {"p": 0, "l": 0, "f": 0, "fu": 0, "trades": []})
        by_strat: dict[str, dict] = defaultdict(lambda: {"p": 0, "l": 0, "f": 0, "fu": 0, "trades": []})
        tot = {"p": 0, "l": 0, "f": 0, "fu": 0}
        seen = False
        for e, l in _iter(ledger, date_from, date_to, "all", env):
            if l.currency != currency or l.account not in tg:
                continue
            seen = True
            sym, st = l.symbol or "UNATTRIBUTED", l.strategy or "UNATTRIBUTED"
            k = {coa.TRADING_GAINS: ("p", l.credit - l.debit), coa.TRADING_LOSSES: ("l", l.debit - l.credit),
                 coa.EXCHANGE_FEES: ("f", l.debit - l.credit), coa.FUNDING_INCOME: ("fu", l.credit - l.debit)}[l.account]
            for tgt in (tot, by_sym[sym], by_strat[st]):
                tgt[k[0]] += k[1]
            if e.source == "trade" and k[0] in ("p", "l"):
                per_trade[e.source_id] += k[1] if k[0] == "p" else -k[1]
                for tgt in (by_sym[sym], by_strat[st]):
                    tgt["trades"].append(per_trade[e.source_id])
        if not seen:
            continue
        pn = list(per_trade.values())
        result[env] = {"simulated": env in ("paper", "testnet"), "note": SIM_NOTE if env in ("paper", "testnet") else None,
                       "summary": _stats(pn, tot["p"], tot["l"], tot["f"], tot["fu"]),
                       "by_symbol": {k: _stats(v["trades"], v["p"], v["l"], v["f"], v["fu"]) for k, v in sorted(by_sym.items())},
                       "by_strategy": {k: _stats(v["trades"], v["p"], v["l"], v["f"], v["fu"]) for k, v in sorted(by_strat.items())}}
    return {"report": "trading_pnl", "from": date_from, "to": date_to, "currency": currency, "environments": result,
            "confidence_note": "Realized P&L booked from closed trades only. Open positions are not marked to market here."}


# --------------------------------------------------------------------------------------------- general ledger
def general_ledger(ledger, account: str, date_from: Optional[str] = None, date_to: Optional[str] = None,
                   scope: str = "all", currency: Optional[str] = None) -> dict:
    a = ledger.accounts().get(account)
    if a is None:
        raise ValidationError(f"unknown account {account}")
    opening = 0
    rows, run = [], 0
    for e, l in _iter(ledger, None, date_to, scope):
        if l.account != account or (currency and l.currency != currency):
            continue
        v = _natural(a, l.debit, l.credit)
        if date_from and e.date < date_from:
            opening += v
            run = opening
            continue
        run += v
        rows.append({"entry": e.entry_no, "date": e.date, "source": e.source, "source_id": e.source_id, "memo": e.memo or l.memo,
                     "environment": e.environment, "currency": l.currency, "debit": fmt(l.debit), "credit": fmt(l.credit),
                     "running_balance": fmt(run), "external_ref": l.external_ref, "department": l.department, "symbol": l.symbol})
    return {"account": account, "name": a.name, "type": a.type, "opening_balance": fmt(opening), "rows": rows,
            "closing_balance": fmt(run)}


# --------------------------------------------------------------------------------------------- monthly / annual
def _month_bounds(period: str) -> tuple[str, str]:
    y, m = int(period[:4]), int(period[5:7])
    return f"{y}-{m:02d}-01", f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"


def period_report(ledger, period: str, scope: str = "real", currency: str = DEFAULT_CURRENCY) -> dict:
    """`period` is YYYY-MM (monthly) or YYYY (annual)."""
    from app.accounting.subledger import aging
    if len(period) == 7:
        parse_date(period + "-01")
        start, end, kind = *_month_bounds(period), "monthly"
    elif len(period) == 4 and period.isdigit():
        start, end, kind = f"{period}-01-01", f"{period}-12-31", "annual"
    else:
        raise ValidationError("period must be YYYY-MM or YYYY")
    closed = ledger.store.closed_periods()
    months = [period] if kind == "monthly" else [f"{period}-{m:02d}" for m in range(1, 13)]
    return {"report": f"{kind}_financial_report", "period": period, "from": start, "to": end, "scope": scope,
            "currency": currency, "period_closed": all(m in closed for m in months),
            "income_statement": income_statement(ledger, start, end, scope, currency),
            "balance_sheet": balance_sheet(ledger, end, scope, currency),
            "cash_flow": cash_flow(ledger, start, end, scope, currency),
            "departmental_expenses": department_expenses(ledger, start, end, scope, currency),
            "trading_pnl": trading_pnl(ledger, start, end, currency),
            "ap_aging": aging(ledger, "bill", end, scope, currency), "ar_aging": aging(ledger, "invoice", end, scope, currency),
            "trial_balance": trial_balance(ledger, end, scope=scope, currency=currency),
            "integrity": ledger.verify_chain()}

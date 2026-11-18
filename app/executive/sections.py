"""Read side of the Executive Command Centre: assembles role views from the ledger, registers and (optionally) live feeds.

Everything money-related is derived from the double-entry ledger; nothing is stored twice. Inputs that do not exist (for
example a live mark-to-market feed) are reported as unavailable with a reason, never invented."""
from __future__ import annotations

import threading
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional

from app.accounting import reports, subledger
from app.executive import calc
from app.executive.calc import bal, m, pct

RANGES = ("mtd", "qtd", "ytd", "12m", "all")
ROLE_SECTIONS = {
    "executive": ("alerts", "position", "liquidity", "trading", "unrealized", "expenditure", "budgets", "obligations", "payments", "forecast", "reserve"),
    "finance": ("alerts", "position", "liquidity", "expenditure", "budgets", "obligations", "payments", "forecast", "reserve"),
    "trading": ("alerts", "trading_capital", "trading", "unrealized"),
    "operations": ("alerts", "payments", "liquidity", "reserve", "obligations", "system"),
    "auditor": ("alerts", "controls", "position", "payments", "budgets", "reconciliation", "audit_log"),
}
KPI_SETS = {
    "executive": ("total_assets", "total_liabilities", "net_equity", "trading_capital", "realized_trading_profit", "unrealized_pnl",
                  "available_operating_funds", "emergency_reserves", "departmental_budgets", "total_expenditure", "blockchain_balances",
                  "pending_withdrawals", "approved_payments", "outstanding_obligations", "cash_flow_forecast"),
    "finance": ("total_assets", "total_liabilities", "net_equity", "available_operating_funds", "emergency_reserves", "departmental_budgets",
                "total_expenditure", "outstanding_obligations", "approved_payments", "pending_withdrawals", "cash_flow_forecast", "blockchain_balances"),
    "trading": ("trading_capital", "realized_trading_profit", "unrealized_pnl", "trades", "win_rate", "trading_costs"),
    "operations": ("pending_withdrawals", "approved_payments", "pending_approvals", "overdue_payments", "available_operating_funds",
                   "emergency_reserves", "outstanding_obligations", "blockchain_balances"),
    "auditor": ("controls_passed", "controls_warn", "controls_failed", "ledger_entries", "unbooked_payments", "total_assets", "net_equity"),
}


def _u8(s: str) -> int:
    return int(Decimal(s) * 10 ** 8)


# ---- ledger bundle (cached by journal head) ---------------------------------------------------------------------------------
_CACHE: dict = {}
_LOCK = threading.Lock()


def _opex(inc: dict) -> int:
    return sum(a["units"] for g in inc["expenses"] if g["group"] != "Trading" for a in g["accounts"])


def build_bundle(ledger, as_of: date, scope: str, currency: str, range_key: str) -> dict:
    iso = as_of.isoformat()
    entries = ledger.store.entries(None, iso)
    first = min((date.fromisoformat(e.date) for e in entries), default=None)
    start = calc.range_start(range_key, as_of, first)
    s, jan1 = start.isoformat(), date(as_of.year, 1, 1).isoformat()
    tb_real = reports.trial_balance(ledger, iso, None, "real", None)
    tb_sel = tb_real if scope == "real" else reports.trial_balance(ledger, iso, None, scope, None)
    burn_start = max(as_of - timedelta(days=89), first) if first else as_of - timedelta(days=89)
    months = min(3.0, max(1.0, ((as_of - burn_start).days + 1) / 30.4375))
    burn = int(Decimal(_opex(reports.income_statement(ledger, burn_start.isoformat(), iso, "real", currency))) / Decimal(str(months)))
    dept_ytd = reports.department_expenses(ledger, jan1, iso, "real", currency)
    return {
        "as_of": iso, "start": s, "accts": ledger.accounts(), "currencies": sorted({r["currency"] for r in tb_real["rows"] + tb_sel["rows"]}),
        "tb_real": tb_real, "bal_real": calc.natural_balances(tb_real["rows"], currency), "bal_sel": calc.natural_balances(tb_sel["rows"], currency),
        "burn": burn, "inc": reports.income_statement(ledger, s, iso, scope, currency),
        "dept": reports.department_expenses(ledger, s, iso, scope, currency),
        "dept_ytd": {d["department"]: d["total_units"] for d in dept_ytd["departments"]},
        "tr": reports.trading_pnl(ledger, s, iso, currency, scope), "tr_all": reports.trading_pnl(ledger, "2000-01-01", iso, currency, scope),
        "ap": subledger.aging(ledger, "bill", iso, "real", currency), "ar": subledger.aging(ledger, "invoice", iso, "real", currency),
        "cf": reports.cash_flow(ledger, s, iso, "real", currency), "integrity": ledger.verify_chain(), "runs": ledger.store.runs(None, 20),
        "closed": sorted(ledger.store.closed_periods()), "periods": sorted({e.period for e in entries}), "entries": len(entries),
    }


def get_bundle(ledger, as_of: date, scope: str, currency: str, range_key: str) -> dict:
    key = (ledger.store.last_hash(), as_of.isoformat(), scope, currency, range_key)
    now = time.monotonic()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < 20:
            return hit[1]
    b = build_bundle(ledger, as_of, scope, currency, range_key)
    with _LOCK:
        if len(_CACHE) > 32:
            _CACHE.clear()
        _CACHE[key] = (now, b)
    return b


# ---- sections -------------------------------------------------------------------------------------------------------------
def _alert(sev: str, code: str, title: str, detail: str, roles: Optional[tuple] = None) -> dict:
    return {"severity": sev, "code": code, "title": title, "detail": detail, "roles": list(roles) if roles else None}


def sec_expenditure(b: dict, range_key: str) -> dict:
    inc = b["inc"]
    total = sum(a["units"] for g in inc["expenses"] for a in g["accounts"])
    trading = sum(a["units"] for g in inc["expenses"] if g["group"] == "Trading" for a in g["accounts"])
    monthly: dict = {}
    for d in b["dept"]["departments"]:
        for p, v in d["by_month"].items():
            monthly[p] = monthly.get(p, 0) + _u8(v)
    return {"range": range_key, "from": b["start"], "to": b["as_of"], "total": m(total), "operating": m(total - trading), "trading_costs": m(trading),
            "by_department": [{"department": d["department"], "total": m(d["total_units"]), "share_pct": float(d["share_pct"])} for d in b["dept"]["departments"]],
            "by_group": [{"group": g["group"], "total": m(sum(a["units"] for a in g["accounts"]))} for g in inc["expenses"]],
            "monthly": [{"month": p, "amount": m(v)} for p, v in sorted(monthly.items())],
            "unassigned": m(_u8(b["dept"]["unassigned_total"]))}


def sec_trading(b: dict, scope: str) -> dict:
    envs, allp = b["tr"]["environments"], b["tr_all"]["environments"]
    keys = ("trades", "wins", "losses", "win_rate", "gross_profit", "gross_loss", "fees", "funding", "net_pnl", "profit_factor", "expectancy_per_trade_after_fees")
    rows, sym, strat = [], [], []
    for env, e in envs.items():
        rows.append({"environment": env, "simulated": e["simulated"], **{k: e["summary"].get(k) for k in keys}})
        sym += [{"environment": env, "symbol": k, "trades": v["trades"], "net_pnl": v["net_pnl"], "win_rate": v["win_rate"], "_n": v["net_units"]} for k, v in e["by_symbol"].items()]
        strat += [{"environment": env, "strategy": k, "trades": v["trades"], "net_pnl": v["net_pnl"], "win_rate": v["win_rate"], "_n": v["net_units"]} for k, v in e["by_strategy"].items()]
    top = lambda xs: [{k: v for k, v in x.items() if k != "_n"} for x in sorted(xs, key=lambda x: -x["_n"])[:15]]
    trades = sum(e["summary"]["trades"] for e in envs.values())
    wins = sum(e["summary"]["wins"] for e in envs.values())
    fees = sum(_u8(e["summary"]["fees"]) for e in envs.values())
    return {"scope": scope, "label": {"real": "REAL", "simulated": "SIMULATED", "all": "REAL + SIMULATED"}[scope],
            "realized_net": m(sum(e["summary"]["net_units"] for e in envs.values())), "realized_all_time": m(sum(e["summary"]["net_units"] for e in allp.values())),
            "trades": trades, "win_rate": round(wins * 100 / trades, 1) if trades else None, "fees": m(fees), "environments": rows,
            "by_symbol": top(sym), "by_strategy": top(strat), "from": b["start"], "to": b["as_of"],
            "note": "Realized P&L is booked from closed trades. Simulated environments are not real money." if scope != "real" else "Realized P&L is booked from closed trades only."}


def sec_obligations(b: dict, reqs: list, cur: str) -> dict:
    docs = b["ap"]["documents"]
    ap_u = sum(d["outstanding_units"] for d in docs)
    overdue = sum(d["outstanding_units"] for d in docs if d["days_overdue"] > 0)
    accrued, taxes = bal(b["bal_real"], calc.ACCRUED), bal(b["bal_real"], calc.TAXES)
    unlinked = sum(r["amount_units"] for r in reqs if r["currency"] == cur and r["status"] == "approved" and not r["document_id"])
    pipeline = sum(r["amount_units"] for r in reqs if r["currency"] == cur and r["status"] == "pending")
    ar_u = sum(d["outstanding_units"] for d in b["ar"]["documents"])
    return {"total": m(ap_u + accrued + taxes + unlinked), "accounts_payable": m(ap_u), "overdue_payables": m(overdue), "accrued_expenses": m(accrued),
            "taxes_payable": m(taxes), "approved_not_booked": m(unlinked), "pending_approval_pipeline": m(pipeline), "receivables_outstanding": m(ar_u),
            "ap_buckets": {k: m(_u8(v)) for k, v in b["ap"]["buckets"].items()}, "ap_ties_to_ledger": b["ap"]["ties_to_general_ledger"],
            "bills": [{"party": d["party"], "number": d["number"], "due_date": d["due_date"], "outstanding": m(d["outstanding_units"]),
                       "days_overdue": d["days_overdue"], "bucket": d["bucket"]} for d in docs[:25]],
            "basis": "bills payable + accrued expenses + taxes payable + approved payments not yet booked to a bill. Unapproved requests are shown as pipeline only."}


def sec_reserve(b: dict, pol: dict) -> dict:
    held = bal(b["bal_real"], calc.RESERVE)
    by_months = pol["months_of_burn"] * b["burn"]
    target = max(pol["target_units"], by_months)
    return {"held": m(held), "target": m(target), "fixed_target": m(pol["target_units"]), "months_of_burn": pol["months_of_burn"],
            "burn_based_target": m(by_months), "shortfall": m(max(0, target - held)), "coverage_pct": pct(held, target),
            "status": "unset" if target == 0 else ("funded" if held >= target else "underfunded"), "account": calc.RESERVE,
            "policy_updated_by": pol["updated_by"], "policy_updated_at": pol["updated_at"],
            "target_rule": "the larger of the fixed target and months-of-burn x trailing monthly operating expenses"}


def sec_controls(b: dict, reqs: list, bud: dict, pos: dict, as_of: date) -> dict:
    out = []

    def add(i, name, ok, detail, warn=False):
        out.append({"id": i, "name": name, "status": "pass" if ok else ("warn" if warn else "fail"), "detail": detail})

    ig = b["integrity"]
    add("ledger_chain", "Ledger hash chain intact", ig["ok"], f"{ig['entries']} entries verified" + ("" if ig["ok"] else f"; first bad entry {ig.get('first_bad_entry')}"))
    add("trial_balance", "Trial balance balances", b["tb_real"]["balanced"], "debits equal credits in every currency" if b["tb_real"]["balanced"] else "debits and credits differ")
    add("balance_sheet", "Assets = liabilities + equity", pos["balanced"], "difference " + pos["difference"])
    add("ap_tie_out", "Payables subledger ties to ledger", b["ap"]["ties_to_general_ledger"], "GL " + b["ap"]["gl_balance"])
    add("ar_tie_out", "Receivables subledger ties to ledger", b["ar"]["ties_to_general_ledger"], "GL " + b["ar"]["gl_balance"])
    add("cash_flow", "Cash-flow statement reconciles", b["cf"]["reconciles"], f"opening {b['cf']['opening_cash']} + net {b['cf']['net_change_in_cash']} = closing {b['cf']['closing_cash']}" if b["cf"]["reconciles"] else "does not reconcile")
    sus = bal(b["bal_real"], calc.SUSPENSE)
    add("suspense", "Suspense account cleared", sus == 0, "balance " + m(sus), warn=True)
    add("reconciliation", "A reconciliation run is on record", bool(b["runs"]), f"{len(b['runs'])} recent runs", warn=True)
    prev = (as_of.replace(day=1) - timedelta(days=1)).isoformat()[:7]
    stale = [p for p in b["periods"] if p < prev and p not in b["closed"]]
    add("periods", "Periods before last month are closed", not stale, ("open: " + ", ".join(stale[:6])) if stale else "all closed", warn=True)
    same = [r["reference"] for r in reqs if r["decided_by"] and r["decided_by"] == r["requested_by"] and r["status"] in ("approved", "paid")]
    add("four_eyes", "No request approved by its requester", not same, ", ".join(same[:5]) or "none")
    noref = [r["reference"] for r in reqs if r["status"] == "paid" and not r["payment_ref"]]
    add("payment_refs", "Every paid request has a payment reference", not noref, ", ".join(noref[:5]) or "none")
    unb = [r["reference"] for r in reqs if r["status"] == "paid" and not r["ledger_booked"]]
    add("unbooked", "Paid requests are booked to the ledger", not unb, ("needs a journal entry: " + ", ".join(unb[:5])) if unb else "none", warn=True)
    old = [r["reference"] for r in reqs if r["status"] == "pending" and r["age_days"] > 3]
    add("approval_aging", "No approvals waiting more than 3 days", not old, ", ".join(old[:5]) or "none", warn=True)
    nb = [r["department"] for r in bud["rows"] if r["status"] == "unbudgeted"]
    add("budget_coverage", "Every spending department has a budget", not nb, ", ".join(nb) or "all covered", warn=True)
    return {"controls": out, "passed": sum(c["status"] == "pass" for c in out), "warnings": sum(c["status"] == "warn" for c in out),
            "failed": sum(c["status"] == "fail" for c in out), "unbooked": len(unb)}


def sec_system(settings) -> dict:
    out: dict = {"kill_switch": bool(getattr(settings, "kill_switch", False)), "live_trading_enabled": bool(getattr(settings, "live_trading_enabled", False)),
                 "execution_enabled": bool(getattr(settings, "execution_enabled", False)), "agents": []}
    try:
        from app.api.command_centre import _collect_statuses
        from app.command_centre import crawler
        snap = crawler.snapshot(_collect_statuses(), datetime.now(timezone.utc))
        out["agents"] = [{"id": a.get("id"), "health": a.get("health"), "running": a.get("running")} for a in snap.get("agents", [])]
        out["totals"] = snap.get("totals", {})
    except Exception as e:  # the agent registry is optional context
        out["agents_unavailable"] = type(e).__name__
    return out


# ---- async feeds ----------------------------------------------------------------------------------------------------------
async def paper_section() -> dict:
    try:
        from app.paper import runtime as paper_runtime
        v = await paper_runtime.get_exchange().account()
        if hasattr(v, "model_dump"):
            v = v.model_dump()
        v = v if isinstance(v, dict) else dict(getattr(v, "__dict__", {}))
    except Exception as e:
        return {"available": False, "reason": f"simulated account unavailable ({type(e).__name__})"}
    f = lambda k: float(v.get(k) or 0)
    pos = []
    for p in v.get("positions") or []:
        if isinstance(p, dict) and p.get("open"):
            try:
                unreal = float(p["qty"]) * (float(p["mark_price"]) - float(p["avg_cost"]))
            except (KeyError, TypeError, ValueError):
                unreal = None
            pos.append({"symbol": p.get("symbol"), "qty": p.get("qty"), "avg_cost": p.get("avg_cost"), "mark_price": p.get("mark_price"),
                        "market_value": p.get("market_value"), "unrealized_pnl": unreal})
    return {"available": True, "simulated": True, "unrealized_pnl": f("unrealized_pnl"), "realized_pnl": f("realized_pnl"), "equity": f("equity"),
            "cash": f("cash"), "starting_cash": f("starting_cash"), "fees_paid": f("fees_paid"), "positions": pos,
            "note": "SIMULATED paper account. It is not company money."}


async def blockchain_section(db, settings, book: str) -> dict:
    import asyncio
    from sqlalchemy import select
    from app.chain.models import ChainTransaction
    from app.chain.networks import NETWORKS, chain_enabled, rpc_url
    from app.chain.service import ChainError, ChainService
    if not chain_enabled():
        return {"available": False, "reason": "The on-chain wallet is disabled (CHAIN_ENABLED is not true).", "book_value_usd": book}
    svc = ChainService(db, settings)
    w = svc.wallet()
    nets = [n for n in NETWORKS.values() if rpc_url(n.key)]
    status = list(await asyncio.gather(*[svc.network_status(n) for n in nets])) if nets else []
    tokens = {}
    if w:
        for n, s in zip(nets, status):
            if s.get("connected"):
                try:
                    tokens[n.key] = await svc.token_balances(n)
                except ChainError as e:
                    tokens[n.key] = [{"error": e.message}]
    pend = [svc.tx_dict(t) for t in db.scalars(select(ChainTransaction).where(ChainTransaction.status.in_(("signed", "pending"))).order_by(ChainTransaction.id.desc()))]
    return {"available": True, "wallet": svc.wallet_dict(w) if w else None, "book_value_usd": book,
            "networks": [{k: s.get(k) for k in ("network", "label", "native", "mainnet", "connected", "configured", "balance", "block", "error", "note", "explorer")} for s in status],
            "tokens": tokens, "pending_transactions": pend,
            "note": "Native balances are shown per network; they are not summed or priced. Testnet balances are not company assets."}


def wallet_book_value(ledger, currency: str, as_of: date) -> str:
    return m(bal(calc.natural_balances(reports.trial_balance(ledger, as_of.isoformat(), None, "real", None)["rows"], currency), calc.WALLET))


# ---- composition ------------------------------------------------------------------------------------------------------------
def _kpi(id_: str, label: str, value, kind: str = "money", sub: str = "", tone: str = "", note: str = "", pending: bool = False) -> dict:
    return {"id": id_, "label": label, "value": value, "kind": kind, "sub": sub, "tone": tone, "note": note, "pending_async": pending}


def _neg(s) -> bool:
    return s is not None and str(s).startswith("-")


def compose(role: str, b: dict, st: dict, paper: Optional[dict], as_of: date, scope: str, currency: str, range_key: str, settings) -> dict:
    reqs = list(st["reqs"])
    cur_reqs = [r for r in reqs if r["currency"] == currency]
    pol = st["policy"]
    committed = sum(r["amount_units"] for r in cur_reqs if r["status"] == "approved")
    target = max(pol["target_units"], pol["months_of_burn"] * b["burn"])
    S: dict[str, Any] = {}
    S["position"] = {**calc.position(b["bal_sel"]), "scope": scope, "currency": currency,
                     "other_currencies": [c for c in b["currencies"] if c != currency], "simulated_included": scope != "real"}
    S["liquidity"] = calc.liquidity(b["bal_real"], b["accts"], committed, target, b["burn"])
    S["trading_capital"] = {k: S["liquidity"][k] for k in ("trading_capital", "exchange_cash", "open_positions_at_cost")}
    S["trading"] = sec_trading(b, scope)
    S["unrealized"] = paper or {"available": False, "reason": "not loaded for this view"}
    S["expenditure"] = sec_expenditure(b, range_key)
    S["budgets"] = calc.budget_rows(st["budgets"], b["dept_ytd"], as_of)
    S["obligations"] = sec_obligations(b, reqs, currency)
    S["payments"] = calc.payment_rollup(reqs, currency, as_of)
    S["forecast"] = calc.forecast(as_of, bal(b["bal_real"], calc.BANK), b["ar"]["documents"], b["ap"]["documents"], cur_reqs, b["burn"])
    S["reserve"] = sec_reserve(b, pol)
    S["controls"] = sec_controls(b, reqs, S["budgets"], calc.position(b["bal_real"]), as_of)
    S["reconciliation"] = {"runs": [{k: r.get(k) for k in ("id", "kind", "source", "account", "status", "date_from", "date_to", "ran_at")} for r in b["runs"]],
                           "closed_periods": b["closed"], "periods_with_postings": b["periods"]}
    S["audit_log"] = st["audit"]
    S["system"] = sec_system(settings) if role == "operations" else {}

    # alerts ---------------------------------------------------------------------------------------------------------------
    al, liq, pay, fc, res = [], S["liquidity"], S["payments"], S["forecast"]["scenarios"], S["reserve"]
    ig = b["integrity"]
    if not ig["ok"]:
        al.append(_alert("critical", "ledger_chain", "Ledger integrity check failed", f"First bad entry: {ig.get('first_bad_entry')}"))
    if not S["position"]["balanced"]:
        al.append(_alert("critical", "unbalanced", "Balance sheet does not balance", "Difference " + S["position"]["difference"]))
    if _neg(liq["available_operating"]):
        al.append(_alert("critical", "funds_negative", "Approved payments exceed operating cash", f"Available {liq['available_operating']} {currency}", ("executive", "finance", "operations")))
    if res["status"] == "underfunded":
        al.append(_alert("high", "reserve_short", "Emergency reserve below target", f"Shortfall {res['shortfall']} {currency}", ("executive", "finance", "operations")))
    if fc["base"]["first_negative_week"]:
        al.append(_alert("high", "forecast_gap", "Cash forecast turns negative", f"Base case, week {fc['base']['first_negative_week']} of 13 (low {fc['base']['min_closing']})", ("executive", "finance")))
    elif fc["downside"]["first_negative_week"]:
        al.append(_alert("warn", "forecast_downside", "Downside cash forecast turns negative", f"Week {fc['downside']['first_negative_week']} of 13", ("executive", "finance")))
    if _u8(S["obligations"]["overdue_payables"]) > 0:
        al.append(_alert("warn", "overdue_ap", "Overdue supplier bills", f"{S['obligations']['overdue_payables']} {currency} past due", ("executive", "finance", "operations")))
    for r in S["budgets"]["rows"]:
        if r["status"] in ("over", "unbudgeted"):
            al.append(_alert("high" if r["status"] == "over" else "warn", "budget_" + r["department"], f"{r['department']}: {r['status']}", f"Spent {r['actual_ytd']} against budget {r['budget']}", ("executive", "finance", "auditor")))
    if pay["pending"]["count"]:
        al.append(_alert("info", "pending_approvals", f"{pay['pending']['count']} request(s) awaiting approval", f"Total {pay['pending']['total']} {currency}", ("executive", "finance", "operations")))
    if pay["overdue"]["count"]:
        al.append(_alert("warn", "overdue_requests", f"{pay['overdue']['count']} payment request(s) past due date", f"Total {pay['overdue']['total']} {currency}", ("finance", "operations")))
    if S["controls"]["failed"] or S["controls"]["warnings"]:
        al.append(_alert("high" if S["controls"]["failed"] else "warn", "controls", "Audit controls need attention", f"{S['controls']['failed']} failed, {S['controls']['warnings']} warning(s)", ("auditor", "finance")))
    if getattr(settings, "kill_switch", False):
        al.append(_alert("info", "kill_switch", "Kill switch is ON", "Trading and wallet spends are blocked", ("executive", "operations", "trading")))
    rank = {"critical": 0, "high": 1, "warn": 2, "info": 3}
    S["alerts"] = sorted([a for a in al if not a["roles"] or role in a["roles"]], key=lambda a: rank[a["severity"]])

    # KPI cards ------------------------------------------------------------------------------------------------------------
    pos, tr, bud, ob, ex, un = S["position"], S["trading"], S["budgets"], S["obligations"], S["expenditure"], S["unrealized"]
    ctl = S["controls"]
    cards = {
        "total_assets": _kpi("total_assets", "Total company assets", pos["total_assets"], sub="all asset accounts, " + tr["label"] + " scope"),
        "total_liabilities": _kpi("total_liabilities", "Total liabilities", pos["total_liabilities"], sub="payables, accruals, taxes"),
        "net_equity": _kpi("net_equity", "Net company equity", pos["net_equity"], tone="neg" if _neg(pos["net_equity"]) else "pos", sub="assets minus liabilities"),
        "trading_capital": _kpi("trading_capital", "Trading capital", liq["trading_capital"], sub="exchange cash + open positions at cost"),
        "realized_trading_profit": _kpi("realized_trading_profit", "Realized trading profits", tr["realized_net"], tone="neg" if _neg(tr["realized_net"]) else "pos", sub=f"{range_key.upper()}, net of fees; all-time {tr['realized_all_time']}", note=tr["label"]),
        "unrealized_pnl": _kpi("unrealized_pnl", "Unrealized P&L", f"{un['unrealized_pnl']:.2f}" if un.get("available") else None,
                              tone=("neg" if un["unrealized_pnl"] < 0 else "pos") if un.get("available") else "",
                              sub="SIMULATED paper account" if un.get("available") else (un.get("reason") or "unavailable"),
                              note="No live mark-to-market feed: real positions are carried at cost."),
        "available_operating_funds": _kpi("available_operating_funds", "Available operating funds", liq["available_operating"], tone="neg" if _neg(liq["available_operating"]) else "", sub=f"bank {liq['operating_cash']} less approved {liq['committed_payments']}"),
        "emergency_reserves": _kpi("emergency_reserves", "Emergency reserves", res["held"], tone="warn" if res["status"] == "underfunded" else "", sub=f"target {res['target']} ({res['coverage_pct']}%)" if res["coverage_pct"] is not None else "no target set"),
        "departmental_budgets": _kpi("departmental_budgets", "Departmental budgets", bud["total_budget"], sub=f"{bud['total_actual']} spent YTD ({bud['utilisation_pct']}%)" if bud["utilisation_pct"] is not None else "no budgets set"),
        "total_expenditure": _kpi("total_expenditure", "Total expenditure", ex["total"], sub=f"{range_key.upper()}: operating {ex['operating']}, trading {ex['trading_costs']}"),
        "blockchain_balances": _kpi("blockchain_balances", "Blockchain balances", None, kind="text", sub="loading on-chain balances", pending=True),
        "pending_withdrawals": _kpi("pending_withdrawals", "Pending withdrawals", pay["pending_withdrawals"]["count"], kind="count", sub=f"{pay['pending_withdrawals']['total']} {currency} awaiting approval or payment"),
        "approved_payments": _kpi("approved_payments", "Approved payments", pay["approved"]["total"], sub=f"{pay['approved']['count']} awaiting payment; paid MTD {pay['paid_mtd']['total']}"),
        "outstanding_obligations": _kpi("outstanding_obligations", "Outstanding obligations", ob["total"], tone="warn" if _u8(ob["overdue_payables"]) > 0 else "", sub=f"overdue bills {ob['overdue_payables']}"),
        "cash_flow_forecast": _kpi("cash_flow_forecast", "13-week cash forecast", fc["base"]["min_closing"], tone="neg" if fc["base"]["first_negative_week"] else "pos", sub=f"base-case low (wk {fc['base']['min_week']}); ends {fc['base']['ending']}"),
        "trades": _kpi("trades", "Closed trades", tr["trades"], kind="count", sub=tr["label"]),
        "win_rate": _kpi("win_rate", "Win rate", tr["win_rate"], kind="pct", sub="closed trades"),
        "trading_costs": _kpi("trading_costs", "Trading costs", ex["trading_costs"], sub="fees, gas and losses booked as expenses"),
        "pending_approvals": _kpi("pending_approvals", "Awaiting approval", pay["pending"]["count"], kind="count", sub=f"{pay['pending']['total']} {currency}"),
        "overdue_payments": _kpi("overdue_payments", "Overdue payment requests", pay["overdue"]["count"], kind="count", tone="warn" if pay["overdue"]["count"] else "", sub=f"{pay['overdue']['total']} {currency}"),
        "controls_passed": _kpi("controls_passed", "Controls passed", ctl["passed"], kind="count", tone="pos"),
        "controls_warn": _kpi("controls_warn", "Control warnings", ctl["warnings"], kind="count", tone="warn" if ctl["warnings"] else ""),
        "controls_failed": _kpi("controls_failed", "Controls failed", ctl["failed"], kind="count", tone="neg" if ctl["failed"] else ""),
        "ledger_entries": _kpi("ledger_entries", "Journal entries", b["entries"], kind="count", sub="hash chain " + ("intact" if ig["ok"] else "BROKEN")),
        "unbooked_payments": _kpi("unbooked_payments", "Paid but not booked", ctl["unbooked"], kind="count", tone="warn" if ctl["unbooked"] else ""),
    }
    return {"sections": {k: S[k] for k in ROLE_SECTIONS[role]}, "kpis": [cards[k] for k in KPI_SETS[role]]}

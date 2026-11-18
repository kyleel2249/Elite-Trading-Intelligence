"""Accounts payable / receivable. The subledger is derived from tagged journal entries (document_id), so it can never
drift from the general ledger; `tie_out` proves it."""
from __future__ import annotations

from collections import defaultdict
from datetime import date as _date
from typing import Optional

from app.accounting import coa
from app.accounting.domain import (SCOPES, EntrySpec, Line, NotFound, ValidationError, check_currency, parse_date)
from app.accounting.ledger import _LOCK, Ledger
from app.accounting.money import fmt

KINDS = {"bill": {"control": coa.AP, "credit_normal": True, "pay_source": "bill_payment", "party": "vendor"},
         "invoice": {"control": coa.AR, "credit_normal": False, "pay_source": "invoice_receipt", "party": "customer"}}


def _doc_id(kind: str, party: str, number: str) -> str:
    return f"{kind}:{party.strip().lower()}:{number.strip()}"


def _items(ledger: Ledger, kind: str, items: list) -> list[tuple[str, int, Optional[str], str]]:
    if not items:
        raise ValidationError("at least one item is required")
    accts = ledger.accounts()
    allowed = ("expense", "asset") if kind == "bill" else ("revenue",)
    out = []
    for it in items:
        a = accts.get(it["account"])
        if a is None:
            raise ValidationError(f"unknown account {it['account']}")
        if a.type not in allowed or a.cash or it["account"] in (coa.AP, coa.AR):
            raise ValidationError(f"account {a.code} is not valid for a {kind} line (needs {'/'.join(allowed)})")
        if int(it["units"]) <= 0:
            raise ValidationError("item amounts must be positive")
        out.append((a.code, int(it["units"]), it.get("department"), it.get("description", "")))
    return out


def create_document(ledger: Ledger, kind: str, party: str, number: str, issue_date: str, due_date: str, currency: str,
                    items: list, memo: str = "", by: str = "system"):
    if kind not in KINDS:
        raise ValidationError("kind must be bill or invoice")
    if not party.strip() or not number.strip():
        raise ValidationError("party and document number are required")
    cur = check_currency(currency)
    if parse_date(due_date) < parse_date(issue_date):
        raise ValidationError("due_date is before issue_date")
    rows = _items(ledger, kind, items)
    total = sum(r[1] for r in rows)
    control = KINDS[kind]["control"]
    if kind == "bill":
        lines = [Line(a, d, 0, cur, dep, counterparty=party, memo=desc) for a, d, dep, desc in rows] + \
                [Line(control, 0, total, cur, counterparty=party, memo=f"{kind} {number}")]
    else:
        lines = [Line(control, total, 0, cur, counterparty=party, memo=f"{kind} {number}")] + \
                [Line(a, 0, d, cur, dep, counterparty=party, memo=desc) for a, d, dep, desc in rows]
    doc_id = _doc_id(kind, party, number)
    meta = {"party": party.strip(), "number": number.strip(), "issue_date": issue_date, "due_date": due_date,
            "total_units": total, "currency": cur}
    res = ledger.post(EntrySpec(issue_date, kind, f"{party.strip().lower()}|{number.strip()}", lines,
                                memo or f"{kind} {number} from/to {party}", "internal", doc_id, meta, by))
    warnings = []
    if not res.duplicate:
        for d in list_documents(ledger, kind, scope="real"):
            if d["document_id"] != doc_id and d["party"].lower() == party.strip().lower() and d["total_units"] == total \
                    and d["issue_date"] == issue_date:
                warnings.append(f"possible duplicate of {d['number']}: same party, date and amount")
    return res, doc_id, warnings


def _control_balance(ledger: Ledger, kind: str, doc_id: str) -> int:
    ctl = KINDS[kind]
    n = 0
    for e in ledger.store.entries():
        if e.document_id != doc_id:
            continue
        for l in e.lines:
            if l.account == ctl["control"]:
                n += (l.credit - l.debit) if ctl["credit_normal"] else (l.debit - l.credit)
    return n


def list_documents(ledger: Ledger, kind: str, as_of: Optional[str] = None, scope: str = "real", currency: Optional[str] = None,
                   status: Optional[str] = None) -> list[dict]:
    ctl = KINDS[kind]
    envs = SCOPES[scope]
    docs: dict[str, dict] = {}
    for e in ledger.store.entries(None, as_of):
        if e.environment not in envs or not e.document_id:
            continue
        if e.source == kind:
            m = e.meta
            docs[e.document_id] = {"document_id": e.document_id, "kind": kind, "party": m["party"], "number": m["number"],
                                   "issue_date": m["issue_date"], "due_date": m["due_date"], "currency": m["currency"],
                                   "total_units": m["total_units"], "outstanding_units": 0, "entry": e.entry_no,
                                   "_void": ledger.store.reversal_of(e.id) is not None}
    for e in ledger.store.entries(None, as_of):
        if e.document_id in docs:
            for l in e.lines:
                if l.account == ctl["control"]:
                    docs[e.document_id]["outstanding_units"] += (l.credit - l.debit) if ctl["credit_normal"] else (l.debit - l.credit)
    today = _date.fromisoformat(as_of) if as_of else _date.today()
    out = []
    for d in docs.values():
        if currency and d["currency"] != currency:
            continue
        o = d["outstanding_units"]
        d["total"], d["outstanding"], d["paid"] = fmt(d["total_units"]), fmt(o), fmt(d["total_units"] - o)
        d["status"] = "void" if d.pop("_void") else ("paid" if o == 0 else ("partial" if o < d["total_units"] else "open"))
        d["days_overdue"] = max(0, (today - _date.fromisoformat(d["due_date"])).days) if o else 0
        if not status or d["status"] == status or (status == "outstanding" and o):
            out.append(d)
    return sorted(out, key=lambda x: (x["due_date"], x["document_id"]))


def settle(ledger: Ledger, kind: str, doc_id: str, amount_units: int, date: str, cash_account: str, ref: str,
           by: str = "system"):
    """Pay a bill / receive against an invoice. `ref` (bank or exchange transaction id) is the idempotency key."""
    if not ref or not ref.strip():
        raise ValidationError("a payment reference is required (it prevents double-posting)")
    if amount_units <= 0:
        raise ValidationError("amount must be positive")
    ctl = KINDS[kind]
    cash = ledger.accounts().get(cash_account)
    if cash is None or not cash.cash:
        raise ValidationError(f"{cash_account} is not a cash account")
    with _LOCK:
        existing = ledger.store.find_entry(ctl["pay_source"], ref.strip())
        doc = next((d for d in list_documents(ledger, kind, scope="real") if d["document_id"] == doc_id), None)
        if doc is None:
            raise NotFound(f"{kind} {doc_id} not found")
        if existing is None and amount_units > doc["outstanding_units"]:
            raise ValidationError(f"payment {fmt(amount_units, 2)} exceeds the outstanding {doc['outstanding']}")
        if parse_date(date) < parse_date(doc["issue_date"]):
            raise ValidationError("payment date precedes the document date")
        cur = doc["currency"]
        if kind == "bill":
            lines = [Line(ctl["control"], amount_units, 0, cur, counterparty=doc["party"]),
                     Line(cash_account, 0, amount_units, cur, counterparty=doc["party"], external_ref=ref.strip())]
        else:
            lines = [Line(cash_account, amount_units, 0, cur, counterparty=doc["party"], external_ref=ref.strip()),
                     Line(ctl["control"], 0, amount_units, cur, counterparty=doc["party"])]
        return ledger.post(EntrySpec(date, ctl["pay_source"], ref.strip(), lines,
                                     f"{'Payment of' if kind == 'bill' else 'Receipt for'} {kind} {doc['number']}",
                                     "internal", doc_id, {"ref": ref.strip()}, by))


BUCKETS = ("current", "1-30", "31-60", "61-90", "90+")


def aging(ledger: Ledger, kind: str, as_of: str, scope: str = "real", currency: str = "USD") -> dict:
    today = _date.fromisoformat(as_of)
    buckets = {b: 0 for b in BUCKETS}
    rows = []
    for d in list_documents(ledger, kind, as_of, scope, currency, status="outstanding"):
        late = (today - _date.fromisoformat(d["due_date"])).days
        b = "current" if late <= 0 else "1-30" if late <= 30 else "31-60" if late <= 60 else "61-90" if late <= 90 else "90+"
        buckets[b] += d["outstanding_units"]
        rows.append({**d, "bucket": b, "days_overdue": max(0, late)})
    total = sum(buckets.values())
    tie = tie_out(ledger, kind, as_of, scope, currency)
    return {"report": f"{'ap' if kind == 'bill' else 'ar'}_aging", "as_of": as_of, "currency": currency,
            "buckets": {b: fmt(v) for b, v in buckets.items()}, "total_outstanding": fmt(total), "documents": rows,
            "ties_to_general_ledger": tie["ties"], "gl_balance": tie["gl_balance"]}


def tie_out(ledger: Ledger, kind: str, as_of: str, scope: str, currency: str) -> dict:
    ctl = KINDS[kind]
    gl = 0
    envs = SCOPES[scope]
    for e in ledger.store.entries(None, as_of):
        if e.environment in envs:
            for l in e.lines:
                if l.account == ctl["control"] and l.currency == currency:
                    gl += (l.credit - l.debit) if ctl["credit_normal"] else (l.debit - l.credit)
    sub = sum(d["outstanding_units"] for d in list_documents(ledger, kind, as_of, scope, currency))
    return {"ties": gl == sub, "gl_balance": fmt(gl), "subledger_total": fmt(sub)}

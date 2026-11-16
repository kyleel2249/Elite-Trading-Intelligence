"""Write paths for the Executive Command Centre: budgets, the payment/withdrawal approval register and the reserve.

Nothing here moves real money. Marking a request paid records that a payment happened elsewhere (bank, exchange, wallet)
and books it to the double-entry ledger where the booking is unambiguous (bill settlement, expense, internal transfer)."""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
from uuid import uuid4

from sqlalchemy import select

from app.accounting import coa, events, reports, subledger
from app.accounting.domain import NotFound, ValidationError, check_currency, check_department, parse_date
from app.accounting.money import fmt, to_units
from app.database import SessionLocal
from app.executive import calc
from app.executive.models import ExecAudit, ExecBudget, ExecPaymentRequest, ExecReservePolicy

KINDS = ("vendor_payment", "payroll", "tax", "expense", "withdrawal", "other")
OPEN = ("pending", "approved")
_PERIOD_RE = re.compile(r"^\d{4}(-(0[1-9]|1[0-2]))?$")


class ExecError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "executive_error"):
        super().__init__(message)
        self.status, self.code = status, code


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today():
    return datetime.now(timezone.utc).date()


def _audit(db, p, action: str, subject, detail: Optional[dict] = None) -> None:
    db.add(ExecAudit(ts=now_iso(), actor=p.actor, role=p.role, action=action, subject=str(subject)[:96], detail=detail or {}))


def req_json(r: ExecPaymentRequest) -> dict:
    age = (today() - datetime.fromisoformat(r.requested_at).date()).days
    return {"id": r.id, "reference": r.reference, "kind": r.kind, "payee": r.payee, "description": r.description, "amount": fmt(r.amount, 2),
            "amount_exact": fmt(r.amount, 8), "amount_units": r.amount, "currency": r.currency, "department": r.department,
            "due_date": r.due_date, "status": r.status, "document_id": r.document_id, "expense_account": r.expense_account,
            "from_account": r.from_account, "to_account": r.to_account, "requested_by": r.requested_by, "requested_at": r.requested_at,
            "decided_by": r.decided_by, "decided_at": r.decided_at, "decision_note": r.decision_note, "paid_by": r.paid_by,
            "paid_at": r.paid_at, "payment_ref": r.payment_ref, "ledger_entry": r.ledger_entry, "ledger_booked": bool(r.ledger_booked),
            "age_days": age, "overdue": r.status in OPEN and r.due_date < today().isoformat()}


# ---- reads -------------------------------------------------------------------------------------------------------------------
def list_requests(limit: int = 500, status: Optional[str] = None, kind: Optional[str] = None) -> list:
    db = SessionLocal()
    try:
        q = select(ExecPaymentRequest).order_by(ExecPaymentRequest.id.desc()).limit(max(1, min(limit, 2000)))
        if status:
            q = q.where(ExecPaymentRequest.status == status)
        if kind:
            q = q.where(ExecPaymentRequest.kind == kind)
        return [req_json(r) for r in db.scalars(q)]
    finally:
        db.close()


def list_budgets() -> list:
    db = SessionLocal()
    try:
        return [{"id": b.id, "department": b.department, "period": b.period, "currency": b.currency, "amount": fmt(b.amount, 2),
                 "amount_units": b.amount, "note": b.note, "set_by": b.set_by, "updated_at": b.updated_at}
                for b in db.scalars(select(ExecBudget).order_by(ExecBudget.period.desc(), ExecBudget.department))]
    finally:
        db.close()


def get_policy(currency: str) -> dict:
    db = SessionLocal()
    try:
        r = db.get(ExecReservePolicy, currency)
        return {"currency": currency, "target_units": r.target if r else 0, "months_of_burn": r.months_of_burn if r else 0,
                "updated_by": r.updated_by if r else None, "updated_at": r.updated_at if r else None}
    finally:
        db.close()


def list_audit(limit: int = 100) -> list:
    db = SessionLocal()
    try:
        return [{"id": a.id, "ts": a.ts, "actor": a.actor, "role": a.role, "action": a.action, "subject": a.subject, "detail": a.detail}
                for a in db.scalars(select(ExecAudit).order_by(ExecAudit.id.desc()).limit(max(1, min(limit, 1000))))]
    finally:
        db.close()


def executive_threshold() -> int:
    raw = (os.getenv("EXEC_EXECUTIVE_APPROVAL_THRESHOLD") or "").strip()
    try:
        return to_units(raw) if raw else 0
    except Exception:
        return 0


# ---- budgets and reserve policy ------------------------------------------------------------------------------------------------
def set_budget(p, department: str, period: str, currency: str, units: int, note: str = "") -> dict:
    dept = check_department(department)
    if not dept:
        raise ValidationError("department is required")
    if not _PERIOD_RE.match(period or ""):
        raise ValidationError("period must be YYYY or YYYY-MM")
    cur = check_currency(currency)
    if units < 0:
        raise ValidationError("budget must be >= 0")
    db = SessionLocal()
    try:
        row = db.scalar(select(ExecBudget).where(ExecBudget.department == dept, ExecBudget.period == period, ExecBudget.currency == cur))
        old = row.amount if row else None
        if row is None:
            row = ExecBudget(department=dept, period=period, currency=cur, amount=units, note=note, set_by=p.actor, updated_at=now_iso())
            db.add(row)
        else:
            row.amount, row.note, row.set_by, row.updated_at = units, note, p.actor, now_iso()
        _audit(db, p, "budget.set", f"{dept}:{period}:{cur}", {"from": None if old is None else fmt(old, 2), "to": fmt(units, 2)})
        db.commit()
        return {"department": dept, "period": period, "currency": cur, "amount": fmt(units, 2)}
    finally:
        db.close()


def set_policy(p, currency: str, target_units: int, months: int) -> dict:
    cur = check_currency(currency)
    if target_units < 0 or not 0 <= months <= 60:
        raise ValidationError("target must be >= 0 and months_of_burn between 0 and 60")
    db = SessionLocal()
    try:
        row = db.get(ExecReservePolicy, cur)
        if row is None:
            row = ExecReservePolicy(currency=cur, target=target_units, months_of_burn=months, updated_by=p.actor, updated_at=now_iso())
            db.add(row)
        else:
            row.target, row.months_of_burn, row.updated_by, row.updated_at = target_units, months, p.actor, now_iso()
        _audit(db, p, "reserve.policy", cur, {"target": fmt(target_units, 2), "months_of_burn": months})
        db.commit()
    finally:
        db.close()
    return get_policy(cur)


def _balances(ledger, d: str, cur: str) -> dict:
    return calc.natural_balances(reports.trial_balance(ledger, d, None, "real", None)["rows"], cur)


def reserve_move(p, ledger, direction: str, units: int, ref: str, date_s: Optional[str], currency: str = "USD") -> dict:
    cur = check_currency(currency)
    d = parse_date(date_s) if date_s else today().isoformat()
    ref = (ref or "").strip()
    if not ref:
        raise ValidationError("ref is required")
    if direction not in ("fund", "release"):
        raise ValidationError("direction must be fund or release")
    src, dst = (coa.CASH_BANK, coa.RESERVE) if direction == "fund" else (coa.RESERVE, coa.CASH_BANK)
    if calc.bal(_balances(ledger, d, cur), src) < units:
        raise ExecError(f"insufficient balance in account {src}", 422, "insufficient_funds")
    res = ledger.post(events.internal_transfer(d, src, dst, units, ref, cur, p.actor))
    db = SessionLocal()
    try:
        _audit(db, p, "reserve." + direction, ref, {"amount": fmt(units, 2), "currency": cur, "entry": res.entry.entry_no})
        db.commit()
    finally:
        db.close()
    return {"direction": direction, "amount": fmt(units, 2), "currency": cur, "entry_no": res.entry.entry_no, "duplicate": res.duplicate}


# ---- payment / withdrawal register ---------------------------------------------------------------------------------------------
def _cash_like(accts: dict, code: Optional[str]) -> bool:
    a = accts.get(code or "")
    return bool(a and a.type == "asset" and (a.cash or code == calc.WALLET))


def create_request(p, ledger, *, kind: str, payee: str, amount_units: int, due_date: str, currency: str = "USD", description: str = "",
                   department: Optional[str] = None, document_id: Optional[str] = None, expense_account: Optional[str] = None,
                   from_account: Optional[str] = None, to_account: Optional[str] = None, idem_key: Optional[str] = None) -> dict:
    if kind not in KINDS:
        raise ValidationError(f"kind must be one of {', '.join(KINDS)}")
    payee = (payee or "").strip()
    if not payee:
        raise ValidationError("payee is required")
    if amount_units <= 0:
        raise ValidationError("amount must be positive")
    cur, due, dept = check_currency(currency), parse_date(due_date), check_department(department)
    accts = ledger.accounts()
    doc = None
    if document_id:
        doc = next((d for d in subledger.list_documents(ledger, "bill", None, "real", cur) if d["document_id"] == document_id), None)
        if doc is None:
            raise NotFound(f"no open bill {document_id} in {cur}")
    if kind == "expense":
        a = accts.get(expense_account or "")
        if not (a and a.type == "expense" and a.postable) or not dept:
            raise ValidationError("expense requests need a postable expense_account and a department")
    if kind == "withdrawal":
        if not _cash_like(accts, from_account):
            raise ValidationError("withdrawals need from_account to be a cash or wallet account")
        if to_account and (not _cash_like(accts, to_account) or to_account == from_account):
            raise ValidationError("to_account must be a different company cash or wallet account (omit it for an external withdrawal)")
    db = SessionLocal()
    try:
        if idem_key:
            ex = db.scalar(select(ExecPaymentRequest).where(ExecPaymentRequest.idem_key == idem_key))
            if ex:
                if (ex.kind, ex.payee, ex.amount, ex.currency, ex.due_date) != (kind, payee, amount_units, cur, due):
                    raise ExecError("idem_key was already used with different content", 409, "duplicate_conflict")
                return {**req_json(ex), "duplicate": True}
        if doc is not None:
            committed = sum(r.amount for r in db.scalars(select(ExecPaymentRequest).where(
                ExecPaymentRequest.document_id == document_id, ExecPaymentRequest.status.in_(OPEN))))
            if amount_units + committed > doc["outstanding_units"]:
                raise ValidationError("open requests for this bill would exceed its outstanding balance")
        row = ExecPaymentRequest(reference=f"TMP-{uuid4().hex}", idem_key=idem_key, kind=kind, payee=payee, description=description or "",
                                 amount=amount_units, currency=cur, department=dept, due_date=due, status="pending", document_id=document_id,
                                 expense_account=expense_account, from_account=from_account, to_account=to_account,
                                 requested_by=p.actor, requested_at=now_iso())
        db.add(row)
        db.flush()
        row.reference = f"PR-{row.id:06d}"
        _audit(db, p, "request.create", row.reference, {"kind": kind, "payee": payee, "amount": fmt(amount_units, 2), "currency": cur})
        db.commit()
        db.refresh(row)
        return {**req_json(row), "duplicate": False}
    finally:
        db.close()


def _get(db, rid: int) -> ExecPaymentRequest:
    row = db.get(ExecPaymentRequest, rid)
    if row is None:
        raise NotFound(f"payment request {rid} not found")
    return row


def decide(p, rid: int, decision: str, note: str = "") -> dict:
    db = SessionLocal()
    try:
        row = _get(db, rid)
        if row.status != "pending":
            raise ExecError(f"request is {row.status}; only pending requests can be decided", 409, "invalid_state")
        if decision == "approve":
            if row.requested_by == p.actor:
                raise ExecError("segregation of duties: a requester cannot approve their own request", 403, "four_eyes")
            thr = executive_threshold()
            if thr and row.amount >= thr and p.role != "executive":
                raise ExecError("requests at or above the executive threshold need an executive approval", 403, "executive_approval_required")
            row.status = "approved"
        else:
            if not (note or "").strip():
                raise ValidationError("a reason is required to reject a request")
            row.status = "rejected"
        row.decided_by, row.decided_at, row.decision_note = p.actor, now_iso(), note or None
        _audit(db, p, f"request.{decision}", row.reference, {"note": note})
        db.commit()
        db.refresh(row)
        return req_json(row)
    finally:
        db.close()


def cancel(p, rid: int, note: str = "") -> dict:
    db = SessionLocal()
    try:
        row = _get(db, rid)
        if row.status not in OPEN:
            raise ExecError(f"request is {row.status} and cannot be cancelled", 409, "invalid_state")
        if row.requested_by != p.actor and p.role not in ("executive", "finance"):
            raise ExecError("only the requester, finance or an executive can cancel a request", 403, "forbidden")
        row.status, row.decision_note = "cancelled", note or row.decision_note
        _audit(db, p, "request.cancel", row.reference, {"note": note})
        db.commit()
        db.refresh(row)
        return req_json(row)
    finally:
        db.close()


def mark_paid(p, ledger, rid: int, ref: str, date_s: Optional[str] = None, cash_account: Optional[str] = None) -> dict:
    ref = (ref or "").strip()
    if not ref:
        raise ValidationError("a payment reference is required")
    d = parse_date(date_s) if date_s else today().isoformat()
    db = SessionLocal()
    try:
        row = _get(db, rid)
        if row.status != "approved":
            raise ExecError(f"request is {row.status}; only approved requests can be marked paid", 409, "invalid_state")
        cash = cash_account or coa.CASH_BANK
        entry = None
        if row.document_id:
            entry = subledger.settle(ledger, "bill", row.document_id, row.amount, d, cash, ref, p.actor)
        elif row.kind == "expense":
            entry = ledger.post(events.expense_paid(d, row.expense_account, row.amount, row.department, row.payee, ref, row.currency,
                                                    cash, row.description or "", p.actor))
        elif row.kind == "withdrawal" and row.to_account:
            entry = ledger.post(events.internal_transfer(d, row.from_account, row.to_account, row.amount, ref, row.currency, p.actor))
        row.status, row.paid_by, row.paid_at, row.payment_ref = "paid", p.actor, now_iso(), ref
        row.ledger_booked = entry is not None
        row.ledger_entry = entry.entry.entry_no if entry is not None else None
        _audit(db, p, "request.pay", row.reference, {"ref": ref, "booked": entry is not None, "entry": row.ledger_entry})
        db.commit()
        db.refresh(row)
        out = req_json(row)
        if entry is None:
            out["warning"] = "recorded only: this payment type has no automatic ledger booking, so it needs a manual journal entry"
        return out
    finally:
        db.close()


def state(currency: str, audit_limit: int = 0) -> dict:
    return {"reqs": list_requests(), "budgets": [b for b in list_budgets() if b["currency"] == currency],
            "policy": get_policy(currency), "audit": list_audit(audit_limit) if audit_limit else []}

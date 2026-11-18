"""Executive Command Centre: the /executive page and the /api/executive endpoints.

Access is role based (see app.executive.auth). The page itself carries no data; every figure comes from an authenticated call.
Nothing here executes a withdrawal or transfer: the register tracks requests, approvals and payments made elsewhere."""
from __future__ import annotations

import asyncio
from decimal import Decimal
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.requests import Request

from app import __version__
from app.accounting.domain import (SCOPES, AccountingError, DuplicateConflict, DuplicateReference, NotFound, PeriodClosedError, ValidationError,
                                   check_currency, parse_date)
from app.accounting.money import to_units
from app.accounting.service import get_ledger
from app.config import Settings, get_settings
from app.database import get_db
from app.executive import sections, workflow
from app.executive.auth import PERMISSIONS, ROLES, Principal, principal
from app.executive.workflow import ExecError

router = APIRouter(tags=["executive"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parents[1] / "templates"))


def _err(e: Exception) -> HTTPException:
    if isinstance(e, ExecError):
        return HTTPException(e.status, {"error": str(e), "code": e.code})
    if isinstance(e, NotFound):
        return HTTPException(404, {"error": str(e), "code": e.code})
    if isinstance(e, (DuplicateConflict, DuplicateReference, PeriodClosedError)):
        return HTTPException(409, {"error": str(e), "code": e.code})
    if isinstance(e, AccountingError):
        return HTTPException(422, {"error": str(e), "code": e.code})
    if isinstance(e, ValueError):
        return HTTPException(422, {"error": str(e), "code": "invalid_value"})
    raise e


def guard(fn):
    try:
        return fn()
    except (ExecError, AccountingError, ValueError, ArithmeticError) as e:
        raise _err(e if not isinstance(e, ArithmeticError) else ValueError("invalid amount"))


def _need(p: Principal, perm: str) -> None:
    if not p.can(perm):
        raise HTTPException(403, {"error": f"the {p.role} role cannot do this ({perm}); allowed: {', '.join(PERMISSIONS[perm])}", "code": "forbidden"})


@router.get("/executive", include_in_schema=False)
async def page(request: Request):
    return templates.TemplateResponse(request, "executive.html", {"version": __version__})


@router.get("/api/executive/roles")
async def roles(p: Principal = Depends(principal)):
    return {"you": {"role": p.role, "actor": p.actor, "via": p.via}, "views": [r for r in ROLES if p.can_view(r)],
            "permissions": {k: list(v) for k, v in PERMISSIONS.items()}, "ranges": list(sections.RANGES), "scopes": list(SCOPES),
            "executive_threshold": workflow.executive_threshold() > 0,
            "note": "This centre records and tracks money movements; it never executes a withdrawal or transfer."}


@router.get("/api/executive/view/{role}")
async def view(role: str, scope: str = "real", currency: str = "USD", range_key: str = Query("ytd", alias="range"),
               as_of: Optional[str] = None, p: Principal = Depends(principal), settings: Settings = Depends(get_settings)):
    if role not in ROLES:
        raise HTTPException(404, {"error": f"unknown view {role!r}", "code": "not_found"})
    if not p.can_view(role):
        raise HTTPException(403, {"error": f"this key is limited to the {p.role} view", "code": "forbidden"})

    def prep():
        if scope not in SCOPES or range_key not in sections.RANGES:
            raise ValidationError(f"scope must be one of {', '.join(SCOPES)} and range one of {', '.join(sections.RANGES)}")
        return check_currency(currency), (parse_date(as_of) if as_of else workflow.today())

    cur, day = guard(prep)

    def work():
        b = sections.get_bundle(get_ledger(), day, scope, cur, range_key)
        return b, workflow.state(cur, 200 if role == "auditor" else 0)

    b, st = await asyncio.to_thread(lambda: guard(work))
    paper = await sections.paper_section() if role in ("executive", "trading") else None
    out = sections.compose(role, b, st, paper, day, scope, cur, range_key, settings)
    return {"role": role, "scope": scope, "currency": cur, "range": range_key, "as_of": day.isoformat(), "generated_at": workflow.now_iso(),
            "async_sections": ["blockchain"] if role in PERMISSIONS["blockchain.read"] else [], **out}


@router.get("/api/executive/blockchain")
async def blockchain(currency: str = "USD", p: Principal = Depends(principal), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _need(p, "blockchain.read")
    cur = guard(lambda: check_currency(currency))
    book = await asyncio.to_thread(lambda: sections.wallet_book_value(get_ledger(), cur, workflow.today()))
    return await sections.blockchain_section(db, settings, book)


# ---- payment / withdrawal register --------------------------------------------------------------------------------------------
class PaymentIn(BaseModel):
    kind: str
    payee: str = Field(min_length=1, max_length=128)
    amount: Decimal = Field(gt=0)
    due_date: str
    currency: str = "USD"
    description: str = Field("", max_length=500)
    department: Optional[str] = None
    document_id: Optional[str] = Field(None, max_length=300)
    expense_account: Optional[str] = Field(None, max_length=8)
    from_account: Optional[str] = Field(None, max_length=8)
    to_account: Optional[str] = Field(None, max_length=8)
    idem_key: Optional[str] = Field(None, max_length=120)


class NoteIn(BaseModel):
    note: str = Field("", max_length=500)


class PayIn(BaseModel):
    ref: str = Field(min_length=1, max_length=190)
    date: Optional[str] = None
    cash_account: Optional[str] = Field(None, max_length=8)


@router.get("/api/executive/payments")
async def payments(status: Optional[str] = None, kind: Optional[str] = None, limit: int = Query(200, ge=1, le=2000), p: Principal = Depends(principal)):
    if p.role not in PERMISSIONS["request.create"] + ("auditor", "trading"):
        raise HTTPException(403, {"error": "forbidden", "code": "forbidden"})
    return {"payments": await asyncio.to_thread(workflow.list_requests, limit, status, kind)}


@router.post("/api/executive/payments")
async def create_payment(b: PaymentIn, p: Principal = Depends(principal)):
    _need(p, "request.create")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.create_request(
        p, get_ledger(), kind=b.kind, payee=b.payee, amount_units=to_units(b.amount), due_date=b.due_date, currency=b.currency,
        description=b.description, department=b.department, document_id=b.document_id, expense_account=b.expense_account,
        from_account=b.from_account, to_account=b.to_account, idem_key=b.idem_key)))


@router.post("/api/executive/payments/{rid}/approve")
async def approve(rid: int, b: NoteIn = NoteIn(), p: Principal = Depends(principal)):
    _need(p, "request.approve")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.decide(p, rid, "approve", b.note)))


@router.post("/api/executive/payments/{rid}/reject")
async def reject(rid: int, b: NoteIn, p: Principal = Depends(principal)):
    _need(p, "request.approve")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.decide(p, rid, "reject", b.note)))


@router.post("/api/executive/payments/{rid}/cancel")
async def cancel(rid: int, b: NoteIn = NoteIn(), p: Principal = Depends(principal)):
    _need(p, "request.cancel")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.cancel(p, rid, b.note)))


@router.post("/api/executive/payments/{rid}/pay")
async def pay(rid: int, b: PayIn, p: Principal = Depends(principal)):
    _need(p, "request.pay")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.mark_paid(p, get_ledger(), rid, b.ref, b.date, b.cash_account)))


# ---- budgets, reserve, audit --------------------------------------------------------------------------------------------------
class BudgetIn(BaseModel):
    department: str = Field(min_length=1, max_length=40)
    period: str = Field(min_length=4, max_length=7)
    amount: Decimal = Field(ge=0)
    currency: str = "USD"
    note: str = Field("", max_length=300)


class ReservePolicyIn(BaseModel):
    currency: str = "USD"
    target: Decimal = Field(Decimal(0), ge=0)
    months_of_burn: int = Field(0, ge=0, le=60)


class ReserveMoveIn(BaseModel):
    direction: Literal["fund", "release"]
    amount: Decimal = Field(gt=0)
    ref: str = Field(min_length=1, max_length=190)
    date: Optional[str] = None
    currency: str = "USD"


@router.get("/api/executive/budgets")
async def budgets(p: Principal = Depends(principal)):
    if p.role not in ("executive", "finance", "auditor"):
        raise HTTPException(403, {"error": "forbidden", "code": "forbidden"})
    return {"budgets": await asyncio.to_thread(workflow.list_budgets)}


@router.put("/api/executive/budgets")
async def put_budget(b: BudgetIn, p: Principal = Depends(principal)):
    _need(p, "budget.set")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.set_budget(p, b.department, b.period, b.currency, to_units(b.amount), b.note)))


@router.put("/api/executive/reserve")
async def put_reserve(b: ReservePolicyIn, p: Principal = Depends(principal)):
    _need(p, "reserve.policy")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.set_policy(p, b.currency, to_units(b.target), b.months_of_burn)))


@router.post("/api/executive/reserve/transfer")
async def reserve_transfer(b: ReserveMoveIn, p: Principal = Depends(principal)):
    _need(p, "reserve.transfer")
    return await asyncio.to_thread(lambda: guard(lambda: workflow.reserve_move(p, get_ledger(), b.direction, to_units(b.amount), b.ref, b.date, b.currency)))


@router.get("/api/executive/audit")
async def audit(limit: int = Query(100, ge=1, le=1000), p: Principal = Depends(principal)):
    _need(p, "audit.read")
    return {"audit": await asyncio.to_thread(workflow.list_audit, limit)}

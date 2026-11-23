"""/api/accounting — double-entry ledger, AP/AR, statements, reconciliation. Protected by the API key."""
from __future__ import annotations

import csv
import io
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.accounting import coa, events, reconcile, reports, subledger
from app.accounting.domain import (Account, AccountingError, DuplicateConflict, DuplicateReference, EntrySpec, Line,
                                   NotFound, PeriodClosedError)
from app.accounting.money import fmt, to_units
from app.accounting.service import get_ledger, sync_orders
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/accounting", tags=["accounting"], dependencies=[Depends(require_api_key)])

Amount = Decimal


def _err(e: Exception) -> HTTPException:
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
    except (AccountingError, ValueError) as e:
        raise _err(e)


def _result(res, **extra) -> dict:
    e = res.entry
    return {"entry": e.entry_no, "id": e.id, "duplicate": res.duplicate, "date": e.date, "source": e.source,
            "source_id": e.source_id, "hash": e.hash, **extra}


def _entry_json(e) -> dict:
    return {"id": e.id, "entry": e.entry_no, "date": e.date, "source": e.source, "source_id": e.source_id, "memo": e.memo,
            "environment": e.environment, "reverses": e.reverses, "document_id": e.document_id, "meta": e.meta,
            "posted_by": e.posted_by, "created_at": e.created_at, "hash": e.hash,
            "lines": [{"account": l.account, "debit": fmt(l.debit), "credit": fmt(l.credit), "currency": l.currency,
                       "department": l.department, "symbol": l.symbol, "strategy": l.strategy,
                       "counterparty": l.counterparty, "external_ref": l.external_ref, "memo": l.memo} for l in e.lines]}


# ------------------------------------------------------------------------------------------------ chart of accounts
class AccountBody(BaseModel):
    code: str
    name: str
    type: str
    parent: Optional[str] = None
    postable: bool = True
    cash: bool = False
    cashflow: str = "operating"
    group: str = ""


@router.get("/accounts")
def list_accounts():
    return {"accounts": [a.__dict__ for a in get_ledger().store.list_accounts()], "departments": list(coa.DEPARTMENTS)}


@router.post("/accounts")
def add_account(b: AccountBody):
    led = get_ledger()
    guard(lambda: led.add_account(Account(**b.model_dump())))
    return {"created": b.code}


@router.post("/accounts/{code}/deactivate")
def deactivate(code: str):
    a = guard(lambda: get_ledger().deactivate_account(code))
    return {"code": a.code, "active": a.active}


# ------------------------------------------------------------------------------------------------ journal
class LineBody(BaseModel):
    account: str
    debit: Amount = Decimal(0)
    credit: Amount = Decimal(0)
    currency: str = "USD"
    department: Optional[str] = None
    symbol: Optional[str] = None
    strategy: Optional[str] = None
    counterparty: Optional[str] = None
    external_ref: Optional[str] = None
    memo: str = ""


class EntryBody(BaseModel):
    date: str
    source_id: str = Field(min_length=1, max_length=190)
    memo: str = ""
    environment: str = "internal"
    lines: list[LineBody]


@router.post("/entries")
def post_entry(b: EntryBody):
    """Manual journal entry. `source` is fixed to "manual"; `source_id` is your idempotency key."""
    led = get_ledger()
    lines = guard(lambda: [Line(l.account, to_units(l.debit), to_units(l.credit), l.currency, l.department, l.symbol,
                                l.strategy, l.counterparty, l.external_ref, l.memo) for l in b.lines])
    res = guard(lambda: led.post(EntrySpec(b.date, "manual", b.source_id, lines, b.memo, b.environment, posted_by="api")))
    return _result(res)


@router.post("/entries/{entry_id}/reverse")
def reverse_entry(entry_id: int, date: str, reason: str = Query(min_length=3)):
    return _result(guard(lambda: get_ledger().reverse(entry_id, date, reason, "api")))


@router.get("/entries")
def entries(date_from: Optional[str] = Query(None, alias="from"), date_to: Optional[str] = Query(None, alias="to"),
            limit: int = Query(200, ge=1, le=2000), source: Optional[str] = None):
    rows = [e for e in get_ledger().store.entries(date_from, date_to) if not source or e.source == source]
    return {"entries": [_entry_json(e) for e in rows[-limit:]], "total": len(rows)}


@router.get("/entries/{entry_id}")
def entry(entry_id: int):
    e = get_ledger().store.get_entry(entry_id)
    if not e:
        raise HTTPException(404, {"error": "entry not found", "code": "not_found"})
    return _entry_json(e)


@router.get("/integrity")
def integrity():
    return get_ledger().verify_chain()


# ------------------------------------------------------------------------------------------------ business events
class CapitalBody(BaseModel):
    date: str
    amount: Amount
    ref: str
    currency: str = "USD"
    cash_account: str = coa.CASH_BANK


class ExpenseBody(BaseModel):
    date: str
    amount: Amount
    expense_account: str
    department: str
    vendor: str
    ref: str
    currency: str = "USD"
    cash_account: str = coa.CASH_BANK
    memo: str = ""


class TransferBody(BaseModel):
    date: str
    amount: Amount
    from_account: str
    to_account: str
    ref: str
    currency: str = "USD"


class TradeBody(BaseModel):
    trade_id: str
    date: str
    symbol: str
    strategy: Optional[str] = None
    environment: str
    gross_pnl: Amount
    fees: Amount = Decimal(0)
    currency: str = "USD"
    cash_account: str = coa.CASH_EXCHANGE


class FundingBody(BaseModel):
    ref: str
    date: str
    symbol: str
    environment: str
    amount: Amount
    currency: str = "USD"
    cash_account: str = coa.CASH_EXCHANGE


def _post(spec):
    if spec is None:
        raise HTTPException(422, {"error": "nothing to book (zero P&L and zero fees)", "code": "nothing_to_book"})
    return _result(guard(lambda: get_ledger().post(spec)))


@router.post("/events/capital")
def ev_capital(b: CapitalBody):
    return _post(guard(lambda: events.capital_contribution(b.date, to_units(b.amount), b.ref, b.currency, b.cash_account, "api")))


@router.post("/events/distribution")
def ev_distribution(b: CapitalBody):
    return _post(guard(lambda: events.owner_distribution(b.date, to_units(b.amount), b.ref, b.currency, b.cash_account, "api")))


@router.post("/events/expense")
def ev_expense(b: ExpenseBody):
    return _post(guard(lambda: events.expense_paid(b.date, b.expense_account, to_units(b.amount), b.department, b.vendor,
                                                   b.ref, b.currency, b.cash_account, b.memo, "api")))


@router.post("/events/internal-transfer")
def ev_transfer(b: TransferBody):
    return _post(guard(lambda: events.internal_transfer(b.date, b.from_account, b.to_account, to_units(b.amount), b.ref, b.currency, "api")))


@router.post("/events/trade")
def ev_trade(b: TradeBody):
    return _post(guard(lambda: events.trade_closed(b.trade_id, b.date, b.symbol, b.strategy, b.environment,
                                                   to_units(b.gross_pnl), to_units(b.fees), b.currency, b.cash_account, "api")))


@router.post("/events/funding")
def ev_funding(b: FundingBody):
    return _post(guard(lambda: events.funding(b.ref, b.date, b.symbol, b.environment, to_units(b.amount), b.currency,
                                              b.cash_account, "api")))


@router.post("/sync/orders")
def sync(currency: str = "USD"):
    return guard(lambda: sync_orders(get_ledger(), currency))


# ------------------------------------------------------------------------------------------------ AP / AR
class ItemBody(BaseModel):
    account: str
    amount: Amount
    department: Optional[str] = None
    description: str = ""


class DocBody(BaseModel):
    party: str
    number: str
    issue_date: str
    due_date: str
    currency: str = "USD"
    items: list[ItemBody]
    memo: str = ""


class SettleBody(BaseModel):
    document_id: str
    amount: Amount
    date: str
    cash_account: str = coa.CASH_BANK
    ref: str


def _create(kind: str, b: DocBody):
    items = [{"account": i.account, "units": to_units(i.amount), "department": i.department, "description": i.description} for i in b.items]
    res, doc_id, warnings = guard(lambda: subledger.create_document(get_ledger(), kind, b.party, b.number, b.issue_date,
                                                                     b.due_date, b.currency, items, b.memo, "api"))
    return _result(res, document_id=doc_id, warnings=warnings)


@router.post("/bills")
def create_bill(b: DocBody):
    return _create("bill", b)


@router.post("/invoices")
def create_invoice(b: DocBody):
    return _create("invoice", b)


@router.get("/bills")
def bills(status: Optional[str] = None, currency: Optional[str] = None):
    return {"bills": subledger.list_documents(get_ledger(), "bill", None, "real", currency, status)}


@router.get("/invoices")
def invoices(status: Optional[str] = None, currency: Optional[str] = None):
    return {"invoices": subledger.list_documents(get_ledger(), "invoice", None, "real", currency, status)}


@router.post("/bills/pay")
def pay_bill(b: SettleBody):
    return _result(guard(lambda: subledger.settle(get_ledger(), "bill", b.document_id, to_units(b.amount), b.date,
                                                  b.cash_account, b.ref, "api")))


@router.post("/invoices/receive")
def receive_invoice(b: SettleBody):
    return _result(guard(lambda: subledger.settle(get_ledger(), "invoice", b.document_id, to_units(b.amount), b.date,
                                                  b.cash_account, b.ref, "api")))


@router.get("/aging/{kind}")
def aging(kind: str, as_of: str, currency: str = "USD"):
    if kind not in ("payable", "receivable"):
        raise HTTPException(404, {"error": "kind must be payable or receivable", "code": "not_found"})
    return guard(lambda: subledger.aging(get_ledger(), "bill" if kind == "payable" else "invoice", as_of, "real", currency))


# ------------------------------------------------------------------------------------------------ reports
def _csv(rows: list[dict]) -> PlainTextResponse:
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@router.get("/reports/trial-balance")
def trial_balance(as_of: str, date_from: Optional[str] = Query(None, alias="from"), scope: str = "real",
                  currency: Optional[str] = None, format: str = "json"):
    r = guard(lambda: reports.trial_balance(get_ledger(), as_of, date_from, scope, currency))
    return _csv(r["rows"]) if format == "csv" else r


@router.get("/reports/income-statement")
def income_statement(date_from: str = Query(alias="from"), date_to: str = Query(alias="to"), scope: str = "real", currency: str = "USD"):
    return guard(lambda: reports.income_statement(get_ledger(), date_from, date_to, scope, currency))


@router.get("/reports/balance-sheet")
def balance_sheet(as_of: str, scope: str = "real", currency: str = "USD"):
    return guard(lambda: reports.balance_sheet(get_ledger(), as_of, scope, currency))


@router.get("/reports/cash-flow")
def cash_flow(date_from: str = Query(alias="from"), date_to: str = Query(alias="to"), scope: str = "real", currency: str = "USD"):
    return guard(lambda: reports.cash_flow(get_ledger(), date_from, date_to, scope, currency))


@router.get("/reports/departments")
def departments(date_from: str = Query(alias="from"), date_to: str = Query(alias="to"), scope: str = "real", currency: str = "USD"):
    return guard(lambda: reports.department_expenses(get_ledger(), date_from, date_to, scope, currency))


@router.get("/reports/trading-pnl")
def trading_pnl(date_from: str = Query(alias="from"), date_to: str = Query(alias="to"), scope: str = "all", currency: str = "USD"):
    return guard(lambda: reports.trading_pnl(get_ledger(), date_from, date_to, currency, scope))


@router.get("/reports/general-ledger")
def general_ledger(account: str, date_from: Optional[str] = Query(None, alias="from"), date_to: Optional[str] = Query(None, alias="to"),
                   scope: str = "all", currency: Optional[str] = None, format: str = "json"):
    r = guard(lambda: reports.general_ledger(get_ledger(), account, date_from, date_to, scope, currency))
    return _csv(r["rows"]) if format == "csv" else r


@router.get("/reports/monthly")
def monthly(period: str, scope: str = "real", currency: str = "USD"):
    return guard(lambda: reports.period_report(get_ledger(), period, scope, currency))


@router.get("/reports/annual")
def annual(year: int, scope: str = "real", currency: str = "USD"):
    return guard(lambda: reports.period_report(get_ledger(), str(year), scope, currency))


# ------------------------------------------------------------------------------------------------ periods
class PeriodBody(BaseModel):
    period: str


class YearBody(BaseModel):
    year: int = Field(ge=2000, le=2200)
    environments: list[str] = ["internal", "live"]


@router.post("/periods/close")
def close_period(b: PeriodBody):
    led = get_ledger()
    return {"period": b.period, "closed": guard(lambda: led.close_period(b.period, "api"))}


@router.post("/periods/close-year")
def close_year(b: YearBody):
    led = get_ledger()
    out = {}
    for env in b.environments:
        r = guard(lambda: led.close_year(b.year, "api", env))
        out[env] = None if r is None else _result(r)
    return {"year": b.year, "closing_entries": out}


# ------------------------------------------------------------------------------------------------ reconciliation
class IngestBody(BaseModel):
    source: str
    kind: str
    transactions: list[dict]


class ReconTxBody(BaseModel):
    source: str
    account: str
    date_from: str
    date_to: str
    min_confirmations: int = Field(1, ge=0, le=1000)
    scope: str = "real"


class PostMissingBody(ReconTxBody):
    confirm: bool = False


class ReconBalanceBody(BaseModel):
    account: str
    as_of: str
    external_balance: Amount
    currency: str = "USD"
    source: str
    note: str = ""
    scope: str = "real"


@router.post("/reconcile/ingest")
def ingest(b: IngestBody):
    """Store bank / exchange / blockchain transactions exactly as reported by their source. Re-importing is harmless."""
    return guard(lambda: reconcile.ingest(get_ledger(), b.source, b.kind, b.transactions))


@router.post("/reconcile/transactions")
def recon_transactions(b: ReconTxBody):
    return guard(lambda: reconcile.reconcile_transactions(get_ledger(), b.source, b.account, b.date_from, b.date_to,
                                                          b.min_confirmations, b.scope))


@router.post("/reconcile/post-missing")
def recon_post_missing(b: PostMissingBody):
    if not b.confirm:
        raise HTTPException(400, {"error": "set confirm=true to book missing transactions to suspense", "code": "confirmation_required"})
    return guard(lambda: reconcile.post_missing(get_ledger(), b.source, b.account, b.date_from, b.date_to, b.min_confirmations, "api"))


@router.post("/reconcile/balance")
def recon_balance(b: ReconBalanceBody):
    return guard(lambda: reconcile.reconcile_balance(get_ledger(), b.account, b.as_of, b.external_balance, b.currency,
                                                     b.source, b.note, b.scope))


@router.get("/reconcile/runs")
def recon_runs(kind: Optional[str] = None, limit: int = Query(50, ge=1, le=500)):
    return {"runs": [{k: v for k, v in r.items() if k != "result"} for r in get_ledger().store.runs(kind, limit)]}


@router.get("/reconcile/runs/{run_id}")
def recon_run(run_id: int):
    for r in get_ledger().store.runs(None, 500):
        if r["id"] == run_id:
            return r
    raise HTTPException(404, {"error": "run not found", "code": "not_found"})

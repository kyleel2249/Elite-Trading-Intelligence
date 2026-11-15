"""Accounting over SQL + HTTP: persistence, immutability triggers, idempotency, statements and reconciliation."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.accounting import coa, events
from app.accounting.domain import DuplicateConflict, DuplicateReference
from app.accounting.ledger import Ledger
from app.accounting.money import to_units as U
from app.accounting.sql_store import SqlStore
from app.database import SessionLocal, engine, init_db
from app.main import app

init_db()
client = TestClient(app)


def _ledger() -> Ledger:
    led = Ledger(SqlStore(SessionLocal))
    led.seed_chart()
    return led


def test_sql_ledger_persists_is_idempotent_and_chained():
    led = _ledger()
    a = led.post(events.capital_contribution("2033-01-05", U(500), "sql-cap-1"))
    b = led.post(events.capital_contribution("2033-01-05", U(500), "sql-cap-1"))
    assert not a.duplicate and b.duplicate and a.entry.id == b.entry.id
    with pytest.raises(DuplicateConflict):
        led.post(events.capital_contribution("2033-01-05", U(501), "sql-cap-1"))
    with pytest.raises(DuplicateReference):
        led.post(events.expense_paid("2033-01-06", coa.INFRA, U(1), "Engineering", "V", "sql-cap-1"))
    assert led.store.get_entry(a.entry.id).lines[0].debit == U(500)
    assert led.verify_chain()["ok"]


def test_journal_rows_cannot_be_updated_or_deleted_even_with_raw_sql():
    led = _ledger()
    e = led.post(events.capital_contribution("2033-02-05", U(5), "sql-cap-2")).entry
    for stmt in ("UPDATE acct_lines SET debit = 1 WHERE entry_id = :i", "DELETE FROM acct_lines WHERE entry_id = :i",
                 "UPDATE acct_entries SET memo = 'x' WHERE id = :i", "DELETE FROM acct_entries WHERE id = :i"):
        with engine.begin() as c:
            with pytest.raises(DBAPIError):
                c.execute(text(stmt), {"i": e.id})
    assert led.verify_chain()["ok"]


def test_http_end_to_end_flow():
    p = "/api/accounting"
    assert client.post(f"{p}/events/capital", json={"date": "2034-01-02", "amount": "10000", "ref": "api-cap-1"}).json()["duplicate"] is False
    assert client.post(f"{p}/events/capital", json={"date": "2034-01-02", "amount": "10000", "ref": "api-cap-1"}).json()["duplicate"] is True
    assert client.post(f"{p}/events/capital", json={"date": "2034-01-02", "amount": "9999", "ref": "api-cap-1"}).status_code == 409
    r = client.post(f"{p}/events/expense", json={"date": "2034-01-10", "amount": "250.50", "expense_account": "5300",
                                                  "department": "Engineering", "vendor": "Cloud", "ref": "api-exp-1"})
    assert r.status_code == 200
    bill = client.post(f"{p}/bills", json={"party": "Vendor A", "number": "A-1", "issue_date": "2034-01-12", "due_date": "2034-02-12",
                                           "items": [{"account": "5600", "amount": "400", "department": "Administration"}]}).json()
    assert client.post(f"{p}/bills/pay", json={"document_id": bill["document_id"], "amount": "150", "date": "2034-01-20", "ref": "api-pay-1"}).status_code == 200
    assert client.post(f"{p}/bills/pay", json={"document_id": bill["document_id"], "amount": "999", "date": "2034-01-21", "ref": "api-pay-2"}).status_code == 422
    inv = client.post(f"{p}/invoices", json={"party": "Client", "number": "I-1", "issue_date": "2034-01-15", "due_date": "2034-01-30",
                                             "items": [{"account": "4000", "amount": "900"}]}).json()
    assert client.post(f"{p}/invoices/receive", json={"document_id": inv["document_id"], "amount": "900", "date": "2034-01-25", "ref": "api-rcpt-1"}).status_code == 200
    t = {"trade_id": "api-t1", "date": "2034-01-18", "symbol": "ETHUSDT", "strategy": "swing", "environment": "paper", "gross_pnl": "12.5", "fees": "0.5"}
    assert client.post(f"{p}/events/trade", json=t).status_code == 200
    assert client.post(f"{p}/events/trade", json={**t, "gross_pnl": "0", "fees": "0", "trade_id": "api-t0"}).status_code == 422

    inc = client.get(f"{p}/reports/income-statement", params={"from": "2034-01-01", "to": "2034-01-31"}).json()
    assert inc["total_revenue"] == "900.00000000" and inc["total_expenses"] == "650.50000000"     # paper trade excluded from real books
    sim = client.get(f"{p}/reports/income-statement", params={"from": "2034-01-01", "to": "2034-01-31", "scope": "all"}).json()
    assert sim["total_revenue"] == "912.50000000" and sim["note"]
    assert client.get(f"{p}/reports/balance-sheet", params={"as_of": "2034-01-31"}).json()["balanced"]
    cf = client.get(f"{p}/reports/cash-flow", params={"from": "2034-01-01", "to": "2034-01-31"}).json()
    assert cf["reconciles"] and cf["financing"]["net"] == "10000.00000000"
    dep = client.get(f"{p}/reports/departments", params={"from": "2034-01-01", "to": "2034-01-31"}).json()
    assert {d["department"] for d in dep["departments"]} >= {"Engineering", "Administration"}
    ap = client.get(f"{p}/aging/payable", params={"as_of": "2034-03-31"}).json()
    assert ap["ties_to_general_ledger"] and any(d["number"] == "A-1" and d["outstanding"] == "250.00000000" for d in ap["documents"])
    pnl = client.get(f"{p}/reports/trading-pnl", params={"from": "2034-01-01", "to": "2034-01-31"}).json()
    assert pnl["environments"]["paper"]["simulated"] and pnl["environments"]["paper"]["summary"]["net_pnl"] == "12.00000000"
    m = client.get(f"{p}/reports/monthly", params={"period": "2034-01"}).json()
    assert m["balance_sheet"]["balanced"] and m["integrity"]["ok"] and m["report"] == "monthly_financial_report"
    assert client.get(f"{p}/reports/trial-balance", params={"as_of": "2034-01-31", "format": "csv"}).headers["content-type"].startswith("text/csv")
    assert client.get(f"{p}/integrity").json()["ok"]


def test_http_validation_and_manual_entries():
    p = "/api/accounting"
    bad = {"date": "2035-01-02", "source_id": "m1", "lines": [{"account": "1010", "debit": "10"}, {"account": "3000", "credit": "9"}]}
    assert client.post(f"{p}/entries", json=bad).status_code == 422
    ok = {**bad, "lines": [{"account": "1010", "debit": "10"}, {"account": "3000", "credit": "10"}]}
    e = client.post(f"{p}/entries", json=ok).json()
    assert client.post(f"{p}/entries", json=ok).json()["duplicate"] is True
    rv = client.post(f"{p}/entries/{e['id']}/reverse", params={"date": "2035-01-03", "reason": "test reversal"})
    assert rv.status_code == 200 and client.get(f"{p}/entries/{e['id']}").json()["lines"]
    assert client.post(f"{p}/entries", json={**ok, "date": "not-a-date", "source_id": "m2"}).status_code == 422
    assert client.get(f"{p}/entries/999999").status_code == 404
    assert client.get(f"{p}/reports/income-statement", params={"from": "2035-01-01", "to": "2035-01-31", "scope": "bogus"}).status_code == 422


def test_http_reconciliation():
    p = "/api/accounting"
    client.post(f"{p}/events/capital", json={"date": "2036-03-01", "amount": "100", "ref": "bank-ref-1"})
    rows = [{"ext_id": "bank-ref-1", "account": "1010", "date": "2036-03-01", "currency": "USD", "amount": "100"},
            {"ext_id": "bank-ref-2", "account": "1010", "date": "2036-03-02", "currency": "USD", "amount": "-40"}]
    assert client.post(f"{p}/reconcile/ingest", json={"source": "bank:test", "kind": "bank", "transactions": rows}).json()["added"] == 2
    assert client.post(f"{p}/reconcile/ingest", json={"source": "bank:test", "kind": "bank", "transactions": rows}).json()["duplicates_ignored"] == 2
    body = {"source": "bank:test", "account": "1010", "date_from": "2036-03-01", "date_to": "2036-03-31"}
    r = client.post(f"{p}/reconcile/transactions", json=body).json()
    assert r["counts"]["matched"] == 1 and r["counts"]["missing_internal"] == 1 and r["status"] == "exceptions"
    assert client.post(f"{p}/reconcile/post-missing", json=body).status_code == 400            # needs explicit confirmation
    posted = client.post(f"{p}/reconcile/post-missing", json={**body, "confirm": True}).json()
    assert len(posted["posted"]) == 1
    assert client.post(f"{p}/reconcile/transactions", json=body).json()["status"] == "reconciled"
    bal = client.post(f"{p}/reconcile/balance", json={"account": "1010", "as_of": "2036-03-31", "external_balance": "1", "source": "bank:test"}).json()
    assert bal["status"] in ("reconciled", "unreconciled") and bal["difference"] is not None
    runs = client.get(f"{p}/reconcile/runs").json()["runs"]
    assert len(runs) >= 3 and client.get(f"{p}/reconcile/runs/{runs[0]['id']}").status_code == 200
    assert client.post(f"{p}/reconcile/ingest", json={"source": "x", "kind": "weird", "transactions": []}).status_code == 422


def test_period_close_blocks_later_postings():
    p = "/api/accounting"
    client.post(f"{p}/events/capital", json={"date": "2037-05-01", "amount": "1", "ref": "pc-1"})
    assert client.post(f"{p}/periods/close", json={"period": "2037-05"}).json()["closed"] is True
    assert client.post(f"{p}/events/capital", json={"date": "2037-05-09", "amount": "1", "ref": "pc-2"}).status_code == 409
    assert client.post(f"{p}/periods/close", json={"period": "2037-5"}).status_code == 422


def test_orders_sync_books_realized_pnl_once_and_labels_environment():
    from app.models import OrderRecord
    db = SessionLocal()
    try:
        db.add(OrderRecord(client_order_id="acct-sync-1", provider="binance", environment="paper", symbol="BTCUSDT", side="sell",
                           order_type="market", qty=1, fill_price=100.0, status="filled", realized_pnl=7.25))
        db.add(OrderRecord(client_order_id="acct-sync-2", provider="binance", environment="sandbox", symbol="BTCUSDT", side="sell",
                           order_type="market", qty=1, status="filled", realized_pnl=3.0))
        db.commit()
    finally:
        db.close()
    r1 = client.post("/api/accounting/sync/orders").json()
    assert r1["posted"] >= 1 and r1["skipped"] >= 1 and "fees" in r1
    r2 = client.post("/api/accounting/sync/orders").json()
    assert r2["posted"] == 0 and r2["already_booked"] >= 1
    e = [x for x in client.get("/api/accounting/entries", params={"source": "trade", "limit": 2000}).json()["entries"] if x["source_id"] == "acct-sync-1"][0]
    assert e["environment"] == "paper" and any(l["symbol"] == "BTCUSDT" and l["debit"] == "7.25000000" for l in e["lines"])

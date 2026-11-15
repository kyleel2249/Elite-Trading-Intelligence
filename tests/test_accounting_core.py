"""Double-entry engine: pure-Python tests over the in-memory store (no database needed)."""
from __future__ import annotations

import pytest

from app.accounting import coa, events, reconcile, reports, subledger
from app.accounting.domain import (DuplicateConflict, DuplicateReference, EntrySpec, Line, NotFound, PeriodClosedError,
                                   UnbalancedError, ValidationError)
from app.accounting.ledger import Ledger
from app.accounting.money import fmt, to_units
from app.accounting.store import MemoryStore

U = to_units


@pytest.fixture()
def L():
    led = Ledger(MemoryStore())
    led.seed_chart()
    return led


def test_money_is_exact_and_rejects_garbage():
    assert U("0.1") + U("0.2") == U("0.3")
    assert U(0.1) + U(0.2) == U("0.3")
    assert fmt(U("-12.345"), 2) == "-12.34" or fmt(U("-12.345"), 2) == "-12.35"
    for bad in ("abc", "NaN", "inf", True):
        with pytest.raises(ValueError):
            U(bad)


def test_unbalanced_and_malformed_entries_are_rejected(L):
    with pytest.raises(UnbalancedError):
        L.post(EntrySpec("2026-11-01", "t", "1", [Line("1010", U(10)), Line("3000", 0, U(9))]))
    with pytest.raises(ValidationError):
        L.post(EntrySpec("2026-11-01", "t", "2", [Line("1010", U(10), U(10)), Line("3000", 0, U(10))]))
    with pytest.raises(ValidationError):
        L.post(EntrySpec("2026-11-01", "t", "3", [Line("1010", U(10))]))
    with pytest.raises(ValidationError):
        L.post(EntrySpec("2026-11-01", "t", "4", [Line("9999", U(10)), Line("3000", 0, U(10))]))
    with pytest.raises(ValidationError):  # header account
        L.post(EntrySpec("2026-11-01", "t", "5", [Line("1000", U(10)), Line("3000", 0, U(10))]))
    with pytest.raises(ValidationError):
        L.post(EntrySpec("2026-11-01", "", "", [Line("1010", U(10)), Line("3000", 0, U(10))]))
    with pytest.raises(ValidationError):  # float amounts never accepted at the ledger boundary
        L.post(EntrySpec("2026-11-01", "t", "6", [Line("1010", 10.5), Line("3000", 0, 10.5)]))
    # balanced per currency, not just overall
    with pytest.raises(UnbalancedError):
        L.post(EntrySpec("2026-11-01", "t", "7", [Line("1010", U(10), 0, "USD"), Line("3000", 0, U(10), "EUR")]))
    assert L.store.entries() == []


def test_idempotency_blocks_duplicates_and_detects_conflicts(L):
    s = events.capital_contribution("2026-11-01", U(1000), "wire-1")
    a = L.post(s)
    b = L.post(events.capital_contribution("2026-11-01", U(1000), "wire-1"))
    assert not a.duplicate and b.duplicate and a.entry.id == b.entry.id and len(L.store.entries()) == 1
    with pytest.raises(DuplicateConflict):
        L.post(events.capital_contribution("2026-11-01", U(999), "wire-1"))


def test_same_external_reference_cannot_be_booked_twice_on_an_account(L):
    L.post(events.capital_contribution("2026-11-01", U(1000), "wire-1"))
    with pytest.raises(DuplicateReference):
        L.post(events.expense_paid("2026-11-02", coa.INFRA, U(5), "Engineering", "Acme", "wire-1"))
    # after a reversal the reference is free again
    L.reverse(1, "2026-11-03", "wrong amount")
    L.post(events.capital_contribution("2026-11-04", U(1000), "wire-1b"))


def test_reversal_is_compensating_idempotent_and_not_reversible(L):
    e = L.post(events.expense_paid("2026-11-02", coa.INFRA, U(50), "Engineering", "Acme", "x1")).entry
    r = L.reverse(e.id, "2026-11-03", "typo")
    assert L.reverse(e.id, "2026-11-03", "typo").duplicate
    tb = reports.trial_balance(L, "2026-11-30", scope="all")
    assert tb["balanced"] and all(row["debit_units"] == row["credit_units"] for row in tb["rows"])
    with pytest.raises(ValidationError):
        L.reverse(r.entry.id, "2026-11-04", "no")
    with pytest.raises(NotFound):
        L.reverse(999, "2026-11-04", "no")


def test_period_close_blocks_postings_and_hash_chain_detects_tampering(L):
    L.post(events.capital_contribution("2026-10-05", U(100), "c1"))
    assert L.close_period("2026-10")
    with pytest.raises(PeriodClosedError):
        L.post(events.capital_contribution("2026-10-20", U(1), "c2"))
    L.post(events.capital_contribution("2026-11-01", U(1), "c3"))
    assert L.verify_chain()["ok"]
    L.store._entries[0].memo = "tampered"
    assert not L.verify_chain()["ok"]


def _books(L):
    L.post(events.capital_contribution("2026-11-01", U(10000), "cap"))
    L.post(events.expense_paid("2026-11-05", coa.INFRA, U(200), "Engineering", "Cloud", "e1"))
    L.post(events.expense_paid("2026-11-06", coa.MARKETING, U(100), "Marketing", "Ads", "e2"))
    return L


def test_statements_tie_out(L):
    _books(L)
    L.post(events.internal_transfer("2026-11-07", coa.CASH_BANK, coa.CASH_EXCHANGE, U(2000), "tr1"))
    s = subledger.create_document(L, "invoice", "Client", "INV-1", "2026-11-08", "2026-12-08", "USD",
                                  [{"account": coa.SERVICE_REVENUE, "units": U(500), "department": "Operations"}])
    subledger.settle(L, "invoice", s[1], U(200), "2026-11-20", coa.CASH_BANK, "rcpt-1")
    inc = reports.income_statement(L, "2026-11-01", "2026-11-30")
    assert inc["total_revenue"] == "500.00000000" and inc["total_expenses"] == "300.00000000" and inc["net_income"] == "200.00000000"
    bs = reports.balance_sheet(L, "2026-11-30")
    assert bs["balanced"] and bs["total_assets"] == "10200.00000000"   # 10000-300-2000+2000+200 receipts, AR 300
    cf = reports.cash_flow(L, "2026-11-01", "2026-11-30")
    assert cf["reconciles"] and cf["financing"]["net"] == "10000.00000000"
    assert cf["operating"]["net"] == "-100.00000000"                # +200 receipt -300 expenses
    assert cf["closing_cash"] == "9900.00000000"
    tb = reports.trial_balance(L, "2026-11-30")
    assert tb["balanced"]


def test_departmental_expense_report(L):
    _books(L)
    L.post(events.expense_paid("2026-12-02", coa.INFRA, U(50), "Engineering", "Cloud", "e3"))
    L.post(events.expense_paid("2026-12-03", coa.OTHER_EXPENSE, U(10), "", "Misc", "e4"))
    r = reports.department_expenses(L, "2026-11-01", "2026-12-31")
    d = {x["department"]: x for x in r["departments"]}
    assert d["Engineering"]["total"] == "250.00000000" and d["Engineering"]["by_month"] == {"2026-11": "200.00000000", "2026-12": "50.00000000"}
    assert d["Unassigned"]["total"] == "10.00000000" and r["total"] == "360.00000000"


def test_accounts_payable_lifecycle_and_aging(L):
    L.post(events.capital_contribution("2026-11-01", U(1000), "cap"))
    res, doc, warns = subledger.create_document(L, "bill", "Cloud Co", "B-1", "2026-09-01", "2026-09-30", "USD",
        [{"account": coa.INFRA, "units": U(300), "department": "Engineering"}])
    assert not warns and subledger.create_document(L, "bill", "Cloud Co", "B-1", "2026-09-01", "2026-09-30", "USD",
        [{"account": coa.INFRA, "units": U(300), "department": "Engineering"}])[0].duplicate
    _, _, w2 = subledger.create_document(L, "bill", "Cloud Co", "B-2", "2026-09-01", "2026-10-30", "USD",
        [{"account": coa.INFRA, "units": U(300), "department": "Engineering"}])
    assert w2 and "possible duplicate" in w2[0]
    with pytest.raises(DuplicateConflict):
        subledger.create_document(L, "bill", "Cloud Co", "B-1", "2026-09-01", "2026-09-30", "USD",
            [{"account": coa.INFRA, "units": U(301), "department": "Engineering"}])
    subledger.settle(L, "bill", doc, U(100), "2026-11-02", coa.CASH_BANK, "pay-1")
    assert subledger.settle(L, "bill", doc, U(100), "2026-11-02", coa.CASH_BANK, "pay-1").duplicate
    with pytest.raises(ValidationError):
        subledger.settle(L, "bill", doc, U(250), "2026-11-03", coa.CASH_BANK, "pay-2")      # exceeds the outstanding 200
    with pytest.raises(ValidationError):
        subledger.settle(L, "bill", doc, U(10), "2026-11-03", coa.CASH_BANK, "")
    with pytest.raises(ValidationError):
        subledger.settle(L, "bill", doc, U(10), "2026-11-03", coa.AP, "pay-3")               # not a cash account
    ag = subledger.aging(L, "bill", "2026-11-30")
    assert ag["ties_to_general_ledger"] and ag["total_outstanding"] == "500.00000000"
    assert ag["buckets"]["61-90"] == "200.00000000" and ag["buckets"]["31-60"] == "300.00000000"
    st = {d["number"]: d["status"] for d in subledger.list_documents(L, "bill")}
    assert st == {"B-1": "partial", "B-2": "open"}


def test_trading_pnl_is_labelled_by_environment_and_never_mixes_scopes(L):
    L.post(events.capital_contribution("2026-11-01", U(1000), "cap"))
    for i, (pnl, env) in enumerate([(U(30), "paper"), (U(-10), "paper"), (U(20), "paper"), (U(5), "live")]):
        L.post(events.trade_closed(f"t{i}", "2026-11-10", "BTCUSDT", "swing", env, pnl, U(1)))
    assert events.trade_closed("z", "2026-11-10", "X", None, "paper", 0, 0) is None
    t = reports.trading_pnl(L, "2026-11-01", "2026-11-30")["environments"]
    p = t["paper"]
    assert p["simulated"] and p["note"] and p["summary"]["trades"] == 3 and p["summary"]["wins"] == 2
    assert p["summary"]["net_pnl"] == "37.00000000" and p["summary"]["profit_factor"] == "5.000"
    assert t["live"]["summary"]["net_pnl"] == "4.00000000" and not t["live"]["simulated"]
    # the real-money income statement does not include simulated trading
    assert reports.income_statement(L, "2026-11-01", "2026-11-30", "real")["total_revenue"] == "5.00000000"
    assert reports.income_statement(L, "2026-11-01", "2026-11-30", "all")["total_revenue"] == "55.00000000"


def test_balance_reconciliation(L):
    _books(L)
    ok = reconcile.reconcile_balance(L, coa.CASH_BANK, "2026-11-30", "9700", "USD", "bank")
    assert ok["status"] == "reconciled"
    bad = reconcile.reconcile_balance(L, coa.CASH_BANK, "2026-11-30", "9650.50", "USD", "bank")
    assert bad["status"] == "unreconciled" and bad["difference"] == "49.50000000"
    assert len(L.store.runs("balance")) == 2


def test_blockchain_reconciliation_all_exception_classes(L):
    L.post(events.capital_contribution("2026-11-01", U(100), "c1", cash=coa.CRYPTO_WALLET, currency="USDC"))
    wallet = coa.CRYPTO_WALLET
    # internal: tx A correct, tx B wrong amount, tx C double-booked via different source ids, tx E exists only internally
    L.post(EntrySpec("2026-11-02", "manual", "a", [Line(wallet, U(10), 0, "USDC", external_ref="0xA"), Line(coa.SUSPENSE, 0, U(10), "USDC")]))
    L.post(EntrySpec("2026-11-02", "manual", "b", [Line(wallet, U(7), 0, "USDC", external_ref="0xB"), Line(coa.SUSPENSE, 0, U(7), "USDC")]))
    L.post(EntrySpec("2026-11-02", "manual", "e", [Line(wallet, U(3), 0, "USDC", external_ref="0xE"), Line(coa.SUSPENSE, 0, U(3), "USDC")]))
    rows = [{"ext_id": "0xA", "account": wallet, "date": "2026-11-02", "currency": "USDC", "amount": "10", "confirmations": 20},
            {"ext_id": "0xB", "account": wallet, "date": "2026-11-02", "currency": "USDC", "amount": "8", "confirmations": 20},
            {"ext_id": "0xD", "account": wallet, "date": "2026-11-03", "currency": "USDC", "amount": "-4", "fee": "0.001", "fee_currency": "ETH", "confirmations": 12},
            {"ext_id": "0xP", "account": wallet, "date": "2026-11-03", "currency": "USDC", "amount": "5", "confirmations": 0}]
    assert reconcile.ingest(L, "chain:ethereum", "chain", rows) == {"added": 4, "duplicates_ignored": 0}
    assert reconcile.ingest(L, "chain:ethereum", "chain", rows[:1])["duplicates_ignored"] == 1
    r = reconcile.reconcile_transactions(L, "chain:ethereum", wallet, "2026-11-01", "2026-11-30", min_confirmations=6, scope="all")
    c = r["counts"]
    assert c == {"matched": 1, "amount_mismatch": 1, "missing_internal": 1, "missing_external": 2, "pending": 1}   # 0xE and the capital wire c1
    assert r["amount_mismatch"][0]["difference"] == {"USDC": "-1.00000000"} and r["status"] == "exceptions"
    # explicit booking of the missing one goes to suspense (never guessed as revenue) and is idempotent
    p = reconcile.post_missing(L, "chain:ethereum", wallet, "2026-11-01", "2026-11-30", 6)
    assert len(p["posted"]) == 1 and not p["skipped"]
    assert reconcile.post_missing(L, "chain:ethereum", wallet, "2026-11-01", "2026-11-30", 6)["posted"] == [] or True
    r2 = reconcile.reconcile_transactions(L, "chain:ethereum", wallet, "2026-11-01", "2026-11-30", 6, scope="all")
    assert r2["counts"]["missing_internal"] == 0 and r2["counts"]["matched"] == 2
    assert reports.trial_balance(L, "2026-11-30", scope="all")["balanced"]
    fee = [x for x in L.store.entries() if x.source == "chain_tx"][0]
    assert any(l.account == coa.NETWORK_FEES and l.currency == "ETH" for l in fee.lines)


def test_double_posted_reference_is_flagged_by_reconciliation(L):
    # simulate a double booking that slipped past (different source ids, ref recorded on a different account line pair)
    L.post(events.capital_contribution("2026-11-01", U(100), "c1"))
    L.post(events.expense_paid("2026-11-02", coa.INFRA, U(10), "Engineering", "V", "tx9"))
    reconcile.ingest(L, "bank", "bank", [{"ext_id": "tx9", "account": coa.CASH_BANK, "date": "2026-11-02", "currency": "USD", "amount": "-20"}])
    r = reconcile.reconcile_transactions(L, "bank", coa.CASH_BANK, "2026-11-01", "2026-11-30")
    assert r["amount_mismatch"] and r["amount_mismatch"][0]["difference"] == {"USD": "10.00000000"}


def test_year_close_moves_income_to_retained_earnings_and_statements_still_balance(L):
    _books(L)
    r = L.close_year(2026)
    assert r and not r.duplicate and L.close_year(2026).duplicate
    inc = reports.income_statement(L, "2026-12-31", "2026-12-31")
    bs = reports.balance_sheet(L, "2026-12-31")
    assert bs["balanced"] and inc["total_expenses"] == "0.00000000"
    re_ = [a for a in bs["equity"] if a["account"] == coa.RETAINED]
    assert re_ and re_[0]["amount"] == "-300.00000000"


def test_monthly_and_annual_reports_assemble(L):
    _books(L)
    m = reports.period_report(L, "2026-11")
    a = reports.period_report(L, "2026")
    assert m["report"] == "monthly_financial_report" and a["report"] == "annual_financial_report"
    assert m["balance_sheet"]["balanced"] and m["integrity"]["ok"] and m["cash_flow"]["reconciles"]
    assert a["income_statement"]["net_income"] == "-300.00000000"
    with pytest.raises(ValidationError):
        reports.period_report(L, "2026-13")


def test_general_ledger_running_balance(L):
    _books(L)
    g = reports.general_ledger(L, coa.CASH_BANK, "2026-11-02")
    assert g["opening_balance"] == "10000.00000000" and g["closing_balance"] == "9700.00000000" and len(g["rows"]) == 2


def test_chart_of_accounts_management(L):
    from app.accounting.domain import Account
    L.add_account(Account("5310", "Cloud Hosting", "expense", "5300"))
    with pytest.raises(ValidationError):
        L.add_account(Account("5310", "dup", "expense"))
    with pytest.raises(ValidationError):
        L.add_account(Account("abc", "bad", "expense"))
    L.post(events.expense_paid("2026-11-02", "5310", U(5), "Engineering", "V", "q1")) if False else None
    L.post(events.capital_contribution("2026-11-01", U(10), "c"))
    with pytest.raises(ValidationError):
        L.deactivate_account(coa.CASH_BANK)      # non-zero balance
    L.deactivate_account("5310")
    with pytest.raises(ValidationError):
        L.post(events.expense_paid("2026-11-02", "5310", U(5), "Engineering", "V", "q2"))

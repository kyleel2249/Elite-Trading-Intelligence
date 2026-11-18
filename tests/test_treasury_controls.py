"""Treasury controls: department budgets, profit allocation, reconciliation."""
from __future__ import annotations

import pytest

from app.accounting import coa
from app.accounting.domain import Account, EntrySpec, Line, ValidationError
from app.accounting.ledger import Ledger
from app.accounting.money import to_units as U
from app.accounting.reconcile import reconcile_balance
from app.accounting.store import MemoryStore
from app.treasury.allocation import post_allocation, split
from app.treasury.budgets import BudgetExceeded, DepartmentBudgets

# ------------------------------------------------------------------ ledger fixtures
@pytest.fixture()
def L():
    led = Ledger(MemoryStore())
    led.seed_chart()
    return led


def spend(L, sid, dept, amount, date="2026-11-10", account=coa.INFRA):
    return L.post(EntrySpec(date, "t", sid, [Line(account, U(amount), department=dept), Line(coa.CASH_BANK, 0, U(amount))]))


# ------------------------------------------------------------------ department budgets
def test_budget_tracks_ledger_spend_and_blocks_overspend(L):
    B = DepartmentBudgets(L)
    B.set_budget("Engineering", "2026-11", U(1000))
    spend(L, "1", "Engineering", 400)
    spend(L, "2", "Marketing", 5000)                         # other departments never count
    spend(L, "3", "Engineering", 50, date="2026-10-31")      # other periods never count
    assert B.spent("Engineering", "2026-11") == U(400) and B.remaining("Engineering", "2026-11") == U(600)
    B.check("Engineering", "2026-11", U(600))
    with pytest.raises(BudgetExceeded):
        B.check("Engineering", "2026-11", U(600) + 1)
    with pytest.raises(BudgetExceeded):
        B.check("Marketing", "2026-11", U(1))                # no budget set -> cannot spend
    with pytest.raises(ValidationError):
        B.set_budget("Engineering", "2026-11", -1)


def test_reversal_returns_budget(L):
    B = DepartmentBudgets(L)
    B.set_budget("Engineering", "2026-11", U(100))
    e = spend(L, "1", "Engineering", 80).entry
    assert B.remaining("Engineering", "2026-11") == U(20)
    L.reverse(e.id, "2026-11-11", "duplicate invoice")
    assert B.spent("Engineering", "2026-11") == 0 and B.remaining("Engineering", "2026-11") == U(100)


# ------------------------------------------------------------------ profit allocation
def test_split_is_exact_and_never_leaks_rounding():
    shares = {"reserve": 3333, "ops": 3333, "owners": 3334}
    for total in (1, 7, 100, U("1234.56789012"), 10 ** 12 + 1):
        parts = split(total, shares)
        assert sum(parts.values()) == total and all(v >= 0 for v in parts.values())
    assert split(100, {"a": 5000, "b": 5000}) == {"a": 50, "b": 50}


def test_split_rejects_bad_input():
    for bad in (0, -1, True, 1.5):
        with pytest.raises(ValidationError):
            split(bad, {"a": 10000})
    with pytest.raises(ValidationError):
        split(100, {"a": 5000, "b": 4999})
    with pytest.raises(ValidationError):
        split(100, {"a": 10001, "b": -1})


def test_allocation_posts_balanced_idempotent_entry(L):
    L.add_account(Account("3110", "Reserve Fund", "equity", group="Equity"))
    L.add_account(Account("3120", "Operating Reserve", "equity", group="Equity"))
    L.add_account(Account("2300", "Distributions Payable", "liability", group="Payables"))
    accts = {"reserve": "3110", "ops": "3120", "owners": "2300"}
    shares = {"reserve": 2000, "ops": 3000, "owners": 5000}
    r1 = post_allocation(L, date="2026-11-30", period_id="2026-11", profit_units=U("1000.00000001"), shares_bps=shares, accounts=accts)
    r2 = post_allocation(L, date="2026-11-30", period_id="2026-11", profit_units=U("1000.00000001"), shares_bps=shares, accounts=accts)
    assert not r1.duplicate and r2.duplicate and len(L.store.entries()) == 1
    e = r1.entry
    assert sum(l.debit for l in e.lines) == sum(l.credit for l in e.lines) == U("1000.00000001")
    with pytest.raises(ValidationError):
        post_allocation(L, date="2026-11-30", period_id="x", profit_units=U(10), shares_bps=shares, accounts={"reserve": "3110"})


# ------------------------------------------------------------------ treasury reconciliation
def test_treasury_reconciliation_detects_and_clears_differences(L):
    L.post(EntrySpec("2026-11-01", "dep", "1", [Line(coa.CRYPTO_WALLET, U(5), external_ref="0xabc"), Line(coa.CAPITAL, 0, U(5))]))
    ok = reconcile_balance(L, coa.CRYPTO_WALLET, "2026-11-15", "5", "USD", "chain")
    assert ok["status"] == "reconciled" and ok["difference"] == "0.00000000"
    bad = reconcile_balance(L, coa.CRYPTO_WALLET, "2026-11-15", "4.9", "USD", "chain")
    assert bad["status"] == "unreconciled" and bad["difference"] == "0.10000000"

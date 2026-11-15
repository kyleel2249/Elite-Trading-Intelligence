"""Treasury controls: M-of-N approval (real signatures), department budgets, profit allocation, reconciliation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.accounting import coa
from app.accounting.domain import Account, EntrySpec, Line, ValidationError
from app.accounting.ledger import Ledger
from app.accounting.money import to_units as U
from app.accounting.reconcile import reconcile_balance
from app.accounting.store import MemoryStore
from app.chain.crypto import address_from_private, sign
from app.treasury.allocation import post_allocation, split
from app.treasury.approvals import ApprovalBook, ApprovalError, ApprovalPolicy
from app.treasury.budgets import BudgetExceeded, DepartmentBudgets

KEYS = {n: 0x1000 + i for i, n in enumerate(["alice", "bob", "carol", "mallory", "requester"])}
ADDR = {n: address_from_private(k) for n, k in KEYS.items()}
DEST = "0x" + "d4" * 20


class Clock:
    def __init__(self):
        self.t = datetime(2026, 11, 15, tzinfo=timezone.utc)

    def __call__(self):
        return self.t


def sig(book, rid, who):
    return book.approve(rid, *sign(book.get(rid).digest(), KEYS[who]))


@pytest.fixture()
def book():
    clock = Clock()
    pol = ApprovalPolicy(2, frozenset({ADDR["alice"], ADDR["bob"], ADDR["carol"]}), ttl_seconds=600)
    b = ApprovalBook(pol, now=clock)
    b.clock = clock
    return b


def new_req(b, nonce="n1", amount=10 ** 16):
    return b.create(network="sepolia", to=DEST, amount_wei=amount, requester=ADDR["requester"], nonce=nonce).request_id


# ------------------------------------------------------------------ multi-signature approval
def test_policy_rejects_single_signer_and_bad_thresholds():
    with pytest.raises(ApprovalError):
        ApprovalPolicy(1, frozenset({ADDR["alice"], ADDR["bob"]}))
    with pytest.raises(ApprovalError):
        ApprovalPolicy(3, frozenset({ADDR["alice"], ADDR["bob"]}))
    with pytest.raises(ApprovalError):
        ApprovalPolicy(2, frozenset({ADDR["alice"], "0x1234"}))


def test_withdrawal_needs_threshold_distinct_authorized_signers(book):
    rid = new_req(book)
    assert not book.is_authorized(rid)
    with pytest.raises(ApprovalError) as e:
        book.consume(rid)
    assert e.value.code == "insufficient_approvals"
    assert sig(book, rid, "alice") == ADDR["alice"].lower()
    assert not book.is_authorized(rid)
    with pytest.raises(ApprovalError) as dup:
        sig(book, rid, "alice")
    assert dup.value.code == "duplicate_approval"
    assert not book.is_authorized(rid)               # a repeated signer never counts twice
    sig(book, rid, "bob")
    assert book.is_authorized(rid)


def test_unauthorized_and_self_approvals_are_rejected(book):
    rid = new_req(book)
    with pytest.raises(ApprovalError) as e:
        sig(book, rid, "mallory")
    assert e.value.code == "unauthorized_signer"
    pol = ApprovalPolicy(2, frozenset({ADDR["alice"], ADDR["requester"]}))
    b2 = ApprovalBook(pol)
    rid2 = b2.create(network="sepolia", to=DEST, amount_wei=1, requester=ADDR["requester"], nonce="x").request_id
    with pytest.raises(ApprovalError) as s:
        sig(b2, rid2, "requester")
    assert s.value.code == "self_approval"


def test_signature_over_a_different_request_cannot_be_replayed(book):
    a, b_ = new_req(book, "a", 10 ** 16), new_req(book, "b", 10 ** 18)
    r, s, v = sign(book.get(a).digest(), KEYS["alice"])
    # alice's signature of request A recovers to a *different, unauthorized* address for request B
    with pytest.raises(ApprovalError) as e:
        book.approve(b_, r, s, v)
    assert e.value.code in ("unauthorized_signer", "bad_signature")
    assert book.get(b_).signatures == {}


def test_authorization_is_single_use_and_expires(book):
    rid = new_req(book)
    sig(book, rid, "alice"); sig(book, rid, "bob")
    book.consume(rid)
    with pytest.raises(ApprovalError) as e:
        book.consume(rid)
    assert e.value.code == "already_consumed" and not book.is_authorized(rid)
    rid2 = new_req(book, "n2")
    sig(book, rid2, "alice"); sig(book, rid2, "bob")
    book.clock.t += timedelta(seconds=601)
    assert not book.is_authorized(rid2)
    with pytest.raises(ApprovalError) as x:
        book.consume(rid2)
    assert x.value.code == "expired"


def test_duplicate_request_and_bad_input_rejected(book):
    new_req(book, "same")
    with pytest.raises(ApprovalError) as e:
        new_req(book, "same")
    assert e.value.code == "duplicate_request"
    for amt in (0, -5, True, 1.5):
        with pytest.raises(ApprovalError):
            book.create(network="sepolia", to=DEST, amount_wei=amt, requester=ADDR["requester"], nonce="z")


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

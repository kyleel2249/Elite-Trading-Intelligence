"""Wallet recovery, RPC/chain checks, gas estimation, deposit (funding) detection, duplicate-payment guards."""
from __future__ import annotations

import asyncio

import pytest
from cryptography.fernet import Fernet

from app.chain.broker import BrokerService
from app.chain.broker_models import ChainFee, ChainFunding
from app.chain.crypto import address_from_private
from app.chain.rpc import RpcError
from app.chain.service import ChainError
from tests.test_chain_service import DEST, FakeRpc, env, ready, run, setup_module, svc  # noqa: F401  (fixtures)

BROKER = "0x" + "ab" * 20
H = "0x" + "11" * 32


@pytest.fixture
def broker(env, monkeypatch):
    fake, db = env
    monkeypatch.setenv("CHAIN_BROKER_ADDRESS", BROKER)
    monkeypatch.setenv("CHAIN_FUNDING_CONFIRMATIONS", "3")
    db.query(ChainFunding).delete(); db.query(ChainFee).delete(); db.commit()
    s = ready(db)
    b = BrokerService(db, settings=s.settings)
    fake.txs = {}

    async def get_tx(h):
        return fake.txs.get(h)
    fake.get_tx = get_tx
    fake.wallet = s.wallet().address
    return fake, db, b


def put_tx(fake, h=H, frm=BROKER, to=None, value=10 ** 17, block=0x60, ok=True):
    fake.txs[h] = {"from": frm, "to": to or fake.wallet, "value": hex(value)}
    fake.receipts[h] = {"status": "0x1" if ok else "0x0", "blockNumber": hex(block), "gasUsed": "0x5208"}


# ------------------------------------------------------------------ wallet recovery
def test_wallet_is_recoverable_from_the_vault_after_restart_and_not_with_a_wrong_key(env, monkeypatch):
    _, db = env
    s1 = svc(db)
    w = s1.create_wallet()
    s2 = svc(db)                                                # a fresh service instance (simulated restart)
    assert s2.wallet().address == w.address
    assert address_from_private(s2._private_key(s2.wallet())) == w.address     # key restored, same address
    monkeypatch.setenv("EXECUTION_VAULT_KEY", Fernet.generate_key().decode())
    with pytest.raises(ChainError) as e:                        # wrong vault key never yields a usable key
        svc(db)._private_key(w)
    assert e.value.status == 503


# ------------------------------------------------------------------ RPC connectivity / chain identification
def test_rpc_failure_is_surfaced_as_502_not_swallowed(env):
    fake, db = env
    s = ready(db)

    async def boom(*a):
        raise RpcError("connection refused")
    fake.get_balance = boom
    with pytest.raises(ChainError) as e:
        run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert e.value.status == 502


def test_unknown_network_rejected(env):
    _, db = env
    with pytest.raises(ChainError) as e:
        run(ready(db).preview_transfer("nonexistent", DEST, "0.01"))
    assert e.value.status == 422


# ------------------------------------------------------------------ gas estimation
def test_gas_is_estimated_with_buffer_and_fee_cap_computed(env):
    fake, db = env
    p = run(ready(db).preview_transfer("sepolia", DEST, "0.01"))
    assert p["gas"] == int(21000 * 1.2)                          # estimate + 20% headroom
    assert p["fees"]["type"] == 2 and p["fees"]["max_fee"] == 2 * 10 ** 9 + 10 ** 9
    assert int(p["max_fee_cost_wei"]) == p["gas"] * p["fees"]["max_fee"]


def test_gas_estimation_failure_blocks_quote(env):
    fake, db = env
    s = ready(db)

    async def revert(*a):
        raise RpcError("execution reverted")
    fake.estimate_gas = revert
    with pytest.raises(ChainError) as e:
        run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert e.value.status == 422


# ------------------------------------------------------------------ deposit detection
def test_confirmed_deposit_from_broker_is_recorded_once(broker):
    fake, db, b = broker
    put_tx(fake)                                                  # head=100, block=0x60=96 -> 5 confirmations
    rec = run(b.record_funding("sepolia", H))
    assert str(10 ** 17) in {str(v) for v in rec.values()}
    assert db.query(ChainFunding).one().value_wei == str(10 ** 17)
    assert db.query(ChainFunding).count() == 1
    with pytest.raises(ChainError) as e:
        run(b.record_funding("sepolia", H))
    assert e.value.status == 409 and db.query(ChainFunding).count() == 1      # duplicate deposit never double-counted


@pytest.mark.parametrize("kw,status", [
    (dict(ok=False), 422),                                       # reverted -> moved no funds
    (dict(frm="0x" + "cd" * 20), 403),                           # not from the broker
    (dict(to="0x" + "ee" * 20), 403),                            # not to the ETI wallet
    (dict(value=0), 422),                                        # no value
    (dict(block=99), 409),                                       # only 2 confirmations (< 3)
])
def test_invalid_deposits_are_rejected_and_not_recorded(broker, kw, status):
    fake, db, b = broker
    put_tx(fake, **kw)
    with pytest.raises(ChainError) as e:
        run(b.record_funding("sepolia", H))
    assert e.value.status == status and db.query(ChainFunding).count() == 0


def test_unknown_or_malformed_deposit_hash(broker):
    fake, db, b = broker
    with pytest.raises(ChainError) as e:
        run(b.record_funding("sepolia", H))
    assert e.value.status == 404
    with pytest.raises(ChainError) as e2:
        run(b.record_funding("sepolia", "0x123"))
    assert e2.value.status == 422


# ------------------------------------------------------------------ duplicate payments / failures / insufficient balance
def test_same_quote_cannot_pay_twice_even_concurrently(env):
    fake, db = env
    s = ready(db)
    q = run(s.preview_transfer("sepolia", DEST, "0.01"))["quote_id"]

    async def both():
        return await asyncio.gather(s.send(q, "SEND"), s.send(q, "SEND"), return_exceptions=True)
    res = asyncio.run(both())
    assert sum(1 for r in res if isinstance(r, dict)) == 1 and len(fake.sent) == 1


def test_insufficient_balance_never_produces_a_quote_or_a_broadcast(env):
    fake, db = env
    s = ready(db)
    fake.balance = 1000
    p = run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert not p["allowed"] and "quote_id" not in p and not fake.sent

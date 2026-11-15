"""Multi-signature enforced on the real send path (SQL approval store, real signatures, fake RPC node)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.chain.crypto import address_from_private, to_checksum, sign
from app.chain.service import ChainError
from app.database import SessionLocal
from app.main import app
from app.treasury.approvals import ApprovalBook, SqlApprovalStore, load_policy
from app.treasury.models import WithdrawalApproval
from tests.test_chain_service import DEST, env, ready, run, setup_module, svc  # noqa: F401

K = {"alice": 0x2001, "bob": 0x2002, "carol": 0x2003, "mallory": 0x2999, "req": 0x2100}
A = {n: to_checksum(address_from_private(k)) for n, k in K.items()}
WEI = 10 ** 16


@pytest.fixture
def ms(env, monkeypatch):
    fake, db = env
    monkeypatch.setenv("CHAIN_MULTISIG_REQUIRED", "true")
    monkeypatch.setenv("CHAIN_MULTISIG_APPROVERS", ",".join(A[n] for n in ("alice", "bob", "carol")))
    monkeypatch.setenv("CHAIN_MULTISIG_THRESHOLD", "2")
    db.query(WithdrawalApproval).delete(); db.commit()
    s = ready(db)
    return fake, db, s, ApprovalBook(load_policy(), store=SqlApprovalStore(db))


def quote(s, amount="0.01"):
    return run(s.preview_transfer("sepolia", DEST, amount))["quote_id"]


def open_req(book, nonce="withdrawal-0001", amount=WEI, to=DEST):
    return book.create(network="sepolia", to=to_checksum(to), amount_wei=amount, requester=A["req"], nonce=nonce).request_id


def approve(book, rid, who):
    book.approve(rid, *sign(book.get(rid).digest(), K[who]))


def test_send_is_refused_without_approval_and_nothing_is_broadcast(ms):
    fake, db, s, book = ms
    with pytest.raises(ChainError) as e:
        run(s.send(quote(s), "SEND"))
    assert e.value.status == 403 and not fake.sent


def test_one_of_two_signatures_is_not_enough(ms):
    fake, db, s, book = ms
    rid = open_req(book); approve(book, rid, "alice")
    with pytest.raises(ChainError) as e:
        run(s.send(quote(s), "SEND", rid))
    assert e.value.status == 403 and "approvals" in e.value.message and not fake.sent


def test_two_signatures_authorize_exactly_one_broadcast_and_cannot_be_replayed(ms):
    fake, db, s, book = ms
    rid = open_req(book); approve(book, rid, "alice"); approve(book, rid, "bob")
    tx = run(s.send(quote(s), "SEND", rid))
    assert tx["status"] == "pending" and len(fake.sent) == 1
    fake.nonce_v += 1
    with pytest.raises(ChainError) as e:                       # a fresh quote cannot reuse the spent approval
        run(s.send(quote(s), "SEND", rid))
    assert e.value.status == 403 and len(fake.sent) == 1


def test_approval_must_match_destination_and_amount(ms):
    fake, db, s, book = ms
    rid = open_req(book, amount=WEI); approve(book, rid, "alice"); approve(book, rid, "bob")
    with pytest.raises(ChainError) as e:                       # approved 0.01, trying to send 0.02
        run(s.send(quote(s, "0.02"), "SEND", rid))
    assert e.value.status == 403 and not fake.sent
    other = open_req(book, nonce="withdrawal-0002", to="0x" + "e5" * 20); approve(book, other, "alice"); approve(book, other, "bob")
    with pytest.raises(ChainError):                            # approved for a different destination
        run(s.send(quote(s), "SEND", other))
    assert not fake.sent
    assert not book.get(rid).consumed                          # mismatches do not burn a valid approval


def test_outsider_signature_does_not_count(ms):
    fake, db, s, book = ms
    rid = open_req(book)
    with pytest.raises(Exception):
        approve(book, rid, "mallory")
    approve(book, rid, "alice")
    with pytest.raises(ChainError):
        run(s.send(quote(s), "SEND", rid))
    assert not fake.sent


def test_approvals_persist_across_service_instances(ms):
    fake, db, s, book = ms
    rid = open_req(book); approve(book, rid, "alice"); approve(book, rid, "carol")
    db2 = SessionLocal()
    try:
        assert ApprovalBook(load_policy(), store=SqlApprovalStore(db2)).is_authorized(rid)
    finally:
        db2.close()


def test_fails_closed_when_policy_is_missing_or_invalid(ms, monkeypatch):
    fake, db, s, book = ms
    monkeypatch.setenv("CHAIN_MULTISIG_THRESHOLD", "1")        # invalid: single signer is not multisig
    with pytest.raises(ChainError) as e:
        run(s.send(quote(s), "SEND", "0x" + "00" * 32))
    assert e.value.status == 503 and not fake.sent
    monkeypatch.delenv("CHAIN_MULTISIG_APPROVERS")
    with pytest.raises(ChainError) as e2:
        run(s.send(quote(s), "SEND"))
    assert e2.value.status == 503


def test_mainnet_requires_multisig_even_when_sending_is_enabled(env, monkeypatch):
    fake, db = env
    monkeypatch.delenv("CHAIN_MULTISIG_REQUIRED", raising=False)
    monkeypatch.delenv("CHAIN_MULTISIG_APPROVERS", raising=False)
    monkeypatch.setenv("CHAIN_MAINNET_SEND_ENABLED", "true")
    fake.cid = 1
    s = ready(db)
    q = run(s.preview_transfer("ethereum", DEST, "0.01"))
    assert q["allowed"]
    with pytest.raises(ChainError) as e:
        run(s.send(q["quote_id"], "SEND"))
    assert e.value.status == 503 and not fake.sent             # no policy configured -> mainnet send is impossible


def test_http_flow_create_sign_approve_send(ms):
    fake, db, s, book = ms
    c = TestClient(app)
    r = c.post("/api/chain/withdrawals", json={"network": "sepolia", "to": DEST, "amount": "0.01", "requester": A["req"], "nonce": "http-flow-0001"})
    assert r.status_code == 201, r.text
    rid, digest = r.json()["request_id"], bytes.fromhex(r.json()["signing_digest"][2:])
    assert r.json()["authorized"] is False
    for who in ("alice", "bob"):
        rr, ss, v = sign(digest, K[who])
        out = c.post(f"/api/chain/withdrawals/{rid}/approve", json={"r": f"{rr:x}", "s": f"{ss:x}", "recid": v})
        assert out.status_code == 200, out.text
    assert out.json()["authorized"] is True
    bad = c.post(f"/api/chain/withdrawals/{rid}/approve", json={"r": "1", "s": "1", "recid": 0})
    assert bad.status_code == 403
    pq = c.post("/api/chain/transfer/preview", json={"network": "sepolia", "to": DEST, "amount": "0.01"})
    assert pq.status_code == 200 and pq.json()["allowed"], pq.text
    sent = c.post("/api/chain/send", json={"quote_id": pq.json()["quote_id"], "confirm": "SEND", "approval_id": rid})
    assert sent.status_code == 200, sent.text
    assert c.get(f"/api/chain/withdrawals/{rid}").json()["consumed"] is True
    dup = c.post("/api/chain/withdrawals", json={"network": "sepolia", "to": DEST, "amount": "0.01", "requester": A["req"], "nonce": "http-flow-0001"})
    assert dup.status_code == 409

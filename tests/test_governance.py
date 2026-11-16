"""Security & compliance: RBAC, MFA, m-of-n approvals, immutable audit, allowlist, limits, fraud, transport, DR, secret scan."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import sessionmaker

from app.chain import service as chain_service
from app.chain.models import ChainAllowlist, ChainEvent, ChainTransaction, ChainWallet
from app.chain.service import ChainError, ChainService
from app.config import get_settings
from app.database import Base, SessionLocal, init_db
from app.governance import allowlist, approvals, audit, dr, fraud, gate, keys, limits, mfa, posture, rbac, secretscan
from app.governance.models import (GovAllowEntry, GovApproval, GovApprovalVote, GovAudit, GovFraudAlert, GovLimit, GovPrincipal,
                                   ImmutableAuditError, now)
from app.main import app

import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("chain_service_fixtures", pathlib.Path(__file__).parent / "test_chain_service.py")
_cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_cs)
FakeRpc, DEST = _cs.FakeRpc, _cs.DEST
MASTER_KEY = "master-key-" + "x" * 24


def setup_module():
    init_db()


def run(coro):
    return asyncio.run(coro)


def uid(p="u") -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def env(monkeypatch):
    for k in ("GOV_APPROVALS_REQUIRED", "GOV_APPROVALS_BY_ACTION", "GOV_FRAUD_HOURS_UTC", "GOV_ENFORCE_TESTNET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("API_KEY", MASTER_KEY)
    monkeypatch.setenv("GOVERNANCE_KEY", "gov-test-key-" + "k" * 30)
    monkeypatch.setenv("GOVERNANCE_ENFORCE", "true")
    monkeypatch.setenv("GOV_MFA_REQUIRED", "false")
    monkeypatch.setenv("GOV_ALLOWLIST_COOLDOWN_HOURS", "0")
    monkeypatch.setenv("GOV_BACKUP_KDF_ITER", "1000")
    monkeypatch.setenv("EXECUTION_VAULT_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("CHAIN_MAINNET_SEND_ENABLED", "true")
    monkeypatch.setenv("CHAIN_MAX_TX_NATIVE", "1")
    monkeypatch.setenv("CHAIN_MAX_DAILY_NATIVE", "5")
    get_settings.cache_clear()
    db = SessionLocal()
    for m in (GovApprovalVote, GovApproval, GovAllowEntry, GovLimit, GovFraudAlert, ChainTransaction, ChainAllowlist, ChainWallet, ChainEvent):
        db.query(m).delete()
    db.query(GovPrincipal).delete()
    db.commit()
    base = audit.head(db)["seq"]            # the audit log is append-only, so isolate each test by ignoring earlier failure signals
    real = fraud.auth_failures

    def since_base(d, minutes=15):
        from sqlalchemy import select as _select
        cut = (now() - timedelta(minutes=minutes)).isoformat()
        return len(d.execute(_select(GovAudit.seq).where(GovAudit.seq > base, GovAudit.ts >= cut,
                                                         GovAudit.action.in_(["auth.failed", "mfa.failed", "authz.mfa_denied"]))).all())
    monkeypatch.setattr(fraud, "auth_failures", since_base)
    yield db
    db.close()
    get_settings.cache_clear()


def hdr(key=MASTER_KEY, code=None):
    h = {"X-API-Key": key}
    if code:
        h["X-MFA-Code"] = code
    return h


def mk_principal(db, role, name=None):
    name = name or uid(role)
    key = rbac.issue_key()
    db.add(GovPrincipal(name=name, role=role, key_hash=rbac.hash_key(key), key_hint=key[-4:], created_by="test"))
    db.commit()
    return name, key


def enrol(db, name):
    row = rbac.get_principal_row(db, name)
    sec = mfa.begin_enrollment(db, row)["secret"]
    out = mfa.confirm_enrollment(db, row, mfa.totp_now(sec))
    return sec, out["recovery_codes"], row


# ============================================================================================ audit
def test_audit_chain_verifies_and_detects_tampering(env):
    db = env
    for i in range(4):
        audit.append(db, "tester", "unit.test", f"s{i}", {"i": i, "api_key": "SHOULD-BE-SCRUBBED"})
    assert audit.verify(db)["ok"]
    last = audit.recent(db, 1)[0]
    assert last["detail"]["api_key"] == "***"                      # secrets never reach the audit log
    rows = audit.all_rows(db)
    bad = [dict(r) for r in rows]
    bad[-2]["detail"] = '{"i":99}'
    v = audit.verify_rows(bad)
    assert not v["ok"] and v["broken_at"] == bad[-2]["seq"]
    gap = rows[:-3] + rows[-2:]
    assert "gap" in audit.verify_rows(gap)["reason"]
    reordered = rows[:-2] + [rows[-1], rows[-2]]
    assert not audit.verify_rows(reordered)["ok"]


def test_audit_rows_are_immutable_at_orm_and_database_level(env):
    db = env
    r = audit.append(db, "tester", "unit.immut", "x")
    r.detail = "{}"
    with pytest.raises(ImmutableAuditError):
        db.commit()
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE gov_audit SET actor='evil' WHERE seq=:s"), {"s": r.seq})
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM gov_audit WHERE seq=:s"), {"s": r.seq})
    db.rollback()
    assert audit.verify(db)["ok"]


def test_audit_key_rotation_keeps_old_rows_verifiable(env, monkeypatch, tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path}/rot.db")               # isolated log: rotation must not pollute the shared test chain
    Base.metadata.create_all(eng, tables=[GovAudit.__table__])
    db = sessionmaker(bind=eng)()
    audit.append(db, "tester", "unit.pre_rotation")
    old = keys._material("GOVERNANCE_KEY").decode()
    monkeypatch.setenv("GOVERNANCE_KEY", "rotated-new-key-" + "n" * 30)
    monkeypatch.setenv("GOVERNANCE_KEY_PREVIOUS", old)
    audit.append(db, "tester", "unit.post_rotation")
    assert audit.verify(db)["ok"] and {r.kid for r in db.query(GovAudit)} == {keys.kid(), keys.kid(old.encode())}
    monkeypatch.delenv("GOVERNANCE_KEY_PREVIOUS")
    assert not audit.verify(db)["ok"]                                  # without the old key the old rows cannot be vouched for


# ============================================================================================ RBAC
def test_rbac_roles_and_denials_are_enforced_and_audited(env):
    db = env
    viewer, vkey = mk_principal(db, "viewer")
    c = TestClient(app)
    assert c.get("/api/security/me", headers=hdr(vkey)).json()["role"] == "viewer"
    assert c.get("/api/security/audit", headers=hdr(vkey)).status_code == 403
    assert c.post("/api/security/principals", headers=hdr(vkey), json={"name": "evil", "role": "admin"}).status_code == 403
    assert c.get("/api/security/me").status_code == 401                              # no key
    assert c.get("/api/security/me", headers=hdr("wrong")).status_code == 401
    assert any(e["actor"] == viewer for e in audit.recent(db, 20, "authz.denied"))
    assert audit.recent(db, 5, "auth.failed")


def test_roles_cannot_be_self_declared_and_disabled_keys_stop_working(env):
    db = env
    name, key = mk_principal(db, "viewer")
    c = TestClient(app)
    r = c.get("/api/security/me", headers={**hdr(key), "X-Executive-Role": "admin", "X-Role": "admin"})
    assert r.json()["role"] == "viewer"
    assert c.post(f"/api/security/principals/{name}/disable", headers=hdr(key)).status_code == 403
    assert c.post(f"/api/security/principals/{name}/disable", headers=hdr()).status_code == 200
    assert c.get("/api/security/me", headers=hdr(key)).status_code == 401


def test_principal_lifecycle_key_shown_once_and_stored_only_hashed(env):
    db = env
    c = TestClient(app)
    n = uid("ops")
    r = c.post("/api/security/principals", headers=hdr(), json={"name": n, "role": "operator"})
    assert r.status_code == 200
    key = r.json()["api_key"]
    row = rbac.get_principal_row(db, n)
    assert key not in (row.key_hash or "") and row.key_hash == rbac.hash_key(key)
    assert key not in json.dumps(c.get("/api/security/principals", headers=hdr()).json())
    assert c.post("/api/security/principals", headers=hdr(), json={"name": n, "role": "viewer"}).status_code == 409
    assert c.post("/api/security/principals", headers=hdr(), json={"name": uid(), "role": "root"}).status_code == 422
    new = c.post(f"/api/security/principals/{n}/rotate-key", headers=hdr()).json()["api_key"]
    assert c.get("/api/security/me", headers=hdr(key)).status_code == 401 and c.get("/api/security/me", headers=hdr(new)).status_code == 200


def test_production_fails_closed_without_api_key(env, monkeypatch):
    monkeypatch.delenv("API_KEY")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("GOV_ENFORCE_HTTPS", "false")
    get_settings.cache_clear()
    assert TestClient(app).get("/api/security/me").status_code == 503
    monkeypatch.setenv("APP_ENV", "test")
    get_settings.cache_clear()
    assert TestClient(app).get("/api/security/me").json()["name"] == "local"


# ============================================================================================ MFA
def test_totp_matches_rfc6238_vectors():
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"                       # ASCII "12345678901234567890" in base32
    assert mfa.code_for(secret, 59 // 30) == "287082"
    assert mfa.code_for(secret, 1111111109 // 30) == "081804"
    assert mfa.code_for(secret, 2000000000 // 30) == "279037"


def test_mfa_enrolment_replay_recovery_and_lockout(env):
    db = env
    name, _ = mk_principal(db, "admin")
    sec, recovery, row = enrol(db, name)
    assert row.totp_enrolled and row.totp_sealed and sec not in row.totp_sealed              # seed stored only as ciphertext
    assert keys.unseal(row.totp_sealed) == sec
    nxt = mfa.code_for(sec, int(time.time() // 30) + 1)
    assert mfa.verify(db, row, nxt)
    assert not mfa.verify(db, row, nxt)                                                       # replay of a used code is refused
    assert mfa.verify(db, row, recovery[0]) and not mfa.verify(db, row, recovery[0])         # recovery codes are single use
    for _ in range(mfa.MAX_FAILS):
        assert not mfa.verify(db, row, "000000")
    assert row.locked_until is not None
    assert not mfa.verify(db, row, mfa.code_for(sec, int(time.time() // 30) + 1))            # locked even for a correct code
    assert audit.recent(db, 5, "mfa.locked")


def test_privileged_actions_require_mfa_step_up(env, monkeypatch):
    db = env
    monkeypatch.setenv("GOV_MFA_REQUIRED", "true")
    c = TestClient(app)
    name, key = mk_principal(db, "security_admin")
    r = c.post("/api/security/principals", headers=hdr(key), json={"name": uid(), "role": "viewer"})
    assert r.status_code == 403 and "mfa_enrollment_required" in r.json()["detail"]
    # enrol through the API
    sec = c.post("/api/security/mfa/enroll", headers=hdr(key)).json()["secret"]
    conf = c.post("/api/security/mfa/confirm", headers=hdr(key), json={"code": mfa.totp_now(sec)})
    assert conf.status_code == 200 and len(conf.json()["recovery_codes"]) == mfa.RECOVERY_CODES
    r = c.post("/api/security/principals", headers=hdr(key), json={"name": uid(), "role": "viewer"})
    assert r.status_code == 403 and "mfa_required" in r.json()["detail"]
    code = mfa.code_for(sec, int(time.time() // 30) + 1)
    assert c.post("/api/security/principals", headers=hdr(key, code), json={"name": uid(), "role": "viewer"}).status_code == 200
    assert c.post("/api/security/principals", headers=hdr(key, code), json={"name": uid(), "role": "viewer"}).status_code == 403  # same code twice
    assert c.get("/api/security/me", headers=hdr(key)).status_code == 200                    # reads do not need step-up
    assert any(e["action"] == "authz.mfa_denied" for e in audit.recent(db, 10))


# ============================================================================================ multisig
def test_multisig_needs_two_distinct_non_requester_approvers(env):
    db = env
    req, a1, a2 = uid("req"), uid("ap1"), uid("ap2")
    a = approvals.request(db, "chain.send", {"to": "0x1", "value": "5"}, req)
    assert a.required == 2
    with pytest.raises(approvals.ApprovalError) as e:
        approvals.vote(db, a.id, req, "approve")
    assert e.value.status == 403 and "separation of duties" in e.value.message
    approvals.vote(db, a.id, a1, "approve")
    with pytest.raises(approvals.ApprovalError) as dup:
        approvals.vote(db, a.id, a1, "approve")                                               # one vote per principal
    assert dup.value.status == 409
    assert approvals.get(db, a.id).status == "pending"
    approvals.vote(db, a.id, a2, "approve")
    assert approvals.get(db, a.id).status == "approved"


def test_approval_is_bound_to_exact_params_single_use_and_vetoable(env):
    db = env
    params = {"to": "0xabc", "value": "10"}
    a = approvals.request(db, "chain.send", params, "r")
    approvals.vote(db, a.id, "x1", "approve")
    approvals.vote(db, a.id, "x2", "approve")
    with pytest.raises(approvals.ApprovalError):
        approvals.consume(db, a.id, "chain.send", {"to": "0xabc", "value": "11"}, "r")         # changed amount
    with pytest.raises(approvals.ApprovalError):
        approvals.consume(db, a.id, "allowlist.add", params, "r")                               # different action
    approvals.consume(db, a.id, "chain.send", params, "r")
    with pytest.raises(approvals.ApprovalError):
        approvals.consume(db, a.id, "chain.send", params, "r")                                  # replay
    veto = approvals.request(db, "chain.send", params, "r")
    approvals.vote(db, veto.id, "x1", "approve")
    approvals.vote(db, veto.id, "x2", "reject")
    assert approvals.get(db, veto.id).status == "rejected"
    with pytest.raises(approvals.ApprovalError):
        approvals.consume(db, veto.id, "chain.send", params, "r")


def test_approvals_expire_and_one_signature_is_never_enough(env, monkeypatch):
    db = env
    monkeypatch.setenv("GOV_APPROVALS_REQUIRED", "1")
    a = approvals.request(db, "chain.send", {"x": 1}, "r")
    assert a.required == 2                                                                    # floor of two signatures
    a.expires_at = now() - timedelta(seconds=1)
    db.commit()
    assert approvals.get(db, a.id).status == "expired"
    with pytest.raises(approvals.ApprovalError):
        approvals.vote(db, a.id, "z", "approve")


def test_approval_api_flow_with_rbac(env):
    db = env
    treasurer, tkey = mk_principal(db, "treasurer")
    _, k1 = mk_principal(db, "approver")
    _, k2 = mk_principal(db, "approver")
    _, vkey = mk_principal(db, "viewer")
    c = TestClient(app)
    a = approvals.request(db, "limits.set", {"role": "*"}, treasurer)
    assert c.post(f"/api/security/approvals/{a.id}/vote", headers=hdr(vkey), json={"decision": "approve"}).status_code == 403
    assert c.post(f"/api/security/approvals/{a.id}/vote", headers=hdr(tkey), json={"decision": "approve"}).status_code == 403  # requester
    assert c.post(f"/api/security/approvals/{a.id}/vote", headers=hdr(k1), json={"decision": "approve"}).json()["status"] == "pending"
    assert c.post(f"/api/security/approvals/{a.id}/vote", headers=hdr(k2), json={"decision": "approve"}).json()["status"] == "approved"
    assert c.post("/api/security/approvals", headers=hdr(tkey), json={"action": "allowlist.add"}).status_code == 422
    assert c.post("/api/security/approvals", headers=hdr(tkey), json={"action": "nope"}).status_code == 422


# ============================================================================================ allowlist
def test_allowlist_needs_approval_then_cooling_off_and_is_revocable(env, monkeypatch):
    db = env
    monkeypatch.setenv("GOV_ALLOWLIST_COOLDOWN_HOURS", "24")
    entry, appr = allowlist.propose(db, "ethereum", DEST, "cold", "treasurer1")
    assert not allowlist.check(db, "ethereum", DEST)[0]                                      # pending: unusable
    with pytest.raises(approvals.ApprovalError):
        allowlist.activate(db, entry.id, appr.id, "treasurer1")                              # not approved yet
    approvals.vote(db, appr.id, "ap1", "approve")
    approvals.vote(db, appr.id, "ap2", "approve")
    allowlist.activate(db, entry.id, appr.id, "treasurer1")
    ok, why = allowlist.check(db, "ethereum", DEST)
    assert not ok and "cooling-off" in why                                                   # approved but still cooling
    entry.activates_at = now() - timedelta(seconds=1)
    db.commit()
    assert allowlist.check(db, "ethereum", DEST) == (True, "ok")
    allowlist.revoke(db, entry.id, "sec")
    assert not allowlist.check(db, "ethereum", DEST)[0]
    with pytest.raises(allowlist.AllowlistError):
        allowlist.propose(db, "ethereum", "0x1234", None, "t")                                # malformed address refused
    mixed = "0x" + "aB" * 20
    with pytest.raises(allowlist.AllowlistError):
        allowlist.propose(db, "ethereum", mixed, None, "t")                                   # bad EIP-55 checksum refused


def test_allowlist_approval_cannot_be_reused_for_another_address(env):
    db = env
    e1, a1 = allowlist.propose(db, "ethereum", DEST, None, "t")
    other = "0x" + "e5" * 20
    e2, _ = allowlist.propose(db, "ethereum", other, None, "t")
    approvals.vote(db, a1.id, "p1", "approve")
    approvals.vote(db, a1.id, "p2", "approve")
    with pytest.raises(approvals.ApprovalError):
        allowlist.activate(db, e2.id, a1.id, "t")


# ============================================================================================ limits
def test_limits_resolve_by_role_and_network_and_catch_split_transfers(env):
    db = env
    limits.set_limit(db, "operator", "ethereum", str(10 ** 17), str(2 * 10 ** 17), None, "sec")
    assert limits.violations(db, "operator", "ethereum", 10 ** 17) == []
    assert limits.violations(db, "operator", "ethereum", 2 * 10 ** 17)                        # per-tx
    assert limits.violations(db, "treasurer", "ethereum", 10 ** 30) == []                     # other role: no row
    limits.set_limit(db, "*", "*", str(5 * 10 ** 17), None, None, "sec")
    assert limits.violations(db, "treasurer", "ethereum", 10 ** 18)                           # wildcard fallback
    for _ in range(2):                                                                         # two sends already in the ledger
        db.add(ChainTransaction(quote_id=uid("q"), wallet_address="0x" + "1" * 40, network="ethereum", kind="transfer", to_address=DEST,
                                value_wei=str(10 ** 17), notional_wei=str(10 ** 17), data_hex="0x", nonce=1, gas_limit=21000,
                                tx_hash="0x" + uuid.uuid4().hex, status="confirmed", summary="x", policy={}))
    db.commit()
    assert any("24h" in v for v in limits.violations(db, "operator", "ethereum", 10 ** 15))
    with pytest.raises(limits.LimitError):
        limits.set_limit(db, "operator", "ethereum", "-5", None, None, "sec")
    with pytest.raises(limits.LimitError):
        limits.set_limit(db, "wizard", "ethereum", "1", None, None, "sec")


# ============================================================================================ fraud
def _tx(db, to, wei, minutes_ago=1, network="ethereum", status="confirmed"):
    db.add(ChainTransaction(quote_id=uid("q"), wallet_address="0x" + "1" * 40, network=network, kind="transfer", to_address=to, value_wei=str(wei),
                            notional_wei=str(wei), data_hex="0x", nonce=1, gas_limit=21000, tx_hash="0x" + uuid.uuid4().hex, status=status, summary="x",
                            policy={}, created_at=now() - timedelta(minutes=minutes_ago)))
    db.commit()


def test_fraud_rules_score_and_levels(env):
    db = env
    v = fraud.evaluate_transfer(db, network="ethereum", to=DEST, notional=10 ** 16)
    assert v.level == "review" and {r["rule"] for r in v.rules} == {"new_destination"}
    for i in range(6):
        _tx(db, DEST, 10 ** 16, minutes_ago=30 + i)
    v = fraud.evaluate_transfer(db, network="ethereum", to=DEST, notional=10 ** 16)
    assert {"velocity", "new_destination"} <= {r["rule"] for r in v.rules} and v.level == "block"
    db.query(ChainTransaction).delete()
    db.commit()
    for i in range(6):
        _tx(db, DEST, 10 ** 16, minutes_ago=60 * 24 + i)
    v = fraud.evaluate_transfer(db, network="ethereum", to=DEST, notional=10 ** 18)
    assert "amount_anomaly" in {r["rule"] for r in v.rules}


def test_fraud_probing_and_repeat_patterns(env):
    db = env
    for i in range(4):
        _tx(db, "0x" + f"{i + 1:040x}", 10 ** 15, minutes_ago=20)
    v = fraud.evaluate_transfer(db, network="ethereum", to=DEST, notional=10 ** 15)
    assert "many_payees" in {r["rule"] for r in v.rules}
    db.query(ChainTransaction).delete()
    db.commit()
    _tx(db, DEST, 10 ** 15, minutes_ago=3)
    assert "rapid_repeat" in {r["rule"] for r in fraud.evaluate_transfer(db, network="ethereum", to=DEST, notional=10 ** 15).rules}


def test_fraud_detects_auth_failure_bursts_and_alerts_are_resolvable(env):
    db = env
    c = TestClient(app)
    for _ in range(6):
        c.get("/api/security/me", headers=hdr("bad-key"))
    assert fraud.auth_failures(db) >= 5
    assert any(s["signal"] == "auth_failure_burst" for s in fraud.scan_accounts(db))
    v = fraud.evaluate_transfer(db, network="ethereum", to=DEST, notional=1)
    assert "auth_failure_burst" in {r["rule"] for r in v.rules}
    alert = fraud.record(db, v, "t", "ethereum:transfer")
    _, sk = mk_principal(db, "security_admin")
    assert c.get("/api/security/fraud/alerts", headers=hdr(sk)).json()["alerts"]
    assert c.post(f"/api/security/fraud/alerts/{alert.id}/resolve", headers=hdr(sk), json={"resolution": "false positive"}).json()["status"] == "resolved"


# ============================================================================================ end-to-end send gate
def chain_env(monkeypatch, db, network="ethereum", cid=1):
    fake = FakeRpc()
    fake.cid = cid
    monkeypatch.setattr(chain_service, "make_rpc", lambda key: fake)
    svc = ChainService(db, settings=SimpleNamespace(kill_switch=False, secret_key="unit-test-secret"))
    svc.create_wallet()
    svc.allow_add(network="*", address=DEST, kind="destination", label="cold")
    return fake, svc


def approved_for(db, svc, quote, extra=()):
    q = svc._unseal(quote)
    a = approvals.request(db, "chain.send", gate.send_params(q), "requester")
    approvals.vote(db, a.id, "signer-1", "approve")
    approvals.vote(db, a.id, "signer-2", "approve")
    for n in extra:
        approvals.vote(db, a.id, n, "approve")
    return a


def test_mainnet_send_blocked_without_allowlist_then_approval_then_succeeds(env, monkeypatch):
    db = env
    fake, svc = chain_env(monkeypatch, db)
    quote = run(svc.preview_transfer("ethereum", DEST, "0.01"))["quote_id"]
    with pytest.raises(ChainError) as e1:
        run(svc.send(quote, "SEND", actor="alice", role="treasurer"))
    assert e1.value.status == 403 and "allowlist" in e1.value.message and not fake.sent
    entry, ap = allowlist.propose(db, "ethereum", DEST, "cold", "alice")
    approvals.vote(db, ap.id, "b1", "approve")
    approvals.vote(db, ap.id, "b2", "approve")
    allowlist.activate(db, entry.id, ap.id, "alice")                                          # cooldown is 0h in this fixture
    with pytest.raises(ChainError) as e2:
        run(svc.send(quote, "SEND", actor="alice", role="treasurer"))
    assert "multi-signature" in e2.value.message and not fake.sent                            # no approval id presented
    wrong = approvals.request(db, "chain.send", {"qid": "other"}, "alice")
    approvals.vote(db, wrong.id, "b1", "approve")
    approvals.vote(db, wrong.id, "b2", "approve")
    with pytest.raises(ChainError) as e3:
        run(svc.send(quote, "SEND", approval_id=wrong.id, actor="alice", role="treasurer"))
    assert "does not match" in e3.value.message and not fake.sent                             # approval for something else
    good = approved_for(db, svc, quote)
    # the fraud rule set sees a clean usable destination; one more look at the verdict, then the send goes through
    tx = run(svc.send(quote, "SEND", approval_id=good.id, actor="alice", role="treasurer"))
    assert tx["status"] == "pending" and len(fake.sent) == 1
    assert approvals.get(db, good.id).status == "executed"
    acts = [r["action"] for r in audit.recent(db, 40)]
    assert "gate.blocked" in acts and "gate.allowed" in acts and "approval.executed" in acts
    assert audit.verify(db)["ok"]


def test_gate_applies_role_limits_and_fraud_blocks_before_any_key_use(env, monkeypatch):
    db = env
    fake, svc = chain_env(monkeypatch, db)
    entry, ap = allowlist.propose(db, "ethereum", DEST, None, "alice")
    approvals.vote(db, ap.id, "b1", "approve")
    approvals.vote(db, ap.id, "b2", "approve")
    allowlist.activate(db, entry.id, ap.id, "alice")
    limits.set_limit(db, "operator", "ethereum", str(10 ** 15), None, None, "sec")
    quote = run(svc.preview_transfer("ethereum", DEST, "0.01"))["quote_id"]
    good = approved_for(db, svc, quote)
    with pytest.raises(ChainError) as e:
        run(svc.send(quote, "SEND", approval_id=good.id, actor="op", role="operator"))
    assert "limit" in e.value.message and not fake.sent
    assert approvals.get(db, good.id).status == "approved"                                    # a refused send does not burn the approval
    for i in range(6):                                                                         # now trigger a hard fraud block (velocity + auth failures)
        _tx(db, DEST, 10 ** 16, minutes_ago=5 + i)
    for _ in range(6):
        audit.append(db, "anonymous", "auth.failed", "api_key")
    with pytest.raises(ChainError) as e2:
        run(svc.send(quote, "SEND", approval_id=good.id, actor="alice", role="treasurer"))
    assert "fraud" in e2.value.message and not fake.sent
    assert db.query(GovFraudAlert).filter_by(verdict="block").count() >= 1


def test_testnet_is_exempt_from_allowlist_and_approval_unless_forced(env, monkeypatch):
    db = env
    fake = FakeRpc()
    monkeypatch.setattr(chain_service, "make_rpc", lambda key: fake)
    monkeypatch.setenv("CHAIN_DEX_ROUTER_SEPOLIA", "0x" + "a1" * 20)
    svc = ChainService(db, settings=SimpleNamespace(kill_switch=False, secret_key="unit-test-secret"))
    svc.create_wallet()
    svc.allow_add(network="*", address=DEST, kind="destination")
    q = run(svc.preview_transfer("sepolia", DEST, "0.01"))["quote_id"]
    assert run(svc.send(q, "SEND", actor="dev", role="operator"))["status"] == "pending"
    monkeypatch.setenv("GOV_ENFORCE_TESTNET", "true")
    q2 = run(svc.preview_transfer("sepolia", DEST, "0.02"))["quote_id"]
    with pytest.raises(ChainError):
        run(svc.send(q2, "SEND", actor="dev", role="operator"))


def test_gate_is_off_in_local_unless_enabled_and_on_in_production(env, monkeypatch):
    monkeypatch.delenv("GOVERNANCE_ENFORCE")
    monkeypatch.delenv("GOV_MFA_REQUIRED")
    assert gate.enforced() is False                                                           # APP_ENV=test
    monkeypatch.setenv("APP_ENV", "production")
    get_settings.cache_clear()
    assert gate.enforced() is True and rbac.mfa_required() is True
    monkeypatch.setenv("GOVERNANCE_ENFORCE", "false")
    assert gate.enforced() is False                                                           # explicit operator override


def test_chain_send_route_requires_rbac_and_mfa_when_enforced(env, monkeypatch):
    db = env
    monkeypatch.setenv("GOV_MFA_REQUIRED", "true")
    c = TestClient(app)
    r = c.post("/api/chain/send", headers=hdr(), json={"quote_id": "x" * 10, "confirm": "SEND"})
    assert r.status_code == 403 and "mfa_enrollment_required" in r.json()["detail"]            # master has not enrolled MFA
    _, vkey = mk_principal(db, "viewer")
    r = c.post("/api/security/chain/send", headers=hdr(vkey), json={"quote_id": "x" * 10, "confirm": "SEND"})
    assert r.status_code == 403 and "not permitted" in r.json()["detail"]


# ============================================================================================ transport / headers
def test_security_headers_and_https_enforcement(env, monkeypatch):
    c = TestClient(app)
    r = c.get("/api/security/me", headers=hdr())
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-store" and "default-src 'none'" in r.headers["content-security-policy"]
    assert "strict-transport-security" not in r.headers                                       # not enforced in the test environment
    monkeypatch.setenv("GOV_ENFORCE_HTTPS", "true")
    r = c.get("/api/security/me", headers={**hdr(), "x-forwarded-proto": "http", "host": "eti.example.com"}, follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "https://eti.example.com/api/security/me"
    r = c.get("/api/security/me", headers={**hdr(), "x-forwarded-proto": "https"})
    assert r.status_code == 200 and "max-age=31536000" in r.headers["strict-transport-security"]


# ============================================================================================ secrets
def test_secret_scanner_flags_credentials_and_honours_markers():
    pem = "-----BEGIN " + "PRIVATE KEY-----"
    hexkey = "private_key = '" + "ab" * 32 + "'"
    assert secretscan.scan_text(pem)[0]["rule"] == "pem_private_key"
    assert secretscan.scan_text(hexkey)[0]["rule"] == "hex_private_key_assignment"
    assert secretscan.scan_text("mnemonic = '" + " ".join(["abandon"] * 12) + "'")[0]["rule"] == "seed_phrase_assignment"
    assert secretscan.scan_text(hexkey + "  # scan:allow") == []
    assert secretscan.scan_text("api_key = os.getenv('API_KEY')") == []


def test_repository_contains_no_committed_secrets():
    root = pathlib.Path(__file__).resolve().parents[1]
    hits = [h for h in secretscan.scan_tree(str(root)) if not h["file"].startswith("tests/")]
    assert hits == [], hits


def test_sealed_values_roundtrip_and_survive_key_rotation(env, monkeypatch):
    sealed = keys.seal("totp-seed")
    assert "totp-seed" not in sealed and keys.unseal(sealed) == "totp-seed"
    old = keys._material("GOVERNANCE_KEY").decode()
    monkeypatch.setenv("GOVERNANCE_KEY", "another-key-" + "z" * 30)
    with pytest.raises(keys.GovernanceKeyError):
        keys.unseal(sealed)
    monkeypatch.setenv("GOVERNANCE_KEY_PREVIOUS", old)
    assert keys.unseal(sealed) == "totp-seed"
    resealed = keys.reseal(sealed)
    monkeypatch.delenv("GOVERNANCE_KEY_PREVIOUS")
    assert keys.unseal(resealed) == "totp-seed"


def test_posture_reports_honestly(env):
    db = env
    rep = posture.report(db)
    by = {c["id"]: c for c in rep["checks"]}
    assert by["audit_chain"]["status"] == "pass" and by["db_at_rest"]["status"] == "unverified"
    assert by["multisig_ready"]["status"] == "fail"                                           # no approver principals in a clean DB
    mk_principal(db, "approver")
    mk_principal(db, "treasurer")
    assert {c["id"]: c for c in posture.report(db)["checks"]}["multisig_ready"]["status"] == "pass"
    assert by["dr_backup"]["status"] == "warn"


# ============================================================================================ disaster recovery
def test_backup_is_encrypted_verified_and_tamper_evident(env):
    db = env
    name, _ = mk_principal(db, "security_admin")
    audit.append(db, "t", "unit.dr")
    env_ = dr.backup(db, "correct horse battery staple", "tester")
    blob = json.dumps(env_)
    assert name not in blob and "unit.dr" not in blob and "correct horse" not in blob          # nothing readable in the envelope
    rep = dr.verify(env_, "correct horse battery staple")
    assert rep["ok"] and rep["counts"]["gov_principals"] >= 1 and rep["head_matches"]
    with pytest.raises(dr.DRError) as bad:
        dr.verify(env_, "wrong passphrase entirely")
    assert bad.value.status == 403
    flipped = dict(env_)
    ct = bytearray(__import__("base64").b64decode(env_["ciphertext"]))
    ct[10] ^= 1
    flipped["ciphertext"] = __import__("base64").b64encode(bytes(ct)).decode()
    with pytest.raises(dr.DRError):
        dr.verify(flipped, "correct horse battery staple")
    hdr_tamper = {**env_, "meta": {**env_["meta"], "iter": 5000}}
    with pytest.raises(dr.DRError):
        dr.verify(hdr_tamper, "correct horse battery staple")                                 # header is authenticated
    with pytest.raises(dr.DRError) as short:
        dr.backup(db, "short", "tester")
    assert short.value.status == 422


def test_kdf_floor_is_enforced_outside_local(env, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("GOV_BACKUP_KDF_ITER", "1000")
    get_settings.cache_clear()
    assert dr.iterations() == dr.MIN_ITER == 600_000


def test_restore_into_a_fresh_database_rebuilds_state_and_audit_chain(env, tmp_path):
    db = env
    n, key = mk_principal(db, "approver")
    entry, ap = allowlist.propose(db, "ethereum", DEST, "cold", "alice")
    limits.set_limit(db, "*", "ethereum", "5", None, None, "sec")
    env_ = dr.backup(db, "correct horse battery staple", "tester")
    eng = create_engine(f"sqlite:///{tmp_path}/fresh.db")
    Base.metadata.create_all(eng, tables=[m.__table__ for m in dr.TABLES])
    fresh = sessionmaker(bind=eng)()
    out = dr.restore(fresh, env_, "correct horse battery staple", "operator")
    assert out["restored"]
    assert fresh.query(GovPrincipal).filter_by(name=n).one().key_hash == rbac.hash_key(key)    # keys still authenticate after recovery
    assert fresh.query(GovAllowEntry).count() == 1 and fresh.query(GovLimit).count() == 1
    assert audit.verify(fresh)["ok"]
    assert fresh.query(GovAudit).filter_by(action="dr.restored").count() == 1
    with pytest.raises(dr.DRError) as again:
        dr.restore(fresh, env_, "correct horse battery staple", "operator")
    assert again.value.status == 409                                                          # never overwrites existing state
    # a backup whose audit chain was altered before encryption is refused
    forged = dr.snapshot(db)
    forged["gov_audit"][0]["actor"] = "mallory"
    import base64, os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    meta = dict(env_["meta"])
    salt, nonce = os.urandom(16), os.urandom(12)
    ct = AESGCM(dr._kdf("correct horse battery staple", salt, meta["iter"])).encrypt(nonce, json.dumps(forged, default=str).encode(), dr._aad(meta))
    bad_env = {"meta": meta, "salt": base64.b64encode(salt).decode(), "nonce": base64.b64encode(nonce).decode(), "ciphertext": base64.b64encode(ct).decode()}
    eng2 = create_engine(f"sqlite:///{tmp_path}/fresh2.db")
    Base.metadata.create_all(eng2, tables=[m.__table__ for m in dr.TABLES])
    f2 = sessionmaker(bind=eng2)()
    with pytest.raises(dr.DRError) as e:
        dr.restore(f2, bad_env, "correct horse battery staple", "operator")
    assert e.value.status == 422 and f2.query(GovAudit).count() == 0


def test_dr_api_backup_drill_and_status(env):
    db = env
    _, sk = mk_principal(db, "security_admin")
    c = TestClient(app)
    body = {"passphrase": "correct horse battery staple"}
    assert c.post("/api/security/dr/backup", headers=hdr(sk), json={"passphrase": "short"}).status_code == 422
    b = c.post("/api/security/dr/backup", headers=hdr(sk), json=body)
    assert b.status_code == 200 and b.json()["meta"]["cipher"] == "aes-256-gcm"
    assert c.post("/api/security/dr/verify", headers=hdr(sk), json={**body, "backup": b.json()}).json()["ok"]
    assert c.post("/api/security/dr/drill", headers=hdr(sk), json=body).json()["ok"]
    st = c.get("/api/security/dr/status", headers=hdr(sk)).json()
    assert st["last"]["backup"] and st["last"]["drill"]
    _, vkey = mk_principal(db, "viewer")
    assert c.post("/api/security/dr/backup", headers=hdr(vkey), json=body).status_code == 403


# ============================================================================================ page + migration
def test_security_page_renders_and_is_linked_in_navigation(env):
    c = TestClient(app)
    r = c.get("/security")
    assert r.status_code == 200 and "Security &amp; compliance" in r.text and "/api/security" in r.text
    assert "localStorage" not in r.text
    assert 'href="/security"' in c.get("/wallet").text


def test_migration_matches_models(tmp_path):
    """Run this revision's upgrade() on a clean SQLite DB (the historical chain has SQLite-incompatible steps, so it is applied directly)."""
    import importlib.util as ilu
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect
    root = pathlib.Path(__file__).resolve().parents[1]
    spec = ilu.spec_from_file_location("mig0013", root / "alembic/versions/0013_governance.py")
    mig = ilu.module_from_spec(spec)
    spec.loader.exec_module(mig)
    assert mig.revision == "0013_governance" and mig.down_revision == "0012_accounting"
    eng = create_engine(f"sqlite:///{tmp_path}/mig.db")
    with eng.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            mig.upgrade()
    insp = inspect(eng)
    for m in dr.TABLES:
        assert {c["name"] for c in insp.get_columns(m.__tablename__)} == {c.key for c in m.__table__.columns}, m.__tablename__
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO gov_audit(seq,ts,actor,action,subject,detail,prev_hash,hash,kid) VALUES (1,'t','a','b','','{}','0','h','k')"))
    for stmt in ("DELETE FROM gov_audit", "UPDATE gov_audit SET actor='x'"):
        with pytest.raises(DBAPIError):
            with eng.begin() as conn:
                conn.execute(text(stmt))                                # the trigger installed by the migration
    with eng.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            mig.downgrade()
    assert not inspect(eng).has_table("gov_audit")

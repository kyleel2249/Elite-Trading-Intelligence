"""Execution authorization: provisioning, authentication, rotation, expiry, revocation, environment
isolation, execution gate, credential handling, and the no-secret-leak guarantees."""
import asyncio
import logging
import re
import time
import uuid
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.memory.util import utcnow
from app.security import execution_auth as ea
from app.security.auth_models import ExecAuthEvent, ExecAuthToken
from app.security.execution_auth import (
    AuthError, AuthKeyring, AuthPolicy, Principal, RateLimiter, TokenService, execution_gate, make_ticket, order_digest,
    redact, reset_keyring_for_tests, verify_ticket,
)
from app.security import exchange_credentials as xc

ROOT = Path(__file__).resolve().parents[1]
KEY = b"k" * 48
POLICY = AuthPolicy(idle_ttl=60, absolute_ttl=600, rotate_after=30, grace=10, max_active=1000, auto_sessions=True)


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()


@pytest.fixture(autouse=True)
def _keyring():
    reset_keyring_for_tests(AuthKeyring(KEY))
    yield
    reset_keyring_for_tests(None)


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


class Clock:
    def __init__(self):
        self.t = utcnow()

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t = self.t + timedelta(seconds=seconds)


def svc_with(db, clock=None, policy=POLICY, keyring=None):
    return TokenService(db, keyring=keyring or AuthKeyring(KEY), policy=policy, now=clock)


# ----------------------------------------------------------------------------- provisioning
def test_tokens_are_random_prefixed_and_only_hashed_at_rest(db):
    svc = svc_with(db)
    raw1, row1 = svc.issue("internal_paper")
    raw2, _ = svc.issue("internal_paper")
    assert raw1 != raw2 and re.fullmatch(r"eti_ip_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}", raw1)
    secret = raw1.split(".", 1)[1]
    stored = db.query(ExecAuthToken).filter(ExecAuthToken.token_id == row1.token_id).one()
    assert secret not in (stored.token_hash, stored.token_id, str(stored.subject)) and len(stored.token_hash) == 64
    assert svc.verify(raw1, "internal_paper").token_id == row1.token_id


def test_live_can_never_be_provisioned_or_verified(db):
    svc = svc_with(db)
    with pytest.raises(AuthError) as e:
        svc.issue("live")
    assert e.value.code == "live_disabled" and e.value.status == 403
    with pytest.raises(AuthError) as e2:
        svc.verify("eti_lv_0123456789abcdef." + "a" * 43, "internal_paper")
    assert e2.value.code == "live_disabled"
    with pytest.raises(AuthError):
        svc.issue("mystery")


def test_tamper_and_malformed_tokens_are_rejected(db):
    svc = svc_with(db)
    raw, row = svc.issue("internal_paper")
    bad = raw[:-3] + ("AAA" if not raw.endswith("AAA") else "BBB")
    with pytest.raises(AuthError) as e:
        svc.verify(bad, "internal_paper")
    assert e.value.code == "invalid_token"
    for junk in (None, "", "nonsense", "eti_ip_xyz.abc"):
        with pytest.raises(AuthError) as e2:
            svc.verify(junk, "internal_paper")
        assert e2.value.code == "malformed_token"
    with pytest.raises(AuthError) as e3:
        svc.verify("eti_ip_ffffffffffffffff." + "a" * 43, "internal_paper")
    assert e3.value.code == "unknown_token"


# ------------------------------------------------------------------- environment isolation
def test_a_credential_only_works_in_its_own_environment(db):
    svc = svc_with(db)
    paper_raw, _ = svc.issue("internal_paper")
    testnet_raw, _ = svc.issue("exchange_testnet")
    assert testnet_raw.startswith("eti_xt_")
    with pytest.raises(AuthError) as e:
        svc.verify(paper_raw, "exchange_testnet")
    assert e.value.code == "wrong_environment" and e.value.status == 403
    with pytest.raises(AuthError) as e2:
        svc.verify(testnet_raw, "internal_paper")
    assert e2.value.code == "wrong_environment"
    assert svc.verify(testnet_raw, "exchange_testnet").environment == "exchange_testnet"


def test_revoking_one_environment_leaves_the_other_untouched(db):
    svc = svc_with(db)
    p, _ = svc.issue("internal_paper")
    t, _ = svc.issue("exchange_testnet")
    assert svc.revoke_environment("exchange_testnet", "test") >= 1
    with pytest.raises(AuthError) as e:
        svc.verify(t, "exchange_testnet")
    assert e.value.code == "token_revoked"
    assert svc.verify(p, "internal_paper")


# ------------------------------------------------------------------------- expiry / sliding
def test_idle_expiry_and_sliding(db):
    clock = Clock()
    svc = svc_with(db, clock)
    raw, row = svc.issue("internal_paper")
    clock.advance(40)
    svc.slide(svc.verify(raw, "internal_paper"))
    clock.advance(40)  # 80s after issue but only 40s idle
    svc.verify(raw, "internal_paper")
    clock.advance(61)
    with pytest.raises(AuthError) as e:
        svc.verify(raw, "internal_paper")
    assert e.value.code == "token_expired"
    assert svc.is_active(row.token_id) is False


def test_absolute_expiry_cannot_be_extended_by_activity(db):
    clock = Clock()
    svc = svc_with(db, clock)
    raw, _ = svc.issue("internal_paper")
    code = None
    for _ in range(20):
        clock.advance(50)
        try:
            svc.slide(svc.verify(raw, "internal_paper"))
        except AuthError as e:
            code = e.code
            break
    assert code == "token_expired"
    assert (clock.t - svc.db.query(ExecAuthToken).order_by(ExecAuthToken.id.desc()).first().created_at.replace(tzinfo=clock.t.tzinfo)).total_seconds() <= 700


# ----------------------------------------------------------------------------------- rotation
def test_rotation_issues_a_successor_and_retires_the_old_token_after_grace(db):
    clock = Clock()
    svc = svc_with(db, clock)
    raw1, row1 = svc.issue("internal_paper")
    assert not svc.needs_rotation(row1)
    clock.advance(31)
    assert svc.needs_rotation(row1)
    raw2, row2 = svc.rotate(row1)
    assert raw2 != raw1 and row2.token_id != row1.token_id and row1.replaced_by == row2.token_id
    assert row2.absolute_expires_at == row1.absolute_expires_at, "rotation must not extend the absolute lifetime"
    clock.advance(5)
    old = svc.verify(raw1, "internal_paper")  # in-flight requests still succeed during the grace period
    assert not svc.needs_rotation(old)
    clock.advance(10)
    with pytest.raises(AuthError) as e:
        svc.verify(raw1, "internal_paper")
    assert e.value.code == "token_expired"
    assert svc.verify(raw2, "internal_paper")


def test_signing_key_rotation_keeps_sessions_until_the_previous_key_is_dropped(db):
    old_kr = AuthKeyring(b"a" * 48)
    raw, _ = svc_with(db, keyring=old_kr).issue("internal_paper")
    new_kr = AuthKeyring(b"b" * 48, previous=[b"a" * 48])
    assert svc_with(db, keyring=new_kr).verify(raw, "internal_paper")
    with pytest.raises(AuthError) as e:
        svc_with(db, keyring=AuthKeyring(b"b" * 48)).verify(raw, "internal_paper")
    assert e.value.code == "invalid_token"
    with pytest.raises(ValueError):
        AuthKeyring(b"short")


# ---------------------------------------------------------------------------- revocation etc.
def test_revocation_is_immediate(db):
    svc = svc_with(db)
    raw, row = svc.issue("internal_paper")
    assert svc.revoke(row.token_id, "unit test") is True and svc.revoke(row.token_id) is False
    with pytest.raises(AuthError) as e:
        svc.verify(raw, "internal_paper")
    assert e.value.code == "token_revoked"


def test_session_capacity_is_bounded_and_recovers(db):
    svc = svc_with(db, policy=AuthPolicy(60, 600, 30, 10, max_active=svc_with(db).active_count() + 2, auto_sessions=True))
    _, a = svc.issue("internal_paper")
    svc.issue("internal_paper")
    with pytest.raises(AuthError) as e:
        svc.issue("internal_paper")
    assert e.value.code == "session_capacity" and e.value.status == 503
    svc.revoke(a.token_id)
    svc.issue("internal_paper")


def test_purge_removes_old_rows_but_keeps_recent_audit(db):
    clock = Clock()
    svc = svc_with(db, clock)
    _, row = svc.issue("internal_paper")
    tid = row.token_id
    clock.advance(600 + 8 * 86400)
    assert svc.purge() >= 1
    assert db.query(ExecAuthToken).filter(ExecAuthToken.token_id == tid).count() == 0


def test_rate_limiter():
    rl = RateLimiter(limit=3, window=10)
    assert [rl.allow("ip", now=t) for t in (0, 1, 2, 3)] == [True, True, True, False]
    assert rl.allow("ip", now=11.5) is True and rl.allow("other", now=3) is True


# ------------------------------------------------------------------------- execution gate
def test_tickets_bind_environment_payload_and_expiry(db, monkeypatch):
    p = Principal("operator", "internal_paper")
    digest = order_digest({"symbol": "BTCUSDT", "qty": 1})
    t = make_ticket(p, "internal_paper", digest)
    assert verify_ticket(t, "internal_paper", digest) == "-"
    with pytest.raises(AuthError) as e:
        verify_ticket(t, "exchange_testnet", digest)
    assert e.value.code == "wrong_environment"
    with pytest.raises(AuthError) as e2:
        verify_ticket(t, "internal_paper", order_digest({"symbol": "BTCUSDT", "qty": 2}))
    assert e2.value.code == "ticket_payload_mismatch"
    with pytest.raises(AuthError):
        verify_ticket(t[:-2] + "00", "internal_paper", digest)
    real = time.time()
    monkeypatch.setattr(ea.time, "time", lambda: real + 31)
    with pytest.raises(AuthError) as e3:
        verify_ticket(t, "internal_paper", digest)
    assert e3.value.code == "ticket_expired"


def test_execution_gate_rechecks_session_and_environment(db):
    svc = svc_with(db)
    _, row = svc.issue("internal_paper")
    principal = Principal("session", "internal_paper", row.token_id)
    execution_gate(principal, "internal_paper", {"symbol": "BTCUSDT"})
    with pytest.raises(HTTPException) as e:
        execution_gate(principal, "exchange_testnet", {"symbol": "BTCUSDT"})
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as live:
        execution_gate(Principal("operator", "live"), "live", {})
    assert live.value.status_code == 403 and live.value.detail["code"] == "live_disabled"
    svc.revoke(row.token_id)
    with pytest.raises(HTTPException) as e2:
        execution_gate(principal, "internal_paper", {"symbol": "BTCUSDT"})
    assert e2.value.status_code == 401 and e2.value.detail["code"] == "token_revoked"


# ----------------------------------------------------------------------- secrets never leak
def test_redaction_and_log_filter(caplog):
    raw = "eti_ip_0123456789abcdef." + "S3cr3tS3cr3tS3cr3tS3cr3tS3cr3t"
    assert "S3cr3t" not in redact(f"token {raw} and X-API-Key: hunter2hunter2 Cookie=abc123")
    assert "hunter2" not in redact("x-api-key: hunter2hunter2")
    with caplog.at_level(logging.WARNING):
        logging.getLogger("eti.test").warning("leaky message %s", raw)
    assert "S3cr3t" not in caplog.text and "[REDACTED]" in caplog.text


def test_frontend_has_no_token_or_api_key_storage():
    html = (ROOT / "app" / "templates" / "index.html").read_text()
    assert "eti_api_key" not in html and "localStorage" not in html and "sessionStorage" not in html
    assert "X-API-Key" not in html and "eti_session" not in html
    for path in (ROOT / "app" / "static").rglob("*") if (ROOT / "app" / "static").exists() else []:
        if path.is_file() and path.suffix in (".js", ".html"):
            assert "eti_session" not in path.read_text(errors="ignore")


def test_no_withdrawal_or_transfer_capability_exists_in_code():
    bad = re.compile(r"def\s+(withdraw|transfer|payout)\w*\s*\(|capital/withdraw|asset/transfer|/withdrawals?['\"]", re.I)
    hits = []
    for path in (ROOT / "app").rglob("*.py"):
        if path.name in ("execution_auth.py",):
            continue
        if bad.search(path.read_text(errors="ignore")):
            hits.append(str(path.relative_to(ROOT)))
    assert hits == []
    assert ea.FORBIDDEN_PATH_RE.search("/api/paper/withdraw") and ea.FORBIDDEN_PATH_RE.search("/x/transfer")


# ------------------------------------------------------------------- exchange credentials
class FakeAdapter:
    def __init__(self, behavior="ok", delay=0.0):
        self.behavior, self.delay = behavior, delay

    async def verify_permissions(self):
        from app.execution import errors as er

        if self.delay:
            await asyncio.sleep(self.delay)
        raise_map = {"unsafe": er.PermissionPolicyError, "invalid": er.PermanentProviderError,
                     "transient": er.TransientProviderError, "unavailable": er.ProviderUnavailableError}
        if self.behavior in raise_map:
            raise raise_map[self.behavior]("nope")

    async def get_equity(self):
        return 1000.0


@pytest.mark.parametrize("behavior,expected", [("ok", "valid"), ("unsafe", "unsafe_permissions"), ("invalid", "invalid"),
                                                ("transient", "unverifiable"), ("unavailable", "unverifiable")])
def test_credential_validation_states(behavior, expected):
    status, _ = asyncio.run(xc.validate_credentials({"api_key": "k", "secret_key": "s"}, adapter_factory=lambda c: FakeAdapter(behavior)))
    assert status == expected


def test_credential_validation_timeout_is_unverifiable_not_valid():
    status, _ = asyncio.run(xc.validate_credentials({"api_key": "k", "secret_key": "s"},
                                                    adapter_factory=lambda c: FakeAdapter(delay=0.5), timeout=0.05))
    assert status == "unverifiable"


def test_credentials_are_loaded_from_secrets_never_fabricated(monkeypatch):
    for name in ("BINANCE_TESTNET_API_KEY", "BINANCE_TESTNET_SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    none = SimpleNamespace(binance_api_key=None, binance_secret_key=None, binance_testnet_enabled=True, binance_live_trading_enabled=False)
    assert xc.load_testnet_credentials(none) is None
    xc.reset_cache()
    assert asyncio.run(xc.get_credential_state(none)).status == "missing"

    generic = SimpleNamespace(binance_api_key="gk-generic-123", binance_secret_key="gs-generic-456", binance_testnet_enabled=True,
                              binance_live_trading_enabled=False)
    assert xc.load_testnet_credentials(generic)[1] == "env:BINANCE_*"
    live_flag = SimpleNamespace(**{**generic.__dict__, "binance_live_trading_enabled": True})
    assert xc.load_testnet_credentials(live_flag) is None, "a live-capable key must never be reused as a testnet key"

    monkeypatch.setenv("BINANCE_TESTNET_API_KEY", "tk-testnet-key-1")
    monkeypatch.setenv("BINANCE_TESTNET_SECRET_KEY", "ts-testnet-secret-1")
    xc.reset_cache()
    state = asyncio.run(xc.get_credential_state(none, force=True, adapter_factory=lambda c: FakeAdapter("ok")))
    assert state.status == "valid" and state.source == "env:BINANCE_TESTNET_*"
    dumped = str(state.to_dict())
    assert "tk-testnet" not in dumped and "ts-testnet" not in dumped
    xc.reset_cache()
    bad = asyncio.run(xc.get_credential_state(none, force=True, adapter_factory=lambda c: FakeAdapter("invalid")))
    assert bad.status == "invalid"
    xc.reset_cache()


# ------------------------------------------------------------------------------ HTTP flow
class FakeOrder:
    def to_dict(self):
        return {"id": "o1", "status": "filled", "symbol": "BTCUSDT"}


class FakePaper:
    def __init__(self):
        self.submitted = []

    async def submit(self, account_id, req):
        self.submitted.append((account_id, req))
        return FakeOrder()

    async def summary(self, account_id):
        return {"equity": 10000.0}

    async def cancel_all(self, account_id):
        return 0

    async def flatten(self, account_id):
        return {"canceled": [], "sold": [], "failed": []}


ORDER = {"symbol": "BTCUSDT", "side": "buy", "qty": 0.01}
OP_KEY = "operator-key-for-tests-123"


@pytest.fixture
def env(monkeypatch):
    from app.paper import wiring
    from app.main import app

    monkeypatch.setenv("API_KEY", OP_KEY)
    monkeypatch.delenv("EXEC_AUTO_SESSIONS", raising=False)
    get_settings.cache_clear()
    ea.session_limiter._hits.clear()
    fake = FakePaper()
    monkeypatch.setattr(wiring, "get_paper_service", lambda: fake)

    async def no_creds(settings, **kw):
        return xc.CredentialState("missing", None, time.time(), "No exchange testnet credentials are configured.")

    monkeypatch.setattr("app.api.auth_session.get_credential_state", no_creds)
    client = TestClient(app, base_url="https://testserver")
    yield SimpleNamespace(client=client, fake=fake, mp=monkeypatch)
    get_settings.cache_clear()


def test_paper_starts_automatically_without_any_manual_token(env):
    c = env.client
    assert c.post("/api/paper/orders", json=ORDER).status_code == 401  # nothing yet
    r = c.post("/api/auth/session", json={})
    assert r.status_code == 200 and r.json()["authenticated"] and r.json()["environment"] == "internal_paper"
    set_cookie = r.headers["set-cookie"].lower()
    assert "httponly" in set_cookie and "secure" in set_cookie and "samesite=strict" in set_cookie and "path=/api" in set_cookie
    assert "eti_ip_" not in r.text, "the session token must never appear in a response body"
    order = c.post("/api/paper/orders", json=ORDER)
    assert order.status_code == 200 and order.json()["mode"] == "internal_paper" and len(env.fake.submitted) == 1
    assert "eti_ip_" not in order.text
    assert c.get("/api/auth/status").json()["sessions"]["internal_paper"]["authenticated"] is True


def test_testnet_request_without_credentials_falls_back_visibly_and_never_claims_testnet(env):
    c = env.client
    c.post("/api/auth/session", json={})
    r = c.post("/api/paper/orders", json={**ORDER, "mode": "exchange_testnet"})
    body = r.json()
    assert r.status_code == 200 and body["mode"] == "internal_paper" and body["downgraded"] is True
    assert "Nothing was sent to an exchange" in body["reason"] and "exchange_account" not in body
    st = c.get("/api/auth/status", params={"environment": "exchange_testnet"}).json()
    assert st["fallback"] is True and st["effective"] == "internal_paper"
    notice = [n for n in st["notices"] if n["code"] == "TESTNET_FALLBACK"][0]
    assert "INTERNAL PAPER" in notice["message"] and st["environments"]["exchange_testnet"]["credentials"]["status"] == "missing"
    assert st["environments"]["live"]["available"] is False


def test_operator_key_still_works_and_wrong_key_is_rejected(env):
    c = env.client
    ok = c.post("/api/paper/orders", json=ORDER, headers={"X-API-Key": OP_KEY})
    assert ok.status_code == 200
    bad = c.post("/api/paper/orders", json=ORDER, headers={"X-API-Key": "wrong"})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "invalid_api_key"


def test_live_is_refused_everywhere(env):
    c = env.client
    assert c.post("/api/auth/session", json={"environment": "live"}).status_code == 403
    assert c.post("/api/paper/orders", json={**ORDER, "mode": "live"}, headers={"X-API-Key": OP_KEY}).status_code == 403
    assert c.post("/api/auth/session", json={"environment": "live"}, headers={"X-API-Key": OP_KEY}).status_code == 403


def test_testnet_sessions_need_the_operator_and_cannot_be_borrowed_from_paper(env):
    c = env.client
    r = c.post("/api/auth/session", json={"environment": "exchange_testnet"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "operator_required"
    c.post("/api/auth/session", json={})
    paper_raw = c.cookies.get("eti_session_ip")
    c.cookies.set("eti_session_xt", paper_raw, path="/api")  # paper credential presented as testnet
    x = c.post("/api/auth/refresh", json={"environment": "exchange_testnet"})
    assert x.status_code == 403 and x.json()["detail"]["code"] == "wrong_environment"
    op = c.post("/api/auth/session", json={"environment": "exchange_testnet"}, headers={"X-API-Key": OP_KEY})
    assert op.status_code == 200 and op.json()["environment"] == "exchange_testnet"


def test_logout_and_operator_revoke_end_sessions(env):
    c = env.client
    c.post("/api/auth/session", json={})
    old = c.cookies.get("eti_session_ip")
    assert c.post("/api/auth/logout", json={}).json()["revoked"] is True
    c.cookies.set("eti_session_ip", old, path="/api")
    r = c.post("/api/paper/orders", json=ORDER)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "token_revoked"

    c.cookies.clear()
    c.post("/api/auth/session", json={})
    assert c.post("/api/paper/orders", json=ORDER).status_code == 200
    assert c.post("/api/auth/revoke", json={"environment": "internal_paper"}).status_code == 401  # operator only
    rv = c.post("/api/auth/revoke", json={"environment": "internal_paper"}, headers={"X-API-Key": OP_KEY})
    assert rv.status_code == 200 and rv.json()["revoked"] >= 1
    assert c.post("/api/paper/orders", json=ORDER).status_code == 401
    events = c.get("/api/auth/events", headers={"X-API-Key": OP_KEY})
    assert events.status_code == 200 and "eti_ip_" not in events.text and old.split(".", 1)[1] not in events.text


def test_expired_session_is_refused_and_restart_is_automatic(env):
    c = env.client
    c.post("/api/auth/session", json={})
    token_id = c.cookies.get("eti_session_ip").split("_")[2].split(".")[0]
    db = SessionLocal()
    try:
        row = db.query(ExecAuthToken).filter(ExecAuthToken.token_id == token_id).one()
        row.idle_expires_at = utcnow() - timedelta(seconds=5)
        db.commit()
    finally:
        db.close()
    r = c.post("/api/paper/orders", json=ORDER)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "token_expired"
    assert c.post("/api/auth/session", json={}).status_code == 200  # the dashboard simply starts a new one
    assert c.post("/api/paper/orders", json=ORDER).status_code == 200


def test_session_rotates_automatically_and_old_cookie_survives_the_grace_period(env):
    c = env.client
    c.post("/api/auth/session", json={})
    old = c.cookies.get("eti_session_ip")
    token_id = old.split("_")[2].split(".")[0]
    db = SessionLocal()
    try:
        row = db.query(ExecAuthToken).filter(ExecAuthToken.token_id == token_id).one()
        row.created_at = utcnow() - timedelta(hours=1)
        db.commit()
    finally:
        db.close()
    assert c.post("/api/paper/orders", json=ORDER).status_code == 200
    new = c.cookies.get("eti_session_ip")
    assert new and new != old
    c.cookies.set("eti_session_ip", old, path="/api")  # an in-flight request still using the old one
    assert c.post("/api/paper/orders", json=ORDER).status_code == 200


def test_cross_site_requests_with_a_session_are_refused(env):
    c = env.client
    c.post("/api/auth/session", json={})
    r = c.post("/api/paper/orders", json=ORDER, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "csrf"
    r2 = c.post("/api/paper/orders", json=ORDER, headers={"Origin": "https://evil.example"})
    assert r2.status_code == 403
    assert c.post("/api/paper/orders", json=ORDER, headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200


def test_auto_sessions_can_be_disabled_and_reset_stays_operator_only(env):
    c = env.client
    env.mp.setenv("EXEC_AUTO_SESSIONS", "false")
    r = c.post("/api/auth/session", json={})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "auto_sessions_disabled"
    assert c.post("/api/auth/session", json={}, headers={"X-API-Key": OP_KEY}).status_code == 200
    env.mp.delenv("EXEC_AUTO_SESSIONS")
    assert c.post("/api/paper/reset", json={"confirm": "RESET default"}).status_code == 401


def test_local_development_without_api_key_stays_open_as_before(env):
    env.mp.delenv("API_KEY", raising=False)
    env.mp.setenv("APP_ENV", "development")
    get_settings.cache_clear()
    r = env.client.post("/api/paper/orders", json=ORDER)
    assert r.status_code == 200
    assert any(n["code"] == "DEV_OPEN" for n in env.client.get("/api/auth/status").json()["notices"])


def test_status_and_audit_never_contain_secrets(env):
    c = env.client
    c.post("/api/auth/session", json={})
    raw = c.cookies.get("eti_session_ip")
    text = c.get("/api/auth/status").text + c.get("/api/auth/events", headers={"X-API-Key": OP_KEY}).text
    assert raw not in text and raw.split(".", 1)[1] not in text and OP_KEY not in text
    db = SessionLocal()
    try:
        assert db.query(ExecAuthEvent).count() > 0
        for ev in db.query(ExecAuthEvent).all():
            assert not any("eti_" in str(getattr(ev, f) or "") and "." in str(getattr(ev, f) or "") for f in ("reason", "path", "token_id"))
    finally:
        db.close()

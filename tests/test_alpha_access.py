import pytest
from fastapi.testclient import TestClient

import app.security.auth as auth
from app.alpha.access import ROLES, fingerprint, parse_role_keys, resolve
from app.alpha.db_models import AlphaAuditLog
from app.config import Settings
from app.database import SessionLocal, init_db
from app.main import app

client = TestClient(app)
ADMIN, ANALYST, TRADER = "admin-key-0123456789", "analyst-key-0123456789", "trader-key-0123456789"


@pytest.fixture(autouse=True)
def _db():
    init_db()


def _use(monkeypatch, **kw):
    s = Settings(**kw)
    monkeypatch.setattr(auth, "get_settings", lambda: s)
    return s


@pytest.fixture()
def roles(monkeypatch):
    return _use(monkeypatch, app_env="production", api_key=ADMIN, alpha_role_keys=f"{ANALYST}:analyst,{TRADER}:trader")


def H(k):
    return {"X-API-Key": k}


def test_parse_role_keys_rejects_weak_duplicate_and_admin_entries():
    keys, problems = parse_role_keys(f"{ANALYST}:analyst, short:trader, {TRADER}:admin, {ANALYST}:trader, {TRADER}:TRADER")
    assert keys == {ANALYST: "analyst", TRADER: "trader"} or keys == {ANALYST: "analyst"} | {TRADER: "trader"}
    assert any("shorter" in p for p in problems) and any("admin" in p for p in problems) and any("duplicate" in p for p in problems)
    assert parse_role_keys(None) == ({}, [])


def test_resolve_maps_keys_to_roles_and_master_is_admin():
    s = Settings(api_key=ADMIN, alpha_role_keys=f"{ANALYST}:analyst")
    assert resolve(ADMIN, s).role == "admin" and resolve(ANALYST, s).role == "analyst"
    assert resolve("nope", s) is None and resolve(None, s) is None and resolve("", s) is None
    assert resolve(ANALYST, s).key_id == fingerprint(ANALYST) and ANALYST not in resolve(ANALYST, s).key_id
    # a role key equal to the master key never downgrades the admin key
    both = Settings(api_key=ADMIN, alpha_role_keys=f"{ADMIN}:analyst")
    assert resolve(ADMIN, both).role == "admin"


def test_hierarchy_is_ordered():
    assert ROLES["analyst"] < ROLES["trader"] < ROLES["admin"]


def test_analyst_can_research_but_not_trade(roles):
    assert client.get("/api/alpha/macro", headers=H(ANALYST)).status_code == 200
    r = client.post("/api/alpha/execute", headers=H(ANALYST), json={"candidate_id": "x:y:z", "environment": "paper"})
    assert r.status_code == 403 and "trader" in r.json()["detail"]
    assert client.post("/api/alpha/monitor", headers=H(ANALYST)).status_code == 403
    q = client.post("/api/alpha/investors/qualify", headers=H(ANALYST), json={"name": "Role Test", "years_documented": 20})
    assert q.status_code == 200


def test_trader_can_execute_paper_but_live_needs_admin(roles):
    r = client.post("/api/alpha/execute", headers=H(TRADER), json={"candidate_id": "nope:nope:nope", "environment": "paper"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"  # authorized, then refused for an unknown candidate
    live = client.post("/api/alpha/execute", headers=H(TRADER), json={"candidate_id": "x:y:z", "environment": "live", "confirm_live": "I AUTHORIZE LIVE ORDER"})
    assert live.status_code == 403 and "admin" in live.json()["detail"]
    adm = client.post("/api/alpha/execute", headers=H(ADMIN), json={"candidate_id": "x:y:z", "environment": "live", "confirm_live": "I AUTHORIZE LIVE ORDER"})
    assert adm.status_code in (200, 403) and "role" not in str(adm.json().get("detail", ""))  # reaches the executor's own live gates


def test_unknown_or_missing_key_is_401_for_every_role(roles):
    for path, body in (("/api/alpha/scan", {"kind": "crypto"}), ("/api/alpha/execute", {"candidate_id": "x:y:z", "environment": "paper"})):
        assert client.post(path, json=body).status_code == 401
        assert client.post(path, json=body, headers=H("wrong-key-0123456789")).status_code == 401


def test_production_without_any_key_is_fail_closed_and_dev_is_open(monkeypatch):
    _use(monkeypatch, app_env="production", api_key=None, alpha_role_keys=None)
    assert client.post("/api/alpha/monitor").status_code == 503
    _use(monkeypatch, app_env="development", api_key=None, alpha_role_keys=None)
    assert client.post("/api/alpha/monitor").status_code == 200
    _use(monkeypatch, app_env="production", api_key=None, alpha_role_keys=f"{ANALYST}:analyst")  # role keys alone are enough
    assert client.get("/api/alpha/macro", headers=H(ANALYST)).status_code == 200


def test_invalid_role_entries_grant_nothing(monkeypatch):
    _use(monkeypatch, app_env="production", api_key=ADMIN, alpha_role_keys="tooshort:trader,garbage")
    assert client.post("/api/alpha/monitor", headers=H("tooshort")).status_code == 401


def test_actions_are_audited_with_role_and_fingerprint_never_the_key(roles):
    client.post("/api/alpha/monitor", headers=H(TRADER))
    client.post("/api/alpha/execute", headers=H(TRADER), json={"candidate_id": "nope:nope:nope", "environment": "paper"})
    db = SessionLocal()
    rows = db.query(AlphaAuditLog).filter(AlphaAuditLog.actor == "api:trader").order_by(AlphaAuditLog.id.desc()).limit(5).all()
    db.close()
    assert {r.action for r in rows} >= {"monitor_requested", "execute_requested"}
    blob = str([r.detail for r in rows])
    assert fingerprint(TRADER) in blob and TRADER not in blob

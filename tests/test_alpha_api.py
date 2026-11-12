import pytest
from fastapi.testclient import TestClient

import app.security.auth as auth
from app.alpha.db_models import AlphaCandidate
from app.alpha.discovery import evaluate_ohlcv
from app.config import Settings
from app.database import SessionLocal, init_db
from app.main import app
from tests.alpha_helpers import make_bars

client = TestClient(app)

READ_ROUTES = ["/api/alpha/overview", "/api/alpha/coverage", "/api/alpha/leaderboard", "/api/alpha/candidates/rejected", "/api/alpha/plans",
               "/api/alpha/predictions", "/api/alpha/strategies", "/api/alpha/strategies/runs",
               "/api/alpha/investors/profiles", "/api/alpha/investors/audit", "/api/alpha/investors/qualifications", "/api/alpha/investors/activity",
               "/api/alpha/whales/labels", "/api/alpha/research/runs", "/api/alpha/audit-log", "/api/alpha/investors/13f/overlap"]


@pytest.fixture(autouse=True)
def _db():
    init_db()


@pytest.mark.parametrize("path", READ_ROUTES)
def test_read_routes_respond(path):
    r = client.get(path)
    assert r.status_code == 200, (path, r.text[:200])


def test_dashboard_page_and_nav():
    r = client.get("/alpha")
    assert r.status_code == 200 and "GLOBAL ALPHA INTELLIGENCE" in r.text
    assert 'href="/alpha"' in client.get("/").text


def test_profile_detail_and_404():
    r = client.get("/api/alpha/investors/profiles/warren_buffett")
    assert r.status_code == 200 and r.json()["audit"]["of"] == 24 and r.json()["history"] == []
    assert client.get("/api/alpha/investors/profiles/nobody_here").status_code == 404
    assert client.get("/api/alpha/candidates/detail", params={"candidate_id": "nope"}).status_code == 404


def test_profiles_endpoint_lists_all_35_foundational():
    rows = client.get("/api/alpha/investors/profiles").json()["profiles"]
    assert sum(1 for r in rows if r["foundational"]) == 35


def test_overview_reports_live_off_and_honest_counts():
    o = client.get("/api/alpha/overview").json()
    assert o["alpha_live_execution_authorized"] is False and o["live_trading_enabled"] is False
    assert o["foundational_profiles"] == 35 and o["executable_modules"] < o["strategy_modules"]


@pytest.fixture()
def locked(monkeypatch):
    s = Settings(app_env="production", api_key="s3cret")
    monkeypatch.setattr(auth, "get_settings", lambda: s)
    return s


MUTATING = [("/api/alpha/scan", {"kind": "crypto"}), ("/api/alpha/validate", {"candidate_id": "x:y:z"}),
            ("/api/alpha/execute", {"candidate_id": "x:y:z", "environment": "paper"}), ("/api/alpha/monitor", None),
            ("/api/alpha/strategies/competition", None),
            ("/api/alpha/strategies/combination", {"a": "turtle_donchian", "b": "seykota_ema"}),
            ("/api/alpha/investors/qualify", {"name": "Test", "years_documented": 20}),
            ("/api/alpha/investors/profile-update", {"trader_id": "ed_thorp", "field": "philosophy", "new_value": "x", "reason": "because", "sources": [{"url": "u", "published": "2020-01-01"}]}),
            ("/api/alpha/investors/13f/sync", {"cik": "1067983"}), ("/api/alpha/research/run", None),
            ("/api/alpha/whales/labels", {"chain": "eth", "address": "0x" + "a" * 40, "label": "L", "entity_type": "exchange", "source": "https://s.example", "confidence": 0.5})]


@pytest.mark.parametrize("path,body", MUTATING)
def test_every_mutating_route_requires_api_key(locked, path, body):
    assert client.post(path, json=body).status_code == 401
    assert client.post(path, json=body, headers={"X-API-Key": "wrong"}).status_code == 401


def test_api_key_unlocks_qualification_and_validation_rules(locked):
    h = {"X-API-Key": "s3cret"}
    r = client.post("/api/alpha/investors/qualify", headers=h, json={"name": "Rich Influencer", "years_documented": 30, "basis_of_nomination": "net_worth",
                                                                     "sources": [{"kind": "fund_letter", "url": "a"}, {"kind": "book", "url": "b"}],
                                                                     "performance_evidence": "audited", "risk_evidence": True, "methodology_documented": True})
    assert r.status_code == 200 and r.json()["status"] == "REJECTED"
    bad = client.post("/api/alpha/investors/profile-update", headers=h, json={"trader_id": "ed_thorp", "field": "id", "new_value": "x", "reason": "because",
                                                                              "sources": [{"url": "u", "published": "2020-01-01"}]})
    assert bad.status_code == 422
    lab = client.post("/api/alpha/whales/labels", headers=h, json={"chain": "eth", "address": "0x" + "b" * 40, "label": "Someone", "entity_type": "individual",
                                                                   "source": "https://rumor.example", "confidence": 0.9, "verified": False})
    assert lab.status_code == 422


def test_live_execute_returns_403_without_authorization():
    s = SessionLocal()
    c = evaluate_ohlcv(s, asset_class="crypto", symbol="APIUSDT", bars=make_bars(220, seed=2, volume=50000), provider="binance_public", exchange="BINANCE")
    cid = c.candidate_id
    s.close()
    r = client.post("/api/alpha/execute", json={"candidate_id": cid, "environment": "live", "confirm_live": "I AUTHORIZE LIVE ORDER"})
    assert r.status_code == 403 and "not authorized" in r.json()["detail"]


def test_candidate_detail_and_leaderboard_roundtrip():
    s = SessionLocal()
    s.query(AlphaCandidate).delete()
    s.commit()
    c = evaluate_ohlcv(s, asset_class="crypto", symbol="RTUSDT", bars=make_bars(250, seed=2, drift=0.003, vol=0.008, volume=50000),
                       provider="binance_public", exchange="BINANCE")
    cid = c.candidate_id
    s.close()
    d = client.get("/api/alpha/candidates/detail", params={"candidate_id": cid}).json()
    assert d["symbol"] == "RTUSDT" and "evidence" in d and d["scores"]["early_alpha_coverage"] is not None
    ids = [x["candidate_id"] for x in client.get("/api/alpha/leaderboard").json()["candidates"]]
    assert cid in ids or d["status"] in ("REJECTED", "INVALIDATED")


def test_whale_analysis_requires_key_and_dashboard_has_no_inline_data_handlers(locked):
    assert client.get("/api/alpha/whales/analysis", params={"chain": "eth", "contract": "0x" + "a" * 40, "price_usd": 1}).status_code == 401
    html = client.get("/alpha").text
    for fn in ("candDetail(", "profile(", "assess(", "strat("):
        assert f"onclick=\"{fn}'" not in html and f"onclick='{fn}" not in html


def test_macro_and_fundamentals_routes_are_key_protected_and_validate(locked):
    assert client.get("/api/alpha/macro").status_code == 401
    assert client.get("/api/alpha/fundamentals/AAPL").status_code == 401
    h = {"X-API-Key": "s3cret"}
    assert client.get("/api/alpha/macro", headers=h).json()["status"] == "not_configured"
    assert client.get("/api/alpha/fundamentals/" + "A" * 30, headers=h).status_code == 422
    assert client.get("/api/alpha/fundamentals/AA$$", headers=h).status_code in (404, 422)


def test_dashboard_sends_api_key_on_reads_and_uses_main_ledger():
    html = client.get("/alpha").text
    assert "if(k)h['X-API-Key']=k" in html and "/api/predictions/metrics" in html


def test_dashboard_shows_discovery_quality_panel():
    html = client.get("/alpha").text
    assert "/api/alpha/performance/discovery" in html and "Discovery quality" in html

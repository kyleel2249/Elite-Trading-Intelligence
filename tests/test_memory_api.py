"""API + adaptive-edge wiring tests for the ETI memory system."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal, init_db
from app.main import app
from app.security.auth import require_api_key


@pytest.fixture(scope="module", autouse=True)
def _schema():
    init_db()


@pytest.fixture
def client():
    app.dependency_overrides[require_api_key] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(require_api_key, None)


def test_overview_lists_every_memory_domain(client):
    r = client.get("/api/memory/overview")
    assert r.status_code == 200
    domains = r.json()["domains"]
    for k in ("trader_profiles", "documented_methodologies", "historical_market_observations", "strategy_configurations",
              "backtesting_results", "previous_signals", "signal_outcomes", "executed_trades", "winning_trades",
              "losing_trades", "market_conditions", "prediction_accuracy_samples", "user_preferences", "risk_limits",
              "strategy_failures", "lessons_learned"):
        assert k in domains, k


def test_split_plan_and_leakage_audit(client):
    plan = client.get("/api/memory/split-plan", params={"n_bars": 100, "embargo_bars": 2}).json()
    assert plan["train"] == [0, 60] and plan["validation"] == [62, 82] and plan["holdout"] == [84, 100]
    assert client.get("/api/memory/split-plan", params={"n_bars": 12, "embargo_bars": 9}).status_code == 422
    audit = client.post("/api/memory/leakage-audit", json={"training_range": [0, 100], "evaluation_range": [50, 150]}).json()
    assert audit["passed"] is False and "evaluation_overlaps_training" in audit["failures"]


def test_entries_versioning_and_protected_risk_limit(client):
    key = f"api-pref-{uuid.uuid4().hex[:8]}"
    r1 = client.post("/api/memory/entries", json={"kind": "user_preference", "key": key, "content": {"risk": "low"}})
    assert r1.status_code == 201 and r1.json()["entry"]["version"] == 1
    r2 = client.post("/api/memory/entries", json={"kind": "user_preference", "key": key, "content": {"risk": "medium"}})
    assert r2.json()["entry"]["version"] == 2
    got = client.get(f"/api/memory/entries/user_preference/{key}").json()
    assert got["entry"]["content"] == {"risk": "medium"} and len(got["history"]) == 2
    assert client.post("/api/memory/entries", json={"kind": "risk_limit", "key": "server_enforced", "content": {"a": 1}}).status_code == 403
    assert client.post("/api/memory/entries", json={"kind": "nonsense", "key": "k", "content": {}}).status_code == 422
    assert client.get("/api/memory/entries/user_preference/does-not-exist").status_code == 404


def test_signal_api_round_trip_and_future_rejection(client):
    sym = f"A{uuid.uuid4().hex[:8]}USDT".upper()
    r = client.post("/api/memory/signals", json={"source": "manual", "symbol": sym, "provider": "binance",
                                                  "direction": "long", "reference_price": 100, "confidence": 64})
    assert r.status_code == 201
    sig = r.json()
    assert sig["horizon_seconds"] and sig["outcome_status"] == "pending"
    assert client.get(f"/api/memory/signals/{sig['signal_id']}").json()["symbol"] == sym
    future = client.post("/api/memory/signals", json={"source": "manual", "symbol": sym, "provider": "binance",
                                                       "direction": "long", "as_of": "2999-01-01T00:00:00Z"})
    assert future.status_code == 422
    premature = client.post(f"/api/memory/signals/{sig['signal_id']}/outcome",
                            json={"outcome_price": 101, "outcome_ts": "2000-01-01T00:00:00Z"})
    assert premature.status_code == 422
    assert client.get("/api/memory/accuracy", params={"symbol": sym}).json()["signals"]["population"]["total"] == 1


def test_strategy_governance_over_http(client):
    sid = "wyckoff_supply_demand"
    base_cfg = {"lookback": 20, "risk_per_trade_pct": 1.0, "fee_bps": 5.0, "avoid_regimes": []}
    created = client.post(f"/api/memory/strategies/{sid}/versions",
                          json={"config": {**base_cfg, "lookback": 30}, "reason": "try longer lookback", "created_by": "bob"})
    assert created.status_code == 201, created.text
    v = created.json()["version"]
    # cannot activate without validation evidence + passing through 'validated'
    bad = client.post(f"/api/memory/strategies/{sid}/versions/{v}/transition", json={"to_status": "active", "actor": "bob"})
    assert bad.status_code == 409
    unvalidated = client.post(f"/api/memory/strategies/{sid}/versions/{v}/transition", json={"to_status": "validated", "actor": "bob"})
    assert unvalidated.status_code == 409
    assert client.post(f"/api/memory/strategies/{sid}/versions/999/transition", json={"to_status": "rejected", "actor": "bob"}).status_code == 404
    listed = client.get("/api/memory/strategies").json()
    assert any(s["strategy_id"] == sid for s in listed["strategies"])
    susp = client.post(f"/api/memory/strategies/{sid}/suspension", json={"suspended": True, "actor": "bob", "reason": "manual review"})
    assert susp.status_code == 200 and susp.json()["suspended"] is True
    client.post(f"/api/memory/strategies/{sid}/suspension", json={"suspended": False, "actor": "bob", "reason": "review done"})


def test_mutations_require_api_key_when_configured(monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("API_KEY", "secret-test-key")
    get_settings.cache_clear()
    try:
        c = TestClient(app)
        r = c.post("/api/memory/entries", json={"kind": "user_preference", "key": "k", "content": {}})
        assert r.status_code in (401, 403)
        assert c.get("/api/memory/overview").status_code == 200
    finally:
        monkeypatch.delenv("API_KEY", raising=False)
        get_settings.cache_clear()


# ----------------------------------------------------------------------------- adaptive-edge repair
def test_adaptive_edge_package_imports_and_runs_a_cycle():
    from app.adaptive_edge.orchestrator import AdaptiveEdgeOrchestrator
    from app.memory.models import RegimeObservation

    closes = [100 + i * 0.5 + (i % 3) * 0.2 for i in range(150)]
    sym = f"W{uuid.uuid4().hex[:8]}USDT".upper()
    db = SessionLocal()
    try:
        res = AdaptiveEdgeOrchestrator(db).run_cycle(sym, "binance", closes, strategy_trades={"turtle_trend": []})
        assert res.regime["primary_regime"] and res.portfolio_plan["requires_risk_checks"] is True
        assert res.strategy_health["turtle_trend"]["status"] == "UNDER_VALIDATION"
        assert db.query(RegimeObservation).filter(RegimeObservation.symbol == sym).count() == 1
        snap = AdaptiveEdgeOrchestrator(db).dashboard_snapshot()
        assert snap["governance"]["authorize_live_deployment"] is False
    finally:
        db.close()


def test_research_lab_never_enters_live_stages():
    from app.adaptive_edge.research_lab import StrategyResearchLab

    lab = StrategyResearchLab()
    c = lab.create_candidate({"hypothesis_id": "h1", "title": "t", "category": "technical", "measurable_claim": "x"})
    assert lab.advance(c.candidate_id).to_stage == "RESEARCH"
    assert lab.get(c.candidate_id).stage == "RESEARCH"
    lab.advance(c.candidate_id)
    assert lab.get(c.candidate_id).stage == "DEVELOPMENT"
    c2 = lab.get(c.candidate_id)
    c2.stage = "PAPER_TRADING"
    c2.paper_metrics = {"trades": 20, "profit_factor": 2.0, "total_return_pct": 5.0}
    lab._persist(c2)
    decision = lab.advance(c.candidate_id)
    assert decision.requires_user_authorization is True
    assert lab.get(c.candidate_id).stage == "PAPER_TRADING"

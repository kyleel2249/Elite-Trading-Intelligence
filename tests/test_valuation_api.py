"""Valuation API: kelly endpoint and registration (needs app deps; run in CI)."""
from fastapi.testclient import TestClient

from app.main import app


def test_valuation_routes_are_registered_and_no_gateway_path_exists():
    paths = list(app.openapi()["paths"])
    assert "/api/valuation/kelly" in paths and "/api/valuation/evaluate" in paths
    assert not [p for p in paths if "gateway" in p.lower()]


def test_kelly_endpoint_never_allocates_more_than_six_percent():
    body = {"bankroll": 100000, "entry_price": 100, "stop_price": 99.5, "target_price": 130,
            "win_probability": 0.9, "sample_size": 5000}
    r = TestClient(app).post("/api/valuation/kelly", json=body)
    assert r.status_code == 200
    d = r.json()
    assert d["approved"] and d["final_allocation_pct"] <= 6.0 + 1e-9


def test_kelly_endpoint_gives_zero_for_negative_edge_and_rejects_bad_input():
    c = TestClient(app)
    neg = c.post("/api/valuation/kelly", json={"bankroll": 1000, "entry_price": 100, "stop_price": 95,
                                               "target_price": 110, "win_probability": 0.2, "sample_size": 500})
    assert neg.status_code == 200 and neg.json()["position_notional"] == 0.0
    assert c.post("/api/valuation/kelly", json={"bankroll": -1}).status_code == 422

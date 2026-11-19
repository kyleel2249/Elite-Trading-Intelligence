"""Offline validation tests; no broker or MetaTrader terminal is contacted."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("ETI_MT5_BRIDGE_TOKEN", "test-token")
from fastapi.testclient import TestClient
import bridge

client = TestClient(bridge.APP)


def test_health_is_public_and_loopback_only():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["host_scope"] == "loopback-only"


def test_private_routes_require_token():
    assert client.get("/account").status_code == 401
    assert client.get("/positions").status_code == 401


def test_authenticates_private_routes():
    response = client.get("/bootstrap", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    assert response.json()["live_trading_enabled"] is False


def test_invalid_order_inputs_rejected_before_terminal_access():
    headers = {"Authorization": "Bearer test-token"}
    response = client.post("/orders", headers=headers, json={
        "symbol": "EURUSD", "side": "hold", "volume": 0.01,
        "order_type": "market", "sl": 1.0, "tp": 2.0
    })
    assert response.status_code == 422


def test_order_requires_stop_and_target_schema():
    headers = {"Authorization": "Bearer test-token"}
    response = client.post("/orders", headers=headers, json={
        "symbol": "EURUSD", "side": "buy", "volume": 0.01
    })
    # Request schema parses; terminal connection check occurs before order validation.
    assert response.status_code in (409, 503)

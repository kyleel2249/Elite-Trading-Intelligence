"""Regression tests: HTML dashboards must render (Starlette 1.x TemplateResponse signature)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    # No `with` block: skip lifespan so tests never open live WebSocket streams.
    return TestClient(app)


@pytest.mark.parametrize("path,marker", [("/", "ETI"), ("/data-intel", "Command"), ("/alerts", "Alerts")])
def test_dashboard_pages_render(client, path, marker):
    r = client.get(path)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert marker in r.text
    assert "{{" not in r.text and "{%" not in r.text


def test_health(client):
    r = client.get("/api/system/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


@pytest.mark.parametrize("qs", ["limit=0", "limit=100000", "interval=bad!"])
def test_history_params_are_bounded(client, qs):
    assert client.get(f"/api/market/history?{qs}").status_code == 422


def test_order_book_depth_bounded(client):
    assert client.get("/api/market/order-book?depth=100000").status_code == 422

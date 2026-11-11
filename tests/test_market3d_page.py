"""The 3D market view is served, self-contained, and never fabricates market data."""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    # No `with` block: skip lifespan so tests never open live WebSocket streams.
    return TestClient(app)


def test_page_is_served_and_uses_only_local_scripts(client):
    r = client.get("/static/market3d.html")
    assert r.status_code == 200
    assert "3D Market View" in r.text
    srcs = re.findall(r'<script[^>]+src="([^"]+)"', r.text)
    assert srcs == ["/static/market3d.js"], f"unexpected script sources: {srcs}"
    assert "{{" not in r.text and "{%" not in r.text


def test_script_reads_real_history_endpoint_and_never_invents_data(client):
    r = client.get("/static/market3d.js")
    assert r.status_code == 200
    js = r.text
    assert "/api/market/history" in js
    assert "Math.random" not in js, "the 3D view must not generate synthetic market data"
    assert "unavailable" in js and "STALE" in js  # failure and staleness are surfaced, not hidden


def test_history_endpoint_the_view_depends_on_is_registered(client):
    assert "/api/market/history" in app.openapi()["paths"]

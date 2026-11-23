"""The 2D market view is served and never fabricates market data."""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    # Skip lifespan so tests never open live WebSocket streams.
    return TestClient(app)


def test_2d_page_is_served_and_uses_only_local_scripts(client):
    r = client.get("/static/market2d.html")
    assert r.status_code == 200
    assert "2D Market View" in r.text
    srcs = re.findall(r'<script[^>]+src="([^"]+)"', r.text)
    assert srcs == ["/static/market2d.js"], f"unexpected script sources: {srcs}"
    assert "{{" not in r.text and "{%" not in r.text


def test_legacy_market3d_path_now_serves_2d_view(client):
    r = client.get("/static/market3d.html")
    assert r.status_code == 200
    assert "2D Market View" in r.text
    assert "3D" not in r.text and "rotate" not in r.text.lower()


def test_market_selector_offers_every_supported_market(client):
    html = client.get("/static/market2d.html").text
    for value in ("bybit", "bitget", "binance", "okx", "alpaca", "oanda", "twelvedata"):
        assert f'<option value="{value}"' in html
    js = client.get("/static/market2d.js").text
    for value in ("bybit", "bitget", "binance", "okx", "alpaca", "oanda", "twelvedata"):
        assert value in js
    assert "unifiedVenue(prov)" in js
    assert "/api/market/klines?venue=" in js
    assert "STALE: keeping the last verified" in js


def test_script_reads_real_history_endpoint_and_never_invents_data(client):
    js = client.get("/static/market2d.js").text
    assert "/api/market/public-history" in js and "/api/market/symbols" in js
    assert "Math.random" not in js
    assert "unavailable" in js and "STALE" in js
    assert "getContext('2d')" in js
    assert "WebGL" not in js and "projection" not in js.lower()


def test_history_endpoint_the_view_depends_on_is_registered(client):
    paths = app.openapi()["paths"]
    assert "/api/market/public-history" in paths and "/api/market/symbols" in paths


def test_intelligence_visuals_are_canvas_2d_only():
    root = Path(__file__).resolve().parents[1]
    scenes = (root / "app" / "static" / "scenes.js").read_text()
    template = (root / "app" / "templates" / "intelligence_centre.html").read_text()
    assert "getContext('2d')" in scenes
    assert "function providerMap(" in scenes
    assert "ETIScenes.providerMap(" in template
    assert "THREE.WebGLRenderer" not in scenes
    assert "getContext('webgl')" not in scenes
    assert "three.min.js" not in template.lower()
    assert "WebGLRenderer" not in template

"""Repository integrity guards: catch the failure modes that have already happened once.

* parallel Alembic migrations that fork the history (multiple heads break `alembic upgrade head`)
* app/main.py being overwritten by a stale copy, silently dropping routers and pages

Routes are probed the way a client sees them (HTTP requests + the OpenAPI schema), not via `app.routes`:
recent FastAPI/Starlette versions do not expose included routers' paths as flat `app.routes` entries.
"""
from __future__ import annotations

import ast
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]


def _migrations() -> dict:
    out: dict = {}
    for f in sorted((ROOT / "alembic" / "versions").glob("*.py")):
        vals = {}
        for node in ast.parse(f.read_text()).body:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                target = node.targets[0] if isinstance(node, ast.Assign) else node.target
                if isinstance(target, ast.Name) and target.id in ("revision", "down_revision") and node.value is not None:
                    vals[target.id] = ast.literal_eval(node.value)
        if "revision" in vals:
            out[vals["revision"]] = vals.get("down_revision")
    return out


def test_alembic_has_a_single_head_and_no_dangling_parents():
    migrations = _migrations()
    parents: set = set()
    for down in migrations.values():
        if down is None:
            continue
        parents.update([down] if isinstance(down, str) else down)
    heads = sorted(r for r in migrations if r not in parents)
    assert len(heads) == 1, f"Alembic has multiple heads: {heads}. Add a merge revision."
    assert parents <= set(migrations), f"Migrations reference unknown parents: {parents - set(migrations)}"


def test_pages_and_ledger_routes_are_served():
    from app.main import app

    client = TestClient(app)
    for page in ("/", "/predictions", "/markets", "/api/system/health", "/api/predictions/metrics", "/api/predictions/reports"):
        r = client.get(page)
        assert r.status_code == 200, f"{page} returned {r.status_code}: router/page not wired into app.main?"
    # A route that exists but has no such record answers with its own 404 message, unlike an unmatched path.
    r = client.get("/api/predictions/does-not-exist/verify")
    assert r.status_code == 404 and r.json().get("detail") == "Prediction not found"


def test_feature_routers_are_included_in_main():
    from app.main import app

    paths = set(app.openapi()["paths"])
    assert "/api/intelligence/forecast" in paths
    for prefix in ("/api/predictions", "/api/strategies", "/api/adaptive-edge", "/api/memory"):
        assert any(p.startswith(prefix) for p in paths), f"no routes under {prefix}: router not included in app.main"

"""Repository integrity guards: catch the failure modes that have already happened once.

* parallel Alembic migrations that fork the history (multiple heads break `alembic upgrade head`)
* app/main.py being overwritten by a stale copy, silently dropping routers and pages
"""
from __future__ import annotations

import ast
from pathlib import Path

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


def test_expected_routes_are_wired_into_main():
    from app.main import app

    paths = {getattr(r, "path", "") for r in app.routes}
    expected = {"/", "/predictions", "/markets", "/api/system/health", "/api/intelligence/forecast",
                "/api/predictions/metrics", "/api/predictions/{uid}/verify"}
    assert not (expected - paths), f"routes missing from app.main: {sorted(expected - paths)}"
    for prefix in ("/api/strategies", "/api/adaptive-edge", "/api/memory"):
        assert any(p.startswith(prefix) for p in paths), f"no routes under {prefix}: router not included in app.main"

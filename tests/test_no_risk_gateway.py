"""ETI has no external risk gateway. These tests keep it that way: no code, template, config or route may depend on one.

Orders are checked in-process (the Python RiskEngine and the Cloudflare Worker's own safeguards). The only allowed
mentions are explanatory text in docs/ and README.md saying that no gateway exists.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = re.compile(r"risk[-_ ]?gateway|RISK_GATE_(URL|TOKEN)", re.IGNORECASE)
SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".pytest_cache", ".wrangler"}


def _files(*roots: str, suffixes: tuple[str, ...]):
    for root in roots:
        base = ROOT / root
        paths = [base] if base.is_file() else sorted(p for p in base.rglob("*") if p.is_file())
        for p in paths:
            if SKIP_DIRS.isdisjoint(p.parts) and p.suffix in suffixes:
                yield p


def test_python_app_has_no_gateway_references():
    hits = [str(p.relative_to(ROOT)) for p in _files("app", suffixes=(".py", ".html", ".js", ".json", ".sql"))
            if FORBIDDEN.search(p.read_text(encoding="utf-8", errors="ignore"))]
    assert not hits, f"risk gateway referenced in: {hits}"


def test_config_and_workflows_do_not_configure_a_gateway():
    names = [".env.example", ".dev.vars.example", "wrangler.jsonc"]
    paths = [ROOT / n for n in names if (ROOT / n).exists()] + list(_files(".github", suffixes=(".yml", ".yaml")))
    # .dev.vars.example may say "No risk gateway is used"; it must never define a gateway variable.
    hits = [str(p.relative_to(ROOT)) for p in paths if re.search(r"RISK_GATE_(URL|TOKEN)", p.read_text(encoding="utf-8", errors="ignore"))]
    assert not hits, f"gateway variables configured in: {hits}"


def test_settings_have_no_gateway_fields():
    from app.config import Settings

    assert not [f for f in Settings.model_fields if "gateway" in f.lower()]


def test_no_route_exposes_a_gateway():
    from app.main import app

    paths = list(app.openapi()["paths"])  # include_router may nest routes, so read the generated schema
    assert not [p for p in paths if "gateway" in p.lower()]
    assert "/api/pretrade/check" in paths  # the dry-run check that replaced the old preflight endpoint

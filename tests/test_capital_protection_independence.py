"""Structural guarantees that keep the Capital Protection System independent of AI and signal code.

These tests parse source files (no imports of the application), so they hold even if a dependency is broken.
"""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RISK = ROOT / "app" / "risk"

# Code that generates opinions or signals. The protection system must never import it.
FORBIDDEN = ("app.intelligence", "app.adaptive_edge", "app.backtest", "app.knowledge", "app.streaming", "openai", "anthropic")
PURE_MODULES = ("protection.py", "protection_policy.py", "quarantine.py", "data_integrity.py")
OVERRIDE_WORDS = ("override", "bypass", "skip", "disable", "ignore", "force", "waive")


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
    return found


def test_protection_modules_do_not_import_model_or_signal_code():
    for name in PURE_MODULES + ("protection_service.py",):
        for mod in _imports(RISK / name):
            assert not mod.startswith(FORBIDDEN), f"{name} imports {mod}"


def test_decision_core_is_dependency_free():
    allowed_app = ("app.risk.",)
    for name in PURE_MODULES:
        for mod in _imports(RISK / name):
            if mod.startswith("app."):
                assert mod.startswith(allowed_app), f"{name} depends on {mod}"
            assert mod not in ("sqlalchemy", "requests", "httpx", "fastapi"), f"{name} performs I/O via {mod}"


def _field_names(path: Path, class_name: str) -> list[str]:
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return [n.target.id for n in node.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)]
    raise AssertionError(class_name)


def test_no_override_fields_on_policy_or_order_intent():
    for path, cls in ((RISK / "protection_policy.py", "ProtectionPolicy"), (RISK / "protection.py", "OrderIntent")):
        for field in _field_names(path, cls):
            assert not any(w in field.lower() for w in OVERRIDE_WORDS), f"{cls}.{field} looks like an override"


def test_place_order_has_no_override_parameter():
    tree = ast.parse((ROOT / "app" / "trading" / "service.py").read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "place_order")
    params = [a.arg for a in fn.args.kwonlyargs + fn.args.args]
    assert not [p for p in params if any(w in p.lower() for w in OVERRIDE_WORDS)], params
    src = (ROOT / "app" / "trading" / "service.py").read_text()
    assert "CapitalProtectionService" in src and "verdict.approved" in src


def test_every_provider_submission_site_is_gated():
    """Only TradingService and the execution engine may call a broker's submit_order, and each runs the gate first."""
    callers = []
    for path in (ROOT / "app").rglob("*.py"):
        if ".submit_order(" in path.read_text():
            callers.append(path.relative_to(ROOT).as_posix())
    assert sorted(callers) == ["app/execution/engine.py", "app/trading/service.py"], callers
    # TradingService runs CapitalProtectionService before any submission ...
    trading = (ROOT / "app" / "trading" / "service.py").read_text()
    assert trading.index("check_order(intent") < trading.index(".submit_order(")
    # ... and the execution engine is only ever built with a risk gate that consults Capital Protection.
    wiring = (ROOT / "app" / "execution" / "service.py").read_text()
    assert "CapitalProtectionService" in wiring and "risk_gate=risk_gate" in wiring
    assert "verdict.approved" in wiring and "check_with_account" in wiring
    engine = (ROOT / "app" / "execution" / "engine.py").read_text()
    assert "if self.risk_gate is None:" in engine and "live execution refused" in engine  # fail closed on live


def test_policy_comes_only_from_server_settings():
    src = (RISK / "protection_service.py").read_text()
    assert "policy_from_settings(self.settings)" in src
    api = (ROOT / "app" / "api" / "capital_protection.py").read_text()
    assert "policy_from_settings" not in api and "ProtectionPolicy(" not in api  # no request can build a policy


def test_loosening_routes_require_the_admin_key():
    api = (ROOT / "app" / "api" / "capital_protection.py").read_text()
    tree = ast.parse(api)
    loosening = {"reset_halt", "replace_calendar", "register_strategy", "begin_review",
                 "approve_revalidation", "complete_revalidation"}
    tightening_or_read = {"status", "evaluate", "size", "sweep", "halt", "strategies", "strategy",
                          "evaluate_strategy", "quarantine_strategy", "audit"}
    seen = set()
    for node in tree.body:
        if isinstance(node, ast.AsyncFunctionDef):
            deps = ast.unparse(node.args)
            seen.add(node.name)
            if node.name in loosening:
                assert "require_admin" in deps, node.name
            if node.name in tightening_or_read:
                assert "require_admin" not in deps, node.name
    assert loosening <= seen


def test_every_policy_limit_is_configurable_from_settings():
    """Each HARD_LIMITS entry must have a matching cps_* Settings field, and every cps_* field must be documented."""
    cfg = ast.parse((ROOT / "app" / "config.py").read_text())
    settings_cls = next(n for n in cfg.body if isinstance(n, ast.ClassDef) and n.name == "Settings")
    fields = {n.target.id for n in settings_cls.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)}
    src = (RISK / "protection_policy.py").read_text()
    names = [line.split('"')[1] for line in src.splitlines() if line.strip().startswith('"') and '": (' in line]
    assert len(names) >= 19
    for name in names:
        assert f"cps_{name}" in fields, f"Settings.cps_{name} missing"
    env_example = (ROOT / ".env.example").read_text()
    for field in (f for f in fields if f.startswith("cps_")):
        assert field.upper() in env_example, f"{field.upper()} missing from .env.example"

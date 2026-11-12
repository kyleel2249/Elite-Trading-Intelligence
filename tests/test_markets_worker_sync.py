"""The Worker's generated data and golden vectors must match what the Python layer produces right now."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _exporter():
    spec = importlib.util.spec_from_file_location("export_markets", ROOT / "scripts" / "export_markets.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_worker_generated_files_are_current():
    m = _exporter()
    assert (ROOT / "worker" / "markets.generated.json").read_text(encoding="utf-8") == m.render(m.build_data()), \
        "worker/markets.generated.json is stale: run `python scripts/export_markets.py`"
    assert (ROOT / "worker" / "markets.golden.json").read_text(encoding="utf-8") == m.render(m.build_golden()), \
        "worker/markets.golden.json is stale: run `python scripts/export_markets.py`"

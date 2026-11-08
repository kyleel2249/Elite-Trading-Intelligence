"""Export the Python knowledge registry (traders + strategy modules) to JSON for the Cloudflare Worker.

Single source of truth: app/knowledge/*. Run via scripts/build-knowledge.mjs (wrangler build step / npm pretest).
"""
import datetime
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))

from app.knowledge.registry import list_traders  # noqa: E402
from app.knowledge.strategies import STRATEGY_MODULES  # noqa: E402

payload = {
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "source": "python-registry",
    "profiles": list_traders(),
    "strategies": [m.to_dict() for m in STRATEGY_MODULES.values()],
}
target = root / "worker" / "knowledge.generated.json"
target.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("[knowledge] exported %d profiles and %d strategy modules -> %s" % (len(payload["profiles"]), len(payload["strategies"]), target.name))

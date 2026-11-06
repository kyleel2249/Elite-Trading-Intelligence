#!/usr/bin/env python3
"""Minimal e2e smoke against a running ETI instance."""
import os
import sys
import urllib.request
import json

BASE = os.environ.get("ETI_BASE", "http://127.0.0.1:8000")


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read().decode())


def main() -> int:
    h = get("/api/system/health")
    assert h.get("status") == "ok", h
    k = get("/api/knowledge/traders")
    assert k.get("count", 0) >= 20 or len(k.get("traders") or []) >= 20
    t = get("/api/intelligence/traders")
    names = {x.get("name") for x in t.get("traders") or []}
    assert "Helena Frost" in names
    assert "Adrian Cole" in names
    print("e2e smoke OK", {"health": h.get("status"), "knowledge": k.get("count"), "desk": len(names)})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print("e2e smoke FAILED", e, file=sys.stderr)
        raise SystemExit(1)

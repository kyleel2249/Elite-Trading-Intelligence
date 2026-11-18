#!/usr/bin/env python3
"""Deployment validation for the analytics integrations.

Usage:  ETI_BASE_URL=https://your-backend ETI_API_KEY=... python scripts/verify_deployment.py [--no-verify]
1. GET  /api/analytics/intel/health-center           (no secrets needed)
2. POST /api/analytics/intel/health-center/verify    (needs ETI_API_KEY; real provider requests, spends a little quota)
Exit 0 only when every CONFIGURED integration is 'ok'. Missing optional credentials do not fail the check.
Never prints credentials. Uses only the standard library.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("ETI_BASE_URL", "").rstrip("/")
KEY = os.environ.get("ETI_API_KEY", "")
HC = "/api/analytics/intel/health-center"


def call(method: str, path: str, key: str = "") -> dict:
    req = urllib.request.Request(BASE + path, method=method, headers={"accept": "application/json", **({"X-API-Key": key} if key else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} failed: HTTP {e.code}")
    except Exception as e:
        raise SystemExit(f"{method} {path} failed: {type(e).__name__}")


def main() -> int:
    if not BASE:
        print("Set ETI_BASE_URL")
        return 2
    verify = "--no-verify" not in sys.argv
    data = call("POST", HC + "/verify", KEY) if verify and KEY else call("GET", HC)
    if verify and not KEY:
        print("ETI_API_KEY not set: showing current state without forcing verification")
    bad = 0
    for i in data["integrations"]:
        flag = "OK  " if i["status"] == "ok" else ("SKIP" if not i["configured"] else "FAIL")
        if flag == "FAIL":
            bad += 1
        access = i["subscription_access"]
        print(f"{flag} {i['id']:<12} status={i['status']:<22} access={access['level']:<8} last_success={i['last_success']}")
        for ep, st in (access.get("endpoints") or {}).items():
            print(f"       {ep}: {st}")
    print(f"\nconfigured={data['summary']['configured']} operational={data['summary']['operational']} missing={[m['env'] for m in data['summary']['missing_credentials']]}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

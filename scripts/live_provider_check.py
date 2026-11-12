#!/usr/bin/env python3
"""Live, read-only connectivity check for ETI intelligence providers.

Usage:  FMP_API_KEY=... TOKENOMIST_API_KEY=... PYTHONPATH=. python scripts/live_provider_check.py
Classifies each provider endpoint PASS / BLOCKED (no key or plan access) / FAIL and exits non-zero on FAIL.
It only reads data, never places orders, and never prints keys. Real requests spend a little provider quota
(Tokenomist: 1 credit).
"""
import asyncio
import json
import sys

from app.providers.registry import Registry, ProviderSettings


def classify(result: dict) -> str:
    st = result.get("status")
    if st == "ok":
        return "PASS" if result.get("rows", 1) is not None else "PARTIAL"
    if st in ("not_configured", "plan_restricted"):
        return "BLOCKED"
    return "FAIL"


async def main() -> int:
    reg = Registry(ProviderSettings())
    report, failed = {}, False
    for name, client in (("fmp", reg.fmp), ("tokenomist", reg.tokenomist)):
        if not client.configured:
            report[name] = {"_": {"status": "not_configured", "class": "BLOCKED"}}
            continue
        probe = await client.probe()
        report[name] = {ep: {**r, "class": classify(r)} for ep, r in probe.items()}
        failed |= any(v["class"] == "FAIL" for v in report[name].values())
    report["whale_alert"] = {"_": {"status": "not_built", "class": "NOT BUILT"}}
    print(json.dumps(report, indent=2, default=str))
    print("\nprovider health:", json.dumps(reg.status(), indent=2, default=str))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

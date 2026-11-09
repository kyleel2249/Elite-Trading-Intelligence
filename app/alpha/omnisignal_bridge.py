"""Bridge to the Worker's OMNISIGNAL X engines (Swift-inspired + GainzAlgo-inspired + fusion + validator).

Those engines are TypeScript in worker/algo/ and are exposed read-only at GET /api/omnisignal. This bridge
fetches that result and converts it into structured EngineEvidence for the Decision layer. It is analytical
only: the Worker endpoint cannot place orders, and the bridge never forwards credentials.
Applies to crypto symbols the Worker can load (Binance spot symbols such as BTCUSDT)."""
from __future__ import annotations

import re
from typing import Any, Optional

import httpx

_SYMBOL = re.compile(r"^[A-Z0-9]{5,20}$")
STRATEGY_FOR_DAILY = "swing"


async def fetch_omnisignal(base_url: Optional[str], symbol: str, strategy: str = STRATEGY_FOR_DAILY,
                           client: Optional[httpx.AsyncClient] = None, timeout: float = 20.0) -> Optional[dict[str, Any]]:
    if not base_url or not _SYMBOL.match(symbol.upper()):
        return None
    url = f"{base_url.rstrip('/')}/api/omnisignal"
    params = {"symbol": symbol.upper(), "strategy": strategy, "engines": "swift,gainz"}
    try:
        if client is not None:
            r = await client.get(url, params=params)
        else:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.get(url, params=params)
        body = r.json()
    except (httpx.HTTPError, ValueError):
        return {"decision": "DATA_UNRELIABLE", "error": "omnisignal_unreachable"}
    if not isinstance(body, dict) or "decision" not in body:
        return {"decision": "DATA_UNRELIABLE", "error": "unexpected_response"}
    return body


def summarize(result: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Compact, JSON-safe view stored in evidence (no raw worker payload is trusted beyond these fields)."""
    if not result:
        return {"available": False}
    fusion = result.get("fusion") or {}
    val = result.get("validation") or {}
    return {"available": result.get("decision") != "DATA_UNRELIABLE", "decision": result.get("decision"),
            "confidence_heuristic": result.get("confidence"), "agreement": fusion.get("agreement"),
            "accepted_engine": fusion.get("acceptedEngine"), "classification": val.get("classification"),
            "hard_failures": list(val.get("hardFailures") or [])[:5], "strategy": result.get("strategy"),
            "confidence_type": "heuristic_score_not_probability"}

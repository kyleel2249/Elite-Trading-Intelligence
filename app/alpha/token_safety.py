"""Heuristic token / pair risk screen for DEX assets.

This is NOT a smart-contract audit. Output is never "safe": the best verdict is
NO_FLAGS_FOUND, and unverifiable items are listed as unknowns.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


def _num(x: Any) -> Optional[float]:
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def screen_dex_pair(pair: dict[str, Any], *, min_liquidity_usd: float = 25_000.0,
                    min_age_hours: float = 24.0, now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    liq = _num((pair.get("liquidity") or {}).get("usd"))
    vol24 = _num((pair.get("volume") or {}).get("h24"))
    fdv = _num(pair.get("fdv"))
    tx = (pair.get("txns") or {}).get("h24") or {}
    buys, sells = _num(tx.get("buys")), _num(tx.get("sells"))
    created_ms = _num(pair.get("pairCreatedAt"))
    flags: list[dict[str, str]] = []
    unknown = ["contract verification", "holder concentration", "owner privileges / mint rights", "lp lock status"]
    hard = False

    def flag(code: str, level: str, msg: str) -> None:
        nonlocal hard
        flags.append({"code": code, "level": level, "message": msg})
        if level == "HARD":
            hard = True

    if liq is None:
        flag("LIQUIDITY_UNKNOWN", "HARD", "liquidity not reported")
    elif liq < min_liquidity_usd:
        flag("ILLIQUID", "HARD", f"liquidity ${liq:,.0f} below ${min_liquidity_usd:,.0f}")
    if liq and vol24 is not None and liq > 0 and vol24 / liq > 20:
        flag("VOLUME_VS_LIQUIDITY", "SOFT", f"24h volume is {vol24 / liq:.0f}x liquidity (possible wash/artificial volume)")
    if liq and fdv and fdv / liq > 2000:
        flag("THIN_LIQUIDITY_VS_FDV", "SOFT", f"FDV is {fdv / liq:,.0f}x liquidity")
    if created_ms:
        age_h = (now.timestamp() * 1000 - created_ms) / 3_600_000
        if age_h < 1:
            flag("BRAND_NEW_PAIR", "HARD", "pair is under 1 hour old")
        elif age_h < min_age_hours:
            flag("YOUNG_PAIR", "SOFT", f"pair is {age_h:.1f}h old")
    else:
        unknown.append("pair age")
    if buys is not None and sells is not None:
        if buys >= 50 and sells == 0:
            flag("NO_SELLS_OBSERVED", "HARD", "many buys and zero sells: honeypot pattern suspected")
        elif sells > 0 and buys / sells > 15 and buys >= 100:
            flag("EXTREME_BUY_SKEW", "SOFT", "buy/sell count extremely skewed")
    top10 = _num((pair.get("_holders") or {}).get("top10_pct"))
    if top10 is None:
        pass
    elif top10 > 80:
        flag("HOLDER_CONCENTRATION", "HARD", f"top-10 holders own {top10:.0f}%")
    elif top10 > 50:
        flag("HOLDER_CONCENTRATION", "SOFT", f"top-10 holders own {top10:.0f}%")
    else:
        unknown.remove("holder concentration")
    verdict = "BLOCKED" if hard else ("HIGH_RISK" if sum(1 for x in flags if x["level"] == "SOFT") >= 2
                                      else "CAUTION" if flags else "NO_FLAGS_FOUND")
    return {"verdict": verdict, "hard_fail": hard, "flags": flags, "unverified": unknown,
            "disclaimer": "Heuristic screen only; not a contract audit and never a safety guarantee."}

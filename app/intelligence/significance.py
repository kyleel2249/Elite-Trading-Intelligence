"""Research-priority significance and cross-investor consensus (not price prediction)."""
from __future__ import annotations

from collections import Counter
from typing import Any


def score_significance(act: dict[str, Any]) -> str:
    """
    Classify research priority only.
    CRITICAL/HIGH/MODERATE/LOW/INFORMATIONAL — never a trade instruction.
    """
    cat = (act.get("category") or "").lower()
    direction = (act.get("direction") or "").lower()
    amount = str(act.get("amount_or_range") or "").lower()
    verification = (act.get("verification_status") or "").upper()

    if verification in ("UNCONFIRMED", "DISPUTED", "INSUFFICIENT_INFORMATION"):
        return "INFORMATIONAL"

    high_amount = any(x in amount for x in ("500,000", "1,000,000", "million", "$1m", "1000000"))
    mid_amount = any(x in amount for x in ("100,000", "250,000", "50,000", "$100"))

    if cat in ("activist", "major_announcement") and verification.startswith("VERIFIED"):
        return "CRITICAL"
    if cat == "congressional_trade" and high_amount and direction in ("buy", "sell"):
        return "HIGH"
    if cat == "congressional_trade" and mid_amount:
        return "MODERATE"
    if cat in ("insider_purchase", "insider_buy") and direction == "buy":
        return "HIGH" if high_amount else "MODERATE"
    if cat in ("government_contract", "lobbying"):
        return "INFORMATIONAL"
    if cat in ("13f_holding", "institutional_holding"):
        # Explicitly historical snapshot
        return "MODERATE" if high_amount else "LOW"
    if direction in ("buy", "sell"):
        return "MODERATE"
    return "INFORMATIONAL"


def consensus_report(activities: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Detect tickers with multiple independent disclosed activities.
    Does not assert shared thesis.
    """
    by_ticker: dict[str, list[dict[str, Any]]] = {}
    for a in activities:
        t = (a.get("ticker") or "").upper()
        if not t:
            continue
        by_ticker.setdefault(t, []).append(a)

    multi = []
    for t, rows in by_ticker.items():
        actors = {(r.get("investor_name") or r.get("institution") or "?") for r in rows}
        dirs = Counter((r.get("direction") or "unknown").lower() for r in rows)
        if len(actors) >= 2 or len(rows) >= 3:
            multi.append(
                {
                    "ticker": t,
                    "activity_count": len(rows),
                    "unique_actors": sorted(actors)[:12],
                    "direction_counts": dict(dirs),
                    "note": "Multiple disclosures observed — not proof of coordinated thesis",
                    "research_priority": "HIGH" if len(actors) >= 3 else "MODERATE",
                }
            )
    multi.sort(key=lambda x: -x["activity_count"])
    return {
        "tickers_with_overlap": multi[:30],
        "disclaimer": "Consensus is disclosure overlap, not a trading signal. Helena Frost gates orders.",
        "desk": {"strategist": "Adrian Cole", "auditor": "Claire Bennett", "risk": "Helena Frost"},
    }

"""Maps normalised provider events to the Worker readiness engine's event-feed JSON (docs/READINESS.md).

The readiness engine reads ETI_EVENT_FEED_URL and expects rows: {title, time (ISO), impact: low|medium|high,
category: economic|central_bank|geopolitical|fundamental|earnings|other, currency}. Rows with an unrecognised impact
are dropped and counted, never defaulted: assuming "low" would silently weaken a blackout rule.
Earnings are not exported: the provider gives a date, not a release time, and a made-up time would create false danger zones.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

IMPACTS = {"low", "medium", "high"}
CATEGORY = {"rate_decision": "central_bank", "central_bank": "central_bank"}


def to_readiness_events(events: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    rows, skipped = [], 0
    for e in events:
        impact = str(e.get("impact") or "").lower()
        if impact not in IMPACTS or not e.get("timestamp_utc") or not e.get("event"):
            skipped += 1
            continue
        t = str(e["timestamp_utc"]).replace("+00:00", "Z")
        row = {"title": e["event"], "time": t, "impact": impact, "category": CATEGORY.get(e.get("category"), "economic")}
        if e.get("currency"):
            row["currency"] = str(e["currency"]).upper()
        rows.append(row)
    rows.sort(key=lambda r: r["time"])
    return {"events": rows, "skipped_unrecognised_impact_or_malformed": skipped}

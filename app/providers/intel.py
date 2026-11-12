"""Turns raw provider data into risk context. Pure functions; thresholds are heuristics, stated in the output."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Sequence

CURRENCY_BY_QUOTE = {"USDT": "USD", "USD": "USD", "USDC": "USD", "EUR": "EUR", "GBP": "GBP", "JPY": "JPY"}
HIGH_IMPACT_CATS = {"rate_decision", "central_bank", "inflation", "employment", "gdp"}


def _dt(v: str) -> datetime:
    d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def event_risk(events: Sequence[Mapping[str, Any]], now: datetime, horizon_hours: float = 48.0,
               currencies: Optional[Sequence[str]] = None, pre_hours: float = 4.0, post_hours: float = 2.0) -> dict[str, Any]:
    """Event-aware volatility/liquidity warning. 'elevated' = a high-impact release inside [-post, +pre] hours."""
    wanted = {c.upper() for c in currencies} if currencies else None
    upcoming, state = [], "normal"
    for e in events:
        if wanted and (e.get("currency") or "").upper() not in wanted:
            continue
        hrs = (_dt(e["timestamp_utc"]) - now).total_seconds() / 3600.0
        if not (-post_hours <= hrs <= horizon_hours):
            continue
        high = e.get("impact") == "high" or (e.get("category") in HIGH_IMPACT_CATS and e.get("impact") in ("medium", "high"))
        surprise = None
        if e.get("actual") is not None and e.get("forecast") not in (None, 0):
            surprise = round((e["actual"] - e["forecast"]) / abs(e["forecast"]) * 100, 2)
        item = {**e, "hours_until": round(hrs, 2), "high_impact": high, "surprise_pct_vs_forecast": surprise}
        upcoming.append(item)
        if high and -post_hours <= hrs <= pre_hours:
            state = "elevated"
        elif high and state == "normal":
            state = "watch"
    upcoming.sort(key=lambda x: x["hours_until"])
    advice = {"elevated": "High-impact release imminent or just printed: expect wider spreads and gap risk; avoid new entries, review stops and size.",
              "watch": "High-impact release within the horizon: plan around it.", "normal": "No high-impact release inside the horizon."}[state]
    return {"status": "ok", "risk_state": state, "advice": advice, "events": upcoming,
            "parameters": {"horizon_hours": horizon_hours, "pre_hours": pre_hours, "post_hours": post_hours},
            "notes": ["A warning is context for risk management, not a trade signal and not a prediction of direction.",
                      "Provider timestamps are assumed UTC until verified live."]}


def currencies_for_symbol(symbol: str) -> list[str]:
    s = symbol.upper()
    out = {"USD"} if any(s.endswith(q) for q in ("USDT", "USD", "USDC")) else set()
    if len(s) == 6 and s.isalpha():
        out |= {s[:3], s[3:]}
    return sorted(out)


def unlock_risk(events: Sequence[Mapping[str, Any]], token: Optional[Mapping[str, Any]], now: datetime,
                material_pct: float = 1.0, major_pct: float = 3.0, horizon_days: int = 30) -> dict[str, Any]:
    """Supply-pressure view of upcoming unlocks. Never labels an unlock bearish by itself."""
    rows, total_value = [], 0.0
    for e in events:
        days = (_dt(e["unlock_ts"]) - now).total_seconds() / 86400.0
        if not (0 <= days <= horizon_days):
            continue
        v = e.get("value_usd") or 0.0
        insider_val = sum((a.get("value_usd") or 0.0) for a in e.get("allocations", []) if a.get("insider"))
        pct = e.get("value_to_market_cap_pct")
        circ = (token or {}).get("circulating_supply")
        maxs = (token or {}).get("max_supply")
        committed = any(a.get("committed_claim") for a in e.get("allocations", []))
        severity = None if pct is None else "major" if pct >= major_pct else "material" if pct >= material_pct else "minor"
        rows.append({"unlock_ts": e["unlock_ts"], "days_until": round(days, 2), "value_usd": v, "value_to_market_cap_pct": pct,
                     "pct_of_circulating": round(e["amount"] / circ * 100, 3) if e.get("amount") and circ else None,
                     "pct_of_max_supply": round(e["amount"] / maxs * 100, 3) if e.get("amount") and maxs else None,
                     "insider_share_of_value": round(insider_val / v, 3) if v else None, "severity": severity,
                     "committed_claim": committed, "precision": next((a.get("precision") for a in e.get("allocations", []) if a.get("precision")), None)})
        total_value += v
    rows.sort(key=lambda r: r["days_until"])
    top = max((r["value_usd"] for r in rows), default=0.0)
    return {"status": "ok", "symbol": (events[0].get("symbol") if events else (token or {}).get("symbol")), "horizon_days": horizon_days,
            "events": rows, "total_value_usd": round(total_value, 2),
            "concentration_top_event_share": round(top / total_value, 3) if total_value else None,
            "next_unlock_days": rows[0]["days_until"] if rows else None,
            "max_value_to_market_cap_pct": max((r["value_to_market_cap_pct"] or 0.0 for r in rows), default=0.0),
            "thresholds": {"material_pct": material_pct, "major_pct": major_pct},
            "notes": ["Supply pressure is not a price forecast: many unlocks are priced in, vested to long-term holders or never sold.",
                      "Insider allocations (team/private investors) are flagged because they carry higher sell-pressure risk, not certainty.",
                      "Severity thresholds are heuristics measured as unlock value / market cap."]}


def corroborate(signals: Sequence[Mapping[str, Any]], min_sources: int = 2) -> dict[str, Any]:
    """Gate for automation: a claim needs independent providers. One provider alone can never trigger a trade."""
    sources = {s.get("provider") for s in signals if s.get("provider")}
    ok = len(sources) >= min_sources
    return {"corroborated": ok, "sources": sorted(sources), "min_sources": min_sources,
            "may_trigger_automation": False,
            "note": "Provider intelligence only informs risk and research; it never submits orders. " + ("" if ok else "Single-source data is unverified.")}

"""Financial Modeling Prep adapter: economic calendar and earnings calendar (Stable API).

Schema notes: field names (date, country, event, currency, previous, estimate, actual, change, impact) come from
third-party documentation of FMP's economic-calendar response and are UNVERIFIED against a live key until
``scripts/live_provider_check.py`` passes. FMP publishes no revision field; ``revision`` is always None here.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from .base import ProviderClient, ProviderError, ProviderResult

MAX_RANGE_DAYS = 90

_CATEGORIES = [
    ("rate_decision", r"interest rate|rate decision|fomc|fed funds|policy rate|refinancing rate|bank rate|cash rate"),
    ("central_bank", r"ecb|boe|boj|fed |federal reserve|central bank|monetary policy|minutes|press conference|rba|snb"),
    ("inflation", r"\bcpi\b|\bppi\b|\bpce\b|inflation|price index|deflator"),
    ("employment", r"nonfarm|non farm|payroll|unemployment|jobless|employment|jolts|adp"),
    ("gdp", r"\bgdp\b|gross domestic"),
]


def classify_event(name: str) -> str:
    low = (name or "").lower()
    for cat, pat in _CATEGORIES:
        if re.search(pat, low):
            return cat
    return "other"


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_ts(v: Any) -> Optional[datetime]:
    if not v:
        return None
    s = str(v).strip().replace("Z", "+00:00")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def normalize_economic(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    ts = _parse_ts(row.get("date"))
    if ts is None or not row.get("event"):
        return None
    impact = str(row.get("impact") or "").strip().lower() or "unknown"
    return {"timestamp_utc": ts.isoformat(), "event": row["event"], "country": row.get("country"),
            "currency": row.get("currency"), "impact": impact, "category": classify_event(row["event"]),
            "previous": _num(row.get("previous")), "forecast": _num(row.get("estimate")), "actual": _num(row.get("actual")),
            "change": _num(row.get("change")), "revision": None, "released": row.get("actual") not in (None, ""),
            "time_assumption": "FMP timestamps treated as UTC (unverified)"}


def normalize_earnings(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    d = _parse_ts(row.get("date"))
    if d is None or not row.get("symbol"):
        return None
    return {"symbol": str(row["symbol"]).upper(), "date": d.date().isoformat(), "eps_actual": _num(row.get("epsActual")),
            "eps_estimate": _num(row.get("epsEstimated")), "revenue_actual": _num(row.get("revenueActual")),
            "revenue_estimate": _num(row.get("revenueEstimated")), "last_updated": row.get("lastUpdated")}


class FMPClient(ProviderClient):
    name = "fmp"
    capability = "calendar"
    base_url = "https://financialmodelingprep.com/stable"

    def _auth(self, params: dict, headers: dict) -> None:
        params["apikey"] = self._key

    def _classify(self, status: int, body: Any) -> Optional[ProviderError]:
        err = super()._classify(status, body)
        if err:
            return err
        if isinstance(body, dict):  # FMP reports some failures as HTTP 200 + {"Error Message": ...}
            msg = str(body.get("Error Message") or body.get("error") or "")
            if msg:
                low = msg.lower()
                kind = "plan_restricted" if any(w in low for w in ("subscription", "upgrade", "plan", "premium", "restricted")) else \
                       "rate_limited" if "limit" in low else "auth"
                return ProviderError(self.name, kind, "provider returned an error message", status)
        if not isinstance(body, list):
            return ProviderError(self.name, "bad_response", "expected a JSON list", status)
        return None

    @staticmethod
    def _range(start: date, end: date) -> dict[str, str]:
        if end < start:
            raise ProviderError("fmp", "bad_request", "end before start")
        if (end - start).days > MAX_RANGE_DAYS:
            raise ProviderError("fmp", "bad_request", f"range exceeds {MAX_RANGE_DAYS} days")
        return {"from": start.isoformat(), "to": end.isoformat()}

    async def economic_calendar(self, start: date, end: date) -> ProviderResult:
        res = await self.request("/economic-calendar", self._range(start, end), cache_ttl=900)
        events = [e for e in (normalize_economic(r) for r in res.data if isinstance(r, dict)) if e]
        skipped = len(res.data) - len(events)
        for e in events:
            self.note_data_timestamp(_parse_ts(e["timestamp_utc"]))
        return ProviderResult(events, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache,
                              {"rows_skipped_invalid": skipped, "range": self._range(start, end)})

    async def earnings_calendar(self, start: date, end: date) -> ProviderResult:
        res = await self.request("/earnings-calendar", self._range(start, end), cache_ttl=3 * 3600)
        rows = [e for e in (normalize_earnings(r) for r in res.data if isinstance(r, dict)) if e]
        return ProviderResult(rows, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache,
                              {"rows_skipped_invalid": len(res.data) - len(rows), "range": self._range(start, end)})

    async def probe(self) -> dict[str, Any]:
        """One small real request used by the live check script; reports plan access per endpoint."""
        today = datetime.now(timezone.utc).date()
        out: dict[str, Any] = {}
        for name, fn in (("economic_calendar", self.economic_calendar), ("earnings_calendar", self.earnings_calendar)):
            try:
                r = await fn(today, today + timedelta(days=7))
                out[name] = {"status": "ok", "rows": len(r.data)}
            except ProviderError as e:
                out[name] = {"status": e.kind, "http": e.status}
        return out

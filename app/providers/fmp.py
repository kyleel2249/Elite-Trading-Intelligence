"""Financial Modeling Prep adapter (Stable API): economic/earnings calendars and company fundamentals.

Endpoints used, all documented at https://site.financialmodelingprep.com/developer/docs/stable (checked 2026-11-12):
/economic-calendar, /earnings-calendar, /profile?symbol=, /quote?symbol=, /income-statement?symbol=&period=&limit=,
/key-metrics?symbol=&period=&limit=. Calendar response field names come from third-party documentation and stay UNVERIFIED until
a live probe passes. FMP publishes no revision field; ``revision`` is always None here.
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
    rate_per_minute = 240       # conservative client-side ceiling; FMP plan limits vary and are not reported in responses
    verify_ttl_seconds = 6 * 3600

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

    @staticmethod
    def _symbol(symbol: str) -> str:
        s = (symbol or "").strip().upper()
        if not s or len(s) > 15 or not all(c.isalnum() or c in ".-^" for c in s):
            raise ProviderError("fmp", "bad_request", "invalid symbol")
        return s

    async def _rows(self, path: str, params: dict[str, Any], ttl: float) -> ProviderResult:
        res = await self.request(path, params, cache_ttl=ttl)
        return res

    async def company_profile(self, symbol: str) -> ProviderResult:
        """GET /stable/profile?symbol= (documented). Returns one normalised row or none."""
        sym = self._symbol(symbol)
        res = await self._rows("/profile", {"symbol": sym}, 6 * 3600)
        row = next((r for r in res.data if isinstance(r, dict)), None)
        data = None if row is None else {
            "symbol": row.get("symbol"), "name": row.get("companyName"), "exchange": row.get("exchange") or row.get("exchangeFullName"),
            "currency": row.get("currency"), "sector": row.get("sector"), "industry": row.get("industry"), "country": row.get("country"),
            "market_cap": _num(row.get("marketCap")), "price": _num(row.get("price")), "beta": _num(row.get("beta")),
            "last_dividend": _num(row.get("lastDividend")), "is_etf": row.get("isEtf"), "is_actively_trading": row.get("isActivelyTrading")}
        return ProviderResult(data, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache, {"symbol": sym})

    async def quote(self, symbol: str) -> ProviderResult:
        """GET /stable/quote?symbol= (documented)."""
        sym = self._symbol(symbol)
        res = await self._rows("/quote", {"symbol": sym}, 30)
        row = next((r for r in res.data if isinstance(r, dict)), None)
        data = None if row is None else {
            "symbol": row.get("symbol"), "price": _num(row.get("price")), "change": _num(row.get("change")),
            "change_pct": _num(row.get("changePercentage") if row.get("changePercentage") is not None else row.get("changesPercentage")),
            "volume": _num(row.get("volume")), "day_low": _num(row.get("dayLow")), "day_high": _num(row.get("dayHigh")),
            "year_low": _num(row.get("yearLow")), "year_high": _num(row.get("yearHigh")), "market_cap": _num(row.get("marketCap")),
            "timestamp": row.get("timestamp")}
        return ProviderResult(data, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache, {"symbol": sym})

    async def income_statements(self, symbol: str, period: str = "FY", limit: int = 4) -> ProviderResult:
        """GET /stable/income-statement?symbol=&period=&limit= (documented)."""
        sym = self._symbol(symbol)
        if period not in ("FY", "Q1", "Q2", "Q3", "Q4") or not 1 <= limit <= 20:
            raise ProviderError("fmp", "bad_request", "invalid period or limit")
        res = await self._rows("/income-statement", {"symbol": sym, "period": period, "limit": limit}, 6 * 3600)
        rows = [{"date": r.get("date"), "fiscal_year": r.get("fiscalYear"), "period": r.get("period"), "currency": r.get("reportedCurrency"),
                 "revenue": _num(r.get("revenue")), "gross_profit": _num(r.get("grossProfit")), "operating_income": _num(r.get("operatingIncome")),
                 "net_income": _num(r.get("netIncome")), "eps_diluted": _num(r.get("epsDiluted"))} for r in res.data if isinstance(r, dict)]
        return ProviderResult(rows, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache, {"symbol": sym, "period": period})

    async def key_metrics(self, symbol: str, period: str = "FY", limit: int = 4) -> ProviderResult:
        """GET /stable/key-metrics?symbol=&period=&limit= (documented). Raw numeric fields are passed through as reported."""
        sym = self._symbol(symbol)
        if period not in ("FY", "Q1", "Q2", "Q3", "Q4") or not 1 <= limit <= 20:
            raise ProviderError("fmp", "bad_request", "invalid period or limit")
        res = await self._rows("/key-metrics", {"symbol": sym, "period": period, "limit": limit}, 6 * 3600)
        rows = [{k: (_num(v) if k not in ("symbol", "date", "fiscalYear", "period", "reportedCurrency") else v) for k, v in r.items()}
                for r in res.data if isinstance(r, dict)]
        return ProviderResult(rows, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache, {"symbol": sym, "period": period})

    async def probe(self) -> dict[str, Any]:
        """Real read-only request per endpoint ETI uses; records which endpoints the subscription actually allows."""
        today = datetime.now(timezone.utc).date()
        calls = (("economic_calendar", lambda: self.economic_calendar(today, today + timedelta(days=7))),
                 ("earnings_calendar", lambda: self.earnings_calendar(today, today + timedelta(days=7))),
                 ("profile", lambda: self.company_profile("AAPL")), ("quote", lambda: self.quote("AAPL")),
                 ("income_statement", lambda: self.income_statements("AAPL", limit=1)),
                 ("key_metrics", lambda: self.key_metrics("AAPL", limit=1)))
        out: dict[str, Any] = {}
        for name, call in calls:
            try:
                r = await call()
                n = len(r.data) if isinstance(r.data, list) else (0 if r.data is None else 1)
                out[name] = {"status": "ok", "rows": n}
            except ProviderError as e:
                out[name] = {"status": e.kind, "http": e.status}
        return out

"""Tokenomist adapter (token unlock schedules), API v5 per https://docs.tokenomist.ai.

Auth: ``x-api-key`` header. Each successful request spends one monthly credit (Pro: 1,000/month), so calls are
budgeted by ``credit_reserve`` and cached. Data licence: personal / non-commercial, non-redistribution.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterable, Optional

from .base import ProviderClient, ProviderError, ProviderResult

INSIDER_STANDARD = {"founderteam", "privateinvestors", "founder team", "private investors", "team", "investors"}


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def normalize_unlock_event(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    cliff = row.get("cliffUnlocks") or {}
    if not row.get("unlockDate") or not isinstance(cliff, dict):
        return None
    breakdown = []
    for a in cliff.get("allocationBreakdown") or []:
        std = str(a.get("standardAllocationName") or "").strip()
        breakdown.append({"allocation": a.get("allocationName"), "standard_allocation": std or None,
                          "insider": std.lower().replace(" ", "") in {s.replace(" ", "") for s in INSIDER_STANDARD},
                          "amount": _f(a.get("cliffAmount")), "value_usd": _f(a.get("cliffValue")),
                          "reference_price": _f(a.get("referencePrice")), "precision": a.get("unlockPrecision"),
                          "committed_claim": a.get("committedClaim")})
    return {"unlock_ts": row["unlockDate"], "symbol": row.get("tokenSymbol"), "name": row.get("tokenName"),
            "amount": _f(cliff.get("cliffAmount")), "value_usd": _f(cliff.get("cliffValue")),
            "value_to_market_cap_pct": _f(cliff.get("valueToMarketCap")), "allocations": breakdown,
            "data_source": row.get("dataSource"), "listed_method": row.get("listedMethod"),
            "latest_update": row.get("latestUpdateDate")}


class TokenomistClient(ProviderClient):
    name = "tokenomist"
    capability = "token_unlocks"
    base_url = "https://api.tokenomist.ai"

    def __init__(self, api_key: Optional[str], credit_reserve: float = 0.10, **kw: Any):
        super().__init__(api_key, **kw)
        self.credit_reserve = credit_reserve  # stop spending when remaining credits fall below this fraction

    def _auth(self, params: dict, headers: dict) -> None:
        headers["x-api-key"] = self._key  # type: ignore[assignment]

    def _classify(self, status: int, body: Any) -> Optional[ProviderError]:
        err = super()._classify(status, body)
        if err is None and isinstance(body, dict) and body.get("status") is False:
            return ProviderError(self.name, "bad_response", "status=false", status)
        if err is None and not isinstance(body, dict):
            return ProviderError(self.name, "bad_response", "expected a JSON object", status)
        return err

    def _track_quota(self, body: dict[str, Any]) -> None:
        credit = ((body.get("metadata") or {}).get("credit")) or None
        if isinstance(credit, dict):
            self.health.quota = {k: credit.get(k) for k in ("used", "limit", "resetAt")}

    def _guard_credits(self) -> None:
        q = self.health.quota
        if q and q.get("limit") and q.get("used") is not None:
            remaining = (q["limit"] - q["used"]) / q["limit"]
            if remaining < self.credit_reserve:
                raise ProviderError(self.name, "rate_limited", "monthly credit reserve reached; refusing to spend more credits")

    async def token_list(self, token_ids: Optional[Iterable[str]] = None) -> ProviderResult:
        self._guard_credits()
        params = {"tokenId": ",".join(token_ids)} if token_ids else {}
        res = await self.request("/v5/token/list", params, cache_ttl=6 * 3600)
        self._track_quota(res.data)
        items = [{"id": t.get("id"), "symbol": t.get("symbol"), "name": t.get("name"),
                  "circulating_supply": _f(t.get("circulatingSupply")), "market_cap": _f(t.get("marketCap")),
                  "max_supply": _f(t.get("maxSupply")), "total_locked": _f(t.get("totalLockedAmount")),
                  "last_updated": t.get("lastUpdatedDate")} for t in (res.data.get("data") or [])]
        return ProviderResult(items, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache,
                              {"quota": self.health.quota})

    async def unlock_events(self, token_id: str, start: Optional[date] = None, end: Optional[date] = None,
                            page_size: int = 100, max_pages: int = 5) -> ProviderResult:
        if not token_id or "/" in token_id:
            raise ProviderError(self.name, "bad_request", "invalid token id")
        events: list[dict[str, Any]] = []
        page, res = 1, None
        while page <= max_pages:
            self._guard_credits()
            params = {"start": start.isoformat() if start else None, "end": end.isoformat() if end else None,
                      "page": page, "pageSize": page_size}
            res = await self.request(f"/v5/unlock/events/{token_id}", params, cache_ttl=3600)
            self._track_quota(res.data)
            events += [e for e in (normalize_unlock_event(r) for r in (res.data.get("data") or []) if isinstance(r, dict)) if e]
            total_pages = (res.data.get("metadata") or {}).get("totalPages") or 1
            if page >= total_pages:
                break
            page += 1
        assert res is not None
        return ProviderResult(events, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache,
                              {"pages_read": page, "truncated": page >= max_pages and (res.data.get("metadata") or {}).get("totalPages", 1) > max_pages,
                               "quota": self.health.quota})

    async def probe(self) -> dict[str, Any]:
        """Smallest real request (1 credit): token list filtered to one slug."""
        try:
            r = await self.token_list(["arbitrum"])
            return {"token_list": {"status": "ok", "rows": len(r.data), "quota": self.health.quota}}
        except ProviderError as e:
            return {"token_list": {"status": e.kind, "http": e.status}}

"""Shared provider plumbing. No network library is required to import this module."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Mapping, Optional

logger = logging.getLogger("eti.providers")

Transport = Callable[[str, str, Mapping[str, Any], Mapping[str, str], float], Awaitable["tuple[int, Any, Mapping[str, str]]"]]

SECRET_PARAMS = {"apikey", "api_key", "token", "key"}
SECRET_HEADERS = {"x-api-key", "authorization"}


class ProviderError(Exception):
    """kind: not_configured | auth | plan_restricted | rate_limited | upstream | bad_response | circuit_open | bad_request"""

    def __init__(self, provider: str, kind: str, detail: str = "", status: Optional[int] = None):
        super().__init__(f"{provider}: {kind}" + (f" ({detail})" if detail else ""))
        self.provider, self.kind, self.detail, self.status = provider, kind, detail, status


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def httpx_transport(method: str, url: str, params: Mapping[str, Any], headers: Mapping[str, str], timeout: float):
    import httpx  # imported lazily so unit tests and tooling do not need it

    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.request(method, url, params=dict(params), headers=dict(headers))
    try:
        body = r.json()
    except ValueError:
        body = None
    return r.status_code, body, dict(r.headers)


@dataclass
class ProviderResult:
    data: Any
    provider: str
    endpoint: str
    fetched_at: datetime
    latency_ms: float
    from_cache: bool = False
    meta: dict[str, Any] = field(default_factory=dict)

    def provenance(self) -> dict[str, Any]:
        return {"provider": self.provider, "endpoint": self.endpoint, "fetched_at": self.fetched_at.isoformat(),
                "latency_ms": round(self.latency_ms, 1), "from_cache": self.from_cache, **self.meta}


@dataclass
class Health:
    requests: int = 0
    successes: int = 0
    failures: int = 0
    retries: int = 0
    total_latency_ms: float = 0.0
    last_success: Optional[datetime] = None
    last_failure: Optional[datetime] = None
    last_error_kind: Optional[str] = None
    latest_data_timestamp: Optional[datetime] = None
    consecutive_failures: int = 0
    quota: Optional[dict[str, Any]] = None
    history: list[dict[str, Any]] = field(default_factory=list)  # bounded integration-health log
    last_error_at: Optional[datetime] = None
    verification: Optional[dict[str, Any]] = None  # result of the last real probe: {verified_at, endpoints:{name:{status,...}}}
    verifying: bool = False


class ProviderClient:
    """Base class: subclasses set ``name``, ``capability``, ``base_url`` and implement auth + endpoints."""

    name = "provider"
    capability = "generic"
    base_url = ""
    max_attempts = 3
    base_delay = 0.5
    max_delay = 8.0
    timeout = 10.0
    breaker_threshold = 5
    breaker_cooldown = 60.0
    history_limit = 200
    rate_per_minute: Optional[int] = None   # client-side ceiling so a burst never exhausts the provider quota
    verify_ttl_seconds = 6 * 3600           # how often automatic verification may re-probe this provider

    def __init__(self, api_key: Optional[str], transport: Optional[Transport] = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, clock: Callable[[], float] = time.monotonic):
        self._key = (api_key or "").strip() or None
        self._transport = transport or httpx_transport
        self._sleep, self._clock = sleep, clock
        self._cache: dict[tuple, tuple[float, Any]] = {}
        self._breaker_open_until = 0.0
        self._calls: deque = deque()
        self.health = Health()

    # -- subclass hooks -------------------------------------------------------------------------
    def _auth(self, params: dict[str, Any], headers: dict[str, str]) -> None:
        raise NotImplementedError

    def _classify(self, status: int, body: Any) -> Optional[ProviderError]:
        """Map an HTTP result to an error, or None when the body is acceptable."""
        if status == 401:
            return ProviderError(self.name, "auth", "credentials rejected", status)
        if status in (402, 403):
            return ProviderError(self.name, "plan_restricted", "authentication or plan does not allow this endpoint", status)
        if status == 429:
            return ProviderError(self.name, "rate_limited", "quota or rate limit reached", status)
        if status in (400, 404, 422):
            return ProviderError(self.name, "bad_request", f"HTTP {status}", status)
        if status >= 500 or status == 0:
            return ProviderError(self.name, "upstream", f"HTTP {status}", status)
        if status >= 400:
            return ProviderError(self.name, "upstream", f"HTTP {status}", status)
        return None

    @property
    def configured(self) -> bool:
        return self._key is not None

    # -- core -----------------------------------------------------------------------------------
    def _redact(self, text: str) -> str:
        return text.replace(self._key, "***") if self._key else text

    def _log_event(self, kind: str, detail: str = "") -> None:
        h = self.health
        h.history.append({"at": utcnow().isoformat(), "event": kind, "detail": self._redact(detail)[:200]})
        del h.history[:-self.history_limit]

    def _delay(self, attempt: int, retry_after: Optional[float]) -> float:
        if retry_after is not None:
            return min(max(retry_after, 0.0), self.max_delay)
        return random.uniform(0, min(self.max_delay, self.base_delay * (2 ** attempt)))  # full jitter

    async def request(self, path: str, params: Optional[Mapping[str, Any]] = None, cache_ttl: float = 0.0,
                      method: str = "GET") -> ProviderResult:
        if not self.configured:
            raise ProviderError(self.name, "not_configured", "API key missing")
        public_params = {k: v for k, v in (params or {}).items() if v is not None}
        cache_key = (method, path, tuple(sorted((k, str(v)) for k, v in public_params.items())))
        now = self._clock()
        hit = self._cache.get(cache_key)
        if cache_ttl > 0 and hit and now < hit[0]:
            return ProviderResult(hit[1], self.name, path, utcnow(), 0.0, from_cache=True)
        if now < self._breaker_open_until:
            raise ProviderError(self.name, "circuit_open", "too many recent failures; backing off")
        if self.rate_per_minute:
            while self._calls and self._calls[0] < now - 60.0:
                self._calls.popleft()
            if len(self._calls) >= self.rate_per_minute:
                raise ProviderError(self.name, "rate_limited", "local rate limit reached; request not sent")
        h = self.health
        last_err: Optional[ProviderError] = None
        for attempt in range(self.max_attempts):
            send_params, headers = dict(public_params), {}
            self._auth(send_params, headers)
            h.requests += 1
            self._calls.append(self._clock())
            t0 = self._clock()
            retry_after: Optional[float] = None
            try:
                status, body, resp_headers = await self._transport(method, self.base_url + path, send_params, headers, self.timeout)
                err = self._classify(status, body)
                ra = (resp_headers or {}).get("retry-after") or (resp_headers or {}).get("Retry-After")
                try:
                    retry_after = float(ra) if ra is not None else None
                except ValueError:
                    retry_after = None
            except ProviderError as e:
                err, body = e, None
            except Exception as e:  # network/timeout; never echo the URL (it may carry a key)
                err, body = ProviderError(self.name, "upstream", type(e).__name__), None
            latency = (self._clock() - t0) * 1000.0
            if err is None:
                h.successes += 1
                h.total_latency_ms += latency
                h.consecutive_failures = 0
                h.last_success = utcnow()
                self._log_event("ok", path)
                if cache_ttl > 0:
                    self._cache[cache_key] = (self._clock() + cache_ttl, body)
                return ProviderResult(body, self.name, path, h.last_success, latency)
            h.failures += 1
            h.last_failure, h.last_error_kind = utcnow(), err.kind
            h.last_error_at = h.last_failure
            self._log_event(f"error:{err.kind}", path)
            last_err = err
            retryable = err.kind in ("upstream", "rate_limited")
            if not retryable or attempt == self.max_attempts - 1:
                break
            h.retries += 1
            await self._sleep(self._delay(attempt, retry_after))
        assert last_err is not None
        # Only outage-type failures feed the circuit breaker. A rejected key (auth), a plan limit or a bad request is a
        # configuration problem: it must stay visible as such and must not mask itself as "down".
        if last_err.kind in ("upstream", "rate_limited", "bad_response"):
            h.consecutive_failures += 1
            if h.consecutive_failures >= self.breaker_threshold:
                self._breaker_open_until = self._clock() + self.breaker_cooldown
                self._log_event("circuit_opened")
        raise last_err

    def note_data_timestamp(self, ts: Optional[datetime]) -> None:
        if ts and (self.health.latest_data_timestamp is None or ts > self.health.latest_data_timestamp):
            self.health.latest_data_timestamp = ts

    async def probe(self) -> dict[str, Any]:  # pragma: no cover - overridden by providers
        return {}

    def record_verification(self, endpoints: dict[str, Any]) -> dict[str, Any]:
        self.health.verification = {"verified_at": utcnow().isoformat(), "endpoints": endpoints}
        self._log_event("verified", ",".join(f"{k}={v.get('status')}" for k, v in endpoints.items()))
        return self.health.verification

    async def verify(self) -> dict[str, Any]:
        """Real, read-only probe of every endpoint ETI uses; the only thing that can prove subscription access."""
        if not self.configured:
            return self.record_verification({"_": {"status": "not_configured"}})
        if self.health.verifying:
            return self.health.verification or {}
        self.health.verifying = True
        try:
            return self.record_verification(await self.probe())
        finally:
            self.health.verifying = False

    def needs_verification(self) -> bool:
        if not self.configured or self.health.verifying:
            return False
        v = self.health.verification
        if not v:
            return True
        return (utcnow() - datetime.fromisoformat(v["verified_at"])).total_seconds() > self.verify_ttl_seconds

    def health_snapshot(self, stale_after_seconds: Optional[float] = None) -> dict[str, Any]:
        """status: unconfigured | unverified | operational-equivalent 'ok' | degraded | down | unauthorized | plan_restricted.
        'ok' is only ever reported after a real provider request succeeded; a secret that is merely present is 'unverified'."""
        h = self.health
        breaker_open = self._clock() < self._breaker_open_until
        if not self.configured:
            status = "unconfigured"
        elif breaker_open or h.consecutive_failures >= self.breaker_threshold:
            status = "down"
        elif h.last_success is None:
            status = {"auth": "unauthorized", "plan_restricted": "plan_restricted"}.get(h.last_error_kind or "", "unverified" if h.requests == 0 else "degraded")
        elif h.last_error_kind == "auth" and h.last_error_at and h.last_error_at >= h.last_success:
            status = "unauthorized"   # key revoked/expired after earlier successes
        elif h.consecutive_failures > 0:
            status = "degraded"
        else:
            status = "ok"
        age = (utcnow() - h.last_success).total_seconds() if h.last_success else None
        stale = None if (age is None or not stale_after_seconds) else age > stale_after_seconds
        return {"provider": self.name, "capability": self.capability, "configured": self.configured, "status": status,
                "requests": h.requests, "failures": h.failures, "retries": h.retries,
                "avg_latency_ms": round(h.total_latency_ms / h.successes, 1) if h.successes else None,
                "last_success": h.last_success.isoformat() if h.last_success else None,
                "last_failure": h.last_failure.isoformat() if h.last_failure else None,
                "last_error_kind": h.last_error_kind,
                "last_error": {"kind": h.last_error_kind, "at": h.last_error_at.isoformat() if h.last_error_at else None} if h.last_error_kind else None,
                "latest_data_timestamp": h.latest_data_timestamp.isoformat() if h.latest_data_timestamp else None,
                "data_age_seconds": None if age is None else round(age, 1), "sync_stale": stale,
                "quota": h.quota, "rate_per_minute": self.rate_per_minute, "circuit_open": breaker_open,
                "verification": h.verification, "verifying": h.verifying}


class Capability:
    """Ordered providers for one capability; the first that succeeds wins (primary, then fallbacks)."""

    def __init__(self, name: str, providers: list[ProviderClient]):
        self.name, self.providers = name, providers

    async def call(self, method: str, *args: Any, **kwargs: Any) -> tuple[Any, list[dict[str, str]]]:
        attempts: list[dict[str, str]] = []
        for p in self.providers:
            fn = getattr(p, method, None)
            if fn is None:
                continue
            try:
                return await fn(*args, **kwargs), attempts
            except ProviderError as e:
                attempts.append({"provider": p.name, "error": e.kind})
        detail = ", ".join(f"{a['provider']}={a['error']}" for a in attempts) or f"no provider implements {method}"
        kinds = {a["error"] for a in attempts}
        kind = kinds.pop() if len(kinds) == 1 else "upstream"
        raise ProviderError(self.name, kind, "all providers failed or unavailable: " + detail)

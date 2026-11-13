"""Failover across Binance's official public market-data hosts (global Binance only; Binance.US is excluded).

Binance publishes several equivalent hosts for public market data (api, api-gcp, api1-api4, and the data-only
data-api.binance.vision). If one is slow, down or refusing us, the next is tried, and the host that last worked is
tried first next time.

This is availability failover, NOT a way around location restrictions. Binance refuses some regions (including the
US) by the caller's IP address on every one of these hosts. When every host refuses with HTTP 451/403 this module
says so plainly instead of pretending the data is available; the fix is to run ETI in a region Binance serves.
No proxy, VPN or other evasion is attempted here.

Market data only. Nothing in this module signs requests or places orders.

Override the host list with ETI_BINANCE_PUBLIC_HOSTS (comma-separated https URLs). Plain-http hosts and any
binance.us host are ignored.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("eti.binance_hosts")

DEFAULT_HOSTS = (
    "https://api.binance.com",
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://data-api.binance.vision",
)
RESTRICTED_CODES = {"HTTP 451", "HTTP 403"}

_last_good: Optional[str] = None
_last_attempts: list[tuple[str, str]] = []


class BinanceBadRequest(Exception):
    """Binance understood the request and rejected it (e.g. unknown symbol). Not a host problem: not retried."""

    def __init__(self, status: int):
        super().__init__(f"Binance rejected the request (HTTP {status})")
        self.status = status


class BinanceUnavailable(Exception):
    """Every official host failed."""

    def __init__(self, attempts: list[tuple[str, str]]):
        self.attempts = list(attempts)
        codes = {reason for _, reason in self.attempts}
        if self.attempts and codes <= RESTRICTED_CODES:
            self.public_message = (
                "Binance is refusing requests from this server's location (HTTP 451/403 from every official host). "
                "Binance restricts some regions, including the US. Run ETI in a region Binance serves.")
        else:
            self.public_message = (
                f"Binance market data is unreachable from this server ({len(self.attempts)} official hosts tried).")
        super().__init__(self.public_message)


def hosts() -> list[str]:
    raw = os.environ.get("ETI_BINANCE_PUBLIC_HOSTS", "")
    candidates = [h.strip() for h in raw.split(",") if h.strip()] or list(DEFAULT_HOSTS)
    out: list[str] = []
    for h in candidates:
        p = urlparse(h)
        name = (p.hostname or "").lower()
        if p.scheme != "https" or not name:
            continue
        if name == "binance.us" or name.endswith(".binance.us"):
            continue
        base = f"https://{p.netloc.lower()}"
        if base not in out:
            out.append(base)
    return out or list(DEFAULT_HOSTS)


def _ordered() -> list[str]:
    hs = hosts()
    if _last_good in hs:
        return [_last_good] + [h for h in hs if h != _last_good]
    return hs


def last_good() -> Optional[str]:
    return _last_good


def reset() -> None:
    global _last_good, _last_attempts
    _last_good, _last_attempts = None, []


def status() -> dict[str, Any]:
    return {"hosts": hosts(), "last_good": _last_good,
            "last_attempts": [{"host": h, "result": r} for h, r in _last_attempts],
            "excluded": ["binance.us"],
            "note": "Failover is for availability only; it cannot bypass Binance's location restrictions."}


async def get_json(path: str, params: Optional[dict[str, Any]] = None,
                   transport: Optional[httpx.AsyncBaseTransport] = None, timeout: float = 15.0) -> tuple[Any, str]:
    """GET `path` from the first official host that answers. Returns (parsed JSON, host used).

    Raises BinanceBadRequest for HTTP 400/404 (the request itself is wrong: other hosts would say the same) and
    BinanceUnavailable when every host fails.
    """
    global _last_good, _last_attempts
    attempts: list[tuple[str, str]] = []
    async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
        for base in _ordered():
            try:
                r = await client.get(base + path, params=params)
            except httpx.HTTPError as exc:
                attempts.append((base, type(exc).__name__))
                continue
            code = r.status_code
            if code == 200:
                try:
                    data = r.json()
                except ValueError:
                    attempts.append((base, "invalid JSON"))
                    continue
                _last_good, _last_attempts = base, attempts
                return data, base
            if code in (400, 404):
                raise BinanceBadRequest(code)
            attempts.append((base, f"HTTP {code}"))
    _last_attempts = attempts
    logger.warning("all Binance public hosts failed: %s", attempts)
    raise BinanceUnavailable(attempts)

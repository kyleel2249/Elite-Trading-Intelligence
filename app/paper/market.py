"""Keyless market data for the internal paper engine: Binance public order books (no API key needed)."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Optional, Protocol

from .core import Book, PaperError

_SYMBOL = re.compile(r"^[A-Z0-9]{3,20}$")
HOSTS = ("https://api.binance.com", "https://data-api.binance.vision")


class BookSource(Protocol):
    async def get_book(self, symbol: str, depth: int = 20) -> Book: ...


class BinancePublicBook:
    """GET /api/v3/depth is a public endpoint. Books are cached for `ttl` seconds only (freshness is re-checked
    by the engine against the book timestamp, which is the retrieval time)."""

    def __init__(self, ttl: float = 1.0, timeout: float = 6.0, hosts=HOSTS):
        self.ttl, self.timeout, self.hosts = ttl, timeout, tuple(hosts)
        self._cache: dict = {}

    async def get_book(self, symbol: str, depth: int = 20) -> Book:
        sym = (symbol or "").strip().upper()
        if not _SYMBOL.match(sym):
            raise PaperError(f"'{symbol}' is not a Binance spot symbol. The key-free paper engine prices crypto spot "
                             "pairs such as BTCUSDT; it will not invent prices for other instruments.")
        hit = self._cache.get(sym)
        if hit and time.monotonic() - hit[0] < self.ttl:
            return hit[1]
        import httpx  # lazy
        last_err = "unknown error"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for host in self.hosts:
                try:
                    r = await client.get(f"{host}/api/v3/depth", params={"symbol": sym, "limit": depth})
                except httpx.HTTPError as e:
                    last_err = type(e).__name__
                    continue
                if r.status_code == 400:
                    raise PaperError(f"Unknown symbol {sym} on Binance spot")
                if r.status_code != 200:
                    last_err = f"HTTP {r.status_code}"
                    continue
                try:
                    j = r.json()
                    book = Book(sym, tuple((float(p), float(q)) for p, q in j["bids"]),
                                tuple((float(p), float(q)) for p, q in j["asks"]),
                                datetime.now(timezone.utc), f"binance-public:{host.split('//')[1]}")
                except (KeyError, ValueError, TypeError):
                    last_err = "malformed response"
                    continue
                self._cache[sym] = (time.monotonic(), book)
                return book
        raise PaperError(f"Live price unavailable for {sym} ({last_err}); no simulated fill without a verified price")

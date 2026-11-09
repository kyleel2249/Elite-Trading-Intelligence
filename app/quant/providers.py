"""Provider adapters for the scanner. These call real endpoints; nothing is simulated.

Binance: one ``/api/v3/ticker/24hr`` call returns every spot symbol, so a full
crypto sweep costs a single request (weight 80 at time of writing).
Alpaca: ``/v2/stocks/snapshots`` accepts many symbols per request; requires keys.
A provider that is not configured raises, which the scanner records as
unavailable (it is never presented as monitored).

NOTE: these adapters have not been exercised against live responses from this
environment; verify with a real-provider load test before relying on them.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings
from app.quant.scanner import UniverseEntry


def _ms(ms: Any) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


class BinanceBulkProvider:
    name = "binance"
    max_batch = 5000          # whole market in one call
    rate_per_sec = 0.5        # conservative: ticker/24hr is a heavy-weight call

    def __init__(self, base_url: str = "https://api.binance.com", timeout: float = 15.0):
        self.base_url, self.timeout = base_url.rstrip("/"), timeout

    async def _all_tickers(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=self.timeout) as http:
            r = await http.get(f"{self.base_url}/api/v3/ticker/24hr")
            r.raise_for_status()
            return r.json()

    async def fetch_batch(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        want = {s.upper() for s in symbols}
        out: dict[str, dict[str, Any]] = {}
        for t in await self._all_tickers():
            sym = t.get("symbol")
            if sym in want:
                out[sym] = {
                    "price": float(t["lastPrice"]),
                    "bid": float(t["bidPrice"]) if t.get("bidPrice") else None,
                    "ask": float(t["askPrice"]) if t.get("askPrice") else None,
                    "volume": float(t["quoteVolume"]) if t.get("quoteVolume") else None,
                    "ts_utc": _ms(t.get("closeTime")),
                }
        return out

    async def load_universe(self, limit: int = 1000, quote: str = "USDT", min_quote_volume: float = 100_000.0,
                            failover: Optional[str] = None) -> list[UniverseEntry]:
        rows = [t for t in await self._all_tickers()
                if t.get("symbol", "").endswith(quote) and float(t.get("quoteVolume") or 0) >= min_quote_volume]
        rows.sort(key=lambda t: -float(t["quoteVolume"]))
        chain = ["binance"] + ([failover] if failover else [])
        return [UniverseEntry(t["symbol"], "crypto", "BINANCE", chain, priority=int(float(t["quoteVolume"]) // 1_000_000))
                for t in rows[:limit]]


class AlpacaSnapshotProvider:
    name = "alpaca"
    max_batch = 200
    rate_per_sec = 3.0        # stays well under the documented 200 req/min free-tier limit

    def __init__(self, settings: Settings, feed: str = "iex", timeout: float = 15.0):
        self.settings, self.feed, self.timeout = settings, feed, timeout
        self.base_url = "https://data.alpaca.markets"

    async def fetch_batch(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        if not self.settings.alpaca_configured:
            raise RuntimeError("alpaca not configured")
        headers = {"APCA-API-KEY-ID": self.settings.alpaca_api_key or "",
                   "APCA-API-SECRET-KEY": self.settings.alpaca_secret_key or ""}
        async with httpx.AsyncClient(timeout=self.timeout, headers=headers) as http:
            r = await http.get(f"{self.base_url}/v2/stocks/snapshots",
                               params={"symbols": ",".join(symbols), "feed": self.feed})
            r.raise_for_status()
            data = r.json()
        out: dict[str, dict[str, Any]] = {}
        for sym, snap in (data or {}).items():
            trade = (snap or {}).get("latestTrade") or {}
            quote = (snap or {}).get("latestQuote") or {}
            bar = (snap or {}).get("dailyBar") or {}
            ts = trade.get("t")
            try:
                ts_dt = datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
            except ValueError:
                ts_dt = None
            if trade.get("p") is None:
                continue
            out[sym] = {"price": float(trade["p"]), "bid": quote.get("bp") or None, "ask": quote.get("ap") or None,
                        "volume": bar.get("v"), "ts_utc": ts_dt}
        return out


def build_equity_universe(symbols: list[str], exchange: str = "US", asset_class: str = "equity") -> list[UniverseEntry]:
    return [UniverseEntry(s.strip().upper(), asset_class, exchange, ["alpaca"]) for s in symbols if s.strip()]

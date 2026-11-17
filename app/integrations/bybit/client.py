"""Unauthenticated Bybit V5 public market data client."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote


class BybitClient(BaseProvider):
    name = "bybit"
    CATEGORIES = ("spot", "linear", "inverse")

    def __init__(self, settings: Optional[Settings] = None, category: str = "spot"):
        self.settings = settings or get_settings()
        self.category = category if category in self.CATEGORIES else "spot"
        self.base_url = "https://api.bybit.com"

    @property
    def configured(self) -> bool:
        # Public market data is available without API credentials.
        return True

    async def _get(self, path: str, params: dict[str, Any]):
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(self.base_url + path, params=params, headers={"accept": "application/json"})
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("retCode") != 0 or not isinstance(body.get("result"), dict):
            code = body.get("retCode") if isinstance(body, dict) else "invalid"
            raise RuntimeError(f"Bybit V5 rejected public market request ({code})")
        return body["result"]

    async def health(self) -> dict[str, Any]:
        try:
            result = await self._get("/v5/market/time", {})
            return {"provider": "bybit", "status": "connected", "category": self.category,
                    "server_time": result.get("timeNano") or result.get("timeSecond")}
        except Exception as exc:
            return {"provider": "bybit", "status": "error", "category": self.category,
                    "error": type(exc).__name__}

    async def get_quote(self, symbol: str) -> NormalizedQuote:
        symbol = symbol.upper()
        result = await self._get("/v5/market/tickers", {"category": self.category, "symbol": symbol})
        rows = result.get("list") or []
        if not rows:
            raise RuntimeError(f"Bybit has no {self.category} ticker for {symbol}")
        row = rows[0]
        bid, ask = float(row["bid1Price"]), float(row["ask1Price"])
        last = float(row.get("lastPrice") or 0)
        now = datetime.now(timezone.utc)
        return NormalizedQuote(provider="bybit", symbol=symbol, normalized_symbol=symbol, asset_class="crypto",
                               price=last or (bid + ask) / 2, bid=bid, ask=ask,
                               volume=float(row.get("volume24h") or 0), ts_provider=now, ts_utc=now,
                               retrieved_at=now, data_status="fresh", exchange="BYBIT",
                               quote_currency=next((q for q in ("USDT", "USDC", "USD", "BTC", "ETH") if symbol.endswith(q)), None),
                               meta={"category": self.category, "turnover24h": row.get("turnover24h")})

    async def get_klines(self, symbol: str, interval: str = "1h", limit: int = 100,
                        category: Optional[str] = None) -> list[dict[str, Any]]:
        cat = category if category in self.CATEGORIES else self.category
        iv = {"1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60",
              "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D", "1w": "W", "1M": "M"}.get(interval)
        if not iv:
            raise ValueError(f"Unsupported Bybit kline interval: {interval}")
        result = await self._get("/v5/market/kline", {"category": cat, "symbol": symbol.upper(),
                                                      "interval": iv, "limit": min(1000, max(1, limit))})
        seconds = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
                   "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200, "1d": 86400,
                   "1w": 604800, "1M": 2592000}[interval]
        out = []
        for row in reversed(result.get("list") or []):
            opened = int(row[0])
            out.append({"open_time": opened, "open": float(row[1]), "high": float(row[2]),
                        "low": float(row[3]), "close": float(row[4]), "volume": float(row[5]),
                        "close_time": opened + seconds * 1000 - 1})
        return out

    async def get_order_book_raw(self, symbol: str, limit: int = 20, category: Optional[str] = None):
        cat = category if category in self.CATEGORIES else self.category
        result = await self._get("/v5/market/orderbook", {"category": cat, "symbol": symbol.upper(),
                                                          "limit": min(200, max(1, limit))})
        return {"bids": result.get("b") or [], "asks": result.get("a") or [], "ts": result.get("ts")}

    async def get_funding_rate(self, symbol: str, category: Optional[str] = None) -> dict[str, Any]:
        """Latest published funding observation for a linear or inverse perpetual contract."""
        cat = category if category in ("linear", "inverse") else self.category
        if cat not in ("linear", "inverse"):
            raise ValueError("Funding rates are available only for Bybit linear or inverse derivatives")
        result = await self._get("/v5/market/funding/history", {
            "category": cat, "symbol": symbol.upper(), "limit": 1,
        })
        rows = result.get("list") or []
        if not rows:
            raise RuntimeError(f"Bybit returned no funding history for {symbol.upper()} ({cat})")
        row = rows[0]
        try:
            return {
                "provider": "bybit", "category": cat, "symbol": symbol.upper(),
                "funding_rate": float(row["fundingRate"]),
                "funding_time": int(row["fundingRateTimestamp"]),
            }
        except (KeyError, TypeError, ValueError):
            raise RuntimeError("Bybit funding history payload is malformed") from None

    async def get_open_interest(self, symbol: str, interval: str = "1h", limit: int = 50,
                                category: Optional[str] = None) -> list[dict[str, Any]]:
        """Chronological open-interest observations for a linear or inverse contract."""
        cat = category if category in ("linear", "inverse") else self.category
        if cat not in ("linear", "inverse"):
            raise ValueError("Open interest is available only for Bybit linear or inverse derivatives")
        if interval not in ("5min", "15min", "30min", "1h", "4h", "1d"):
            raise ValueError("Unsupported Bybit open-interest interval")
        result = await self._get("/v5/market/open-interest", {
            "category": cat, "symbol": symbol.upper(), "intervalTime": interval,
            "limit": min(200, max(1, limit)),
        })
        rows = result.get("list") or []
        try:
            return [{
                "provider": "bybit", "category": cat, "symbol": symbol.upper(),
                "timestamp": int(row["timestamp"]), "open_interest": float(row["openInterest"]),
                "interval": interval,
            } for row in sorted(rows, key=lambda item: int(item["timestamp"]))]
        except (KeyError, TypeError, ValueError):
            raise RuntimeError("Bybit open-interest payload is malformed") from None

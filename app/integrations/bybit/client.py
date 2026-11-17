"""Unauthenticated Bybit V5 public market data client."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote


class BybitClient(BaseProvider):
    name = "bybit"

    def __init__(self, settings: Optional[Settings] = None, category: str = "spot"):
        self.settings = settings or get_settings()
        self.category = category if category in ("spot", "linear", "inverse") else "spot"
        self.base_url = "https://api.bybit.com"

    @property
    def configured(self) -> bool:
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
        cat = category if category in ("spot", "linear", "inverse") else self.category
        iv = {"1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60",
              "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D", "1w": "W", "1M": "M"}.get(interval)
        if not iv:
            raise ValueError(f"Unsupported Bybit kline interval: {interval}")
        result = await self._get("/v5/market/kline", {"category": cat, "symbol": symbol.upper(),
                                                      "interval": iv, "limit": min(1000, max(1, limit))})
        out = []
        for row in reversed(result.get("list") or []):
            out.append({"open_time": int(row[0]), "open": float(row[1]), "high": float(row[2]),
                        "low": float(row[3]), "close": float(row[4]), "volume": float(row[5]),
                        "close_time": None})
        return out

    async def get_order_book_raw(self, symbol: str, limit: int = 20, category: Optional[str] = None):
        cat = category if category in ("spot", "linear", "inverse") else self.category
        result = await self._get("/v5/market/orderbook", {"category": cat, "symbol": symbol.upper(),
                                                          "limit": min(200, max(1, limit))})
        return {"bids": result.get("b") or [], "asks": result.get("a") or [], "ts": result.get("ts")}

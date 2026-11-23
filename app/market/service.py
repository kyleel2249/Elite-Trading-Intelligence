"""Unified market data service."""
from __future__ import annotations

from typing import Any, Optional

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.integrations.bybit import BybitClient
from app.integrations.oanda import OandaClient
from app.market.data_quality import assess_quote, assess_kline
from app.market.normalization import normalize_order_book, normalize_binance_kline


class MarketService:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.alpaca = AlpacaClient(self.settings)
        self.binance = BinanceClient(self.settings)
        self.bybit = BybitClient(self.settings)
        self.oanda = OandaClient(self.settings)

    async def get_snapshot(self, provider: str, symbol: str) -> dict[str, Any]:
        provider = provider.lower()
        if provider in ("bybit", "binance"):
            client = self.bybit if provider == "bybit" else self.binance
            q = await client.get_quote(symbol)
            q = assess_quote(q, self.settings.data_max_age_seconds)
            return {
                "provider": q.provider,
                "symbol": q.symbol,
                "asset_class": q.asset_class,
                "price": q.price,
                "bid": q.bid,
                "ask": q.ask,
                "volume": q.volume,
                "data_status": q.data_status,
                "ts_utc": q.ts_utc.isoformat(),
                "retrieved_at": q.retrieved_at.isoformat(),
                "exchange": q.exchange,
                "quote_currency": q.quote_currency,
            }
        if provider == "alpaca":
            if not self.alpaca.configured:
                return {"provider": "alpaca", "symbol": symbol, "data_status": "unavailable", "error": "not_configured"}
            from app.markets.registry import classify
            from app.markets.types import AssetClass
            is_option = classify(symbol).asset_class == AssetClass.OPTION
            q = await (self.alpaca.get_option_quote(symbol) if is_option else self.alpaca.get_quote(symbol))
            q = assess_quote(q, self.settings.data_max_age_seconds)
            return {
                "provider": q.provider,
                "symbol": q.symbol,
                "asset_class": q.asset_class,
                "price": q.price,
                "bid": q.bid,
                "ask": q.ask,
                "data_status": q.data_status,
                "ts_utc": q.ts_utc.isoformat(),
                "retrieved_at": q.retrieved_at.isoformat(),
                "exchange": q.exchange,
                "quote_currency": q.quote_currency,
            }
        if provider == "oanda":
            if not self.oanda.configured:
                return {"provider": "oanda", "symbol": symbol, "data_status": "unavailable", "error": "not_configured"}
            q = await self.oanda.get_quote(symbol)
            was_closed = q.data_status == "market_closed"
            q = assess_quote(q, self.settings.data_max_age_seconds)
            status = "market_closed" if was_closed and q.data_status in ("fresh", "delayed") else q.data_status
            return {
                "provider": q.provider,
                "symbol": q.symbol,
                "venue_symbol": (q.meta or {}).get("venue_symbol"),
                "asset_class": q.asset_class,
                "price": q.price,
                "bid": q.bid,
                "ask": q.ask,
                "data_status": status,
                "tradeable": (q.meta or {}).get("tradeable"),
                "ts_utc": q.ts_utc.isoformat(),
                "retrieved_at": q.retrieved_at.isoformat(),
                "exchange": q.exchange,
                "quote_currency": q.quote_currency,
            }
        raise ValueError(f"Unknown provider: {provider}")

    async def get_derivatives_context(
        self,
        symbol: str,
        category: str = "linear",
        interval: str = "1h",
        limit: int = 50,
    ) -> dict[str, Any]:
        """Read-only funding and open-interest context for Bybit perpetual contracts."""
        import asyncio

        category = category.lower()
        if category not in ("linear", "inverse"):
            raise ValueError("Bybit derivatives context requires linear or inverse category")
        normalized_symbol = symbol.upper().strip()
        if not normalized_symbol:
            raise ValueError("symbol is required")
        funding, observations = await asyncio.gather(
            self.bybit.get_funding_rate(normalized_symbol, category=category),
            self.bybit.get_open_interest(normalized_symbol, interval=interval, limit=limit, category=category),
        )
        latest = observations[-1] if observations else None
        previous = observations[-2] if len(observations) > 1 else None
        change = None
        if latest and previous and previous["open_interest"] != 0:
            change = (latest["open_interest"] - previous["open_interest"]) / previous["open_interest"]
        return {
            "provider": "bybit",
            "symbol": normalized_symbol,
            "category": category,
            "funding": funding,
            "open_interest": observations,
            "open_interest_interval": interval,
            "open_interest_sample_count": len(observations),
            "latest_open_interest": latest,
            "open_interest_change_fraction": change,
            "read_only": True,
        }

    async def get_order_book(self, symbol: str, depth: int = 20) -> dict[str, Any]:
        """Bybit public order book depth + liquidity metrics."""

        symbol = symbol.upper()
        data = await self.bybit.get_order_book_raw(symbol, limit=depth)
        bids = [[float(p), float(q)] for p, q in data.get("bids", [])]
        asks = [[float(p), float(q)] for p, q in data.get("asks", [])]
        return normalize_order_book("bybit", symbol, bids, asks, depth=depth)

    async def get_history(
        self,
        provider: str,
        symbol: str,
        interval: str = "1h",
        limit: int = 100,
        category: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        provider = provider.lower()
        if provider in ("bybit", "binance"):
            client = self.bybit if provider == "bybit" else self.binance
            raw = await client.get_klines(symbol, interval=interval, limit=limit, **({"category": category} if provider == "bybit" and category else {}))
            out = []
            for row in raw:
                nk = normalize_binance_kline(row, symbol, interval) | {"provider": provider}
                out.append(assess_kline(nk))
            return out
        if provider == "oanda":
            raw = await self.oanda.get_candles(symbol, interval=interval, limit=limit)
            return [assess_kline(normalize_binance_kline(row, symbol, interval)) for row in raw]
        if provider == "alpaca":
            raw = await self.alpaca.get_bars(symbol, interval=interval, limit=limit)
            return [assess_kline(normalize_binance_kline(row, symbol, interval) | {"provider": "alpaca"}) for row in raw]
        raise ValueError(f"History not yet implemented for provider: {provider}")

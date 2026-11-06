"""Process-wide WebSocket lifecycle hub."""
from __future__ import annotations

import logging
from typing import Any, Optional

from app.config import Settings, get_settings
from app.integrations.binance.websocket import BinanceWebSocketManager
from app.integrations.alpaca.websocket import AlpacaWebSocketManager

logger = logging.getLogger(__name__)


class StreamHub:
    """Singleton-style hub started from FastAPI lifespan."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.binance = BinanceWebSocketManager(testnet=self.settings.binance_testnet_enabled)
        self.alpaca = AlpacaWebSocketManager(self.settings)
        self._started = False
        self.latest_binance: dict[str, Any] = {}
        self.latest_alpaca: dict[str, Any] = {}

        def _binance_handler(msg: dict) -> None:
            # Keep last payload per stream key when possible
            key = msg.get("s") or msg.get("symbol") or "unknown"
            self.latest_binance[str(key)] = msg

        def _alpaca_handler(msg: dict) -> None:
            sym = msg.get("S") or msg.get("symbol") or "unknown"
            self.latest_alpaca[str(sym)] = msg

        self.binance.on_message(_binance_handler)
        self.alpaca.on_message(_alpaca_handler)

    async def start(self, default_symbols: Optional[list[str]] = None) -> None:
        if self._started:
            return
        symbols = default_symbols or ["btcusdt", "ethusdt"]
        # Binance public streams — safe without keys
        streams = []
        for s in symbols:
            streams.extend(
                [
                    f"{s}@trade",
                    f"{s}@bookTicker",
                    f"{s}@depth20@100ms",
                ]
            )
        self.binance.subscribe(streams)
        await self.binance.start()

        # Alpaca only if configured
        if self.settings.alpaca_configured:
            self.alpaca.subscribe_symbols(["AAPL", "SPY"])
            await self.alpaca.start()
        self._started = True
        logger.info("StreamHub started")

    async def stop(self) -> None:
        await self.binance.stop()
        await self.alpaca.stop()
        self._started = False
        logger.info("StreamHub stopped")

    def status(self) -> dict[str, Any]:
        return {
            "started": self._started,
            "binance": self.binance.status(),
            "alpaca": self.alpaca.status(),
            "latest_binance_symbols": list(self.latest_binance.keys())[:20],
            "latest_alpaca_symbols": list(self.latest_alpaca.keys())[:20],
        }


# Module-level hub used by the app
stream_hub = StreamHub()

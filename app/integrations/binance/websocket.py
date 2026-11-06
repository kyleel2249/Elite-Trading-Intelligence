"""Binance WebSocket streams — trade, bookTicker, depth, kline."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)


class BinanceWebSocketManager:
    """
    Lightweight multi-stream manager with reconnect + heartbeat awareness.
    Does not pretend to be connected when the socket is down.
    """

    def __init__(self, testnet: bool = False):
        self.testnet = testnet
        if testnet:
            self.base = "wss://testnet.binance.vision/ws"
        else:
            self.base = "wss://stream.binance.com:9443/ws"
        self._ws: Any = None
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._subscriptions: list[str] = []
        self._handlers: list[Callable[[dict], Any]] = []
        self.last_message_at: Optional[datetime] = None
        self.connected = False
        self.reconnect_count = 0

    def on_message(self, handler: Callable[[dict], Any]) -> None:
        self._handlers.append(handler)

    def subscribe(self, streams: list[str]) -> None:
        """streams e.g. ['btcusdt@trade', 'btcusdt@bookTicker', 'btcusdt@depth20@100ms']"""
        for s in streams:
            if s not in self._subscriptions:
                self._subscriptions.append(s)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            await self._ws.close()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self.connected = False

    def status(self) -> dict[str, Any]:
        return {
            "provider": "binance",
            "connected": self.connected,
            "testnet": self.testnet,
            "subscriptions": list(self._subscriptions),
            "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
            "reconnect_count": self.reconnect_count,
        }

    async def _run_loop(self) -> None:
        backoff = 1.0
        while self._running:
            if not self._subscriptions:
                await asyncio.sleep(1)
                continue
            # Combined stream URL
            stream_path = "/".join(self._subscriptions)
            url = f"{self.base}/{stream_path}" if len(self._subscriptions) == 1 else (
                self.base.replace("/ws", "/stream") + "?streams=" + "/".join(self._subscriptions)
            )
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                    self._ws = ws
                    self.connected = True
                    backoff = 1.0
                    logger.info("Binance WS connected: %s", url)
                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            msg = json.loads(raw)
                            # Combined stream wraps payload
                            payload = msg.get("data", msg)
                            self.last_message_at = datetime.now(timezone.utc)
                            for h in self._handlers:
                                try:
                                    res = h(payload)
                                    if asyncio.iscoroutine(res):
                                        await res
                                except Exception as e:
                                    logger.exception("WS handler error: %s", e)
                        except json.JSONDecodeError:
                            continue
            except ConnectionClosed:
                self.connected = False
                self.reconnect_count += 1
                logger.warning("Binance WS closed; reconnecting in %.1fs", backoff)
            except Exception as e:
                self.connected = False
                self.reconnect_count += 1
                logger.warning("Binance WS error: %s; reconnecting in %.1fs", e, backoff)
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

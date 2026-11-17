"""Bybit V5 public WebSocket stream manager with application heartbeat and reconnects."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)
_CATEGORIES = {"spot", "linear", "inverse"}


class BybitWebSocketManager:
    def __init__(self, category: str = "spot", testnet: bool = False):
        if category not in _CATEGORIES:
            raise ValueError("Bybit public stream category must be spot, linear or inverse")
        self.category, self.testnet = category, testnet
        host = "stream-testnet.bybit.com" if testnet else "stream.bybit.com"
        self.base = f"wss://{host}/v5/public/{category}"
        self._ws: Any = None
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._topics: list[str] = []
        self._handlers: list[Callable[[dict], Any]] = []
        self.last_message_at: Optional[datetime] = None
        self.connected = False
        self.reconnect_count = 0

    def on_message(self, handler: Callable[[dict], Any]) -> None:
        self._handlers.append(handler)

    def subscribe(self, symbols: list[str]) -> None:
        for symbol in symbols:
            sym = str(symbol).upper().strip()
            if not sym or not sym.isalnum():
                continue
            for topic in (f"tickers.{sym}", f"publicTrade.{sym}", f"orderbook.1.{sym}"):
                if topic not in self._topics:
                    self._topics.append(topic)

    async def reconnect(self) -> None:
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

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
        return {"provider": "bybit", "category": self.category, "connected": self.connected,
                "testnet": self.testnet, "subscriptions": list(self._topics),
                "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
                "reconnect_count": self.reconnect_count}

    async def _dispatch(self, payload: dict) -> None:
        self.last_message_at = datetime.now(timezone.utc)
        for handler in self._handlers:
            try:
                result = handler(payload)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.exception("Bybit websocket handler failed")

    async def _run_loop(self) -> None:
        backoff = 1.0
        while self._running:
            if not self._topics:
                await asyncio.sleep(1)
                continue
            try:
                async with websockets.connect(self.base, ping_interval=None, close_timeout=5) as ws:
                    self._ws = ws
                    self.connected = True
                    backoff = 1.0
                    await ws.send(json.dumps({"op": "subscribe", "args": self._topics[:]}))
                    logger.info("Bybit %s WS connected (%d topics)", self.category, len(self._topics))
                    while self._running:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=20)
                        except asyncio.TimeoutError:
                            await ws.send(json.dumps({"op": "ping"}))
                            continue
                        try:
                            message = json.loads(raw)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        if not isinstance(message, dict) or message.get("op") in ("pong", "subscribe"):
                            continue
                        if isinstance(message.get("data"), dict):
                            await self._dispatch({"topic": message.get("topic"), "type": message.get("type"),
                                                  "ts": message.get("ts"), **message["data"]})
                        elif isinstance(message.get("data"), list):
                            for row in message["data"]:
                                if isinstance(row, dict):
                                    await self._dispatch({"topic": message.get("topic"), "type": message.get("type"),
                                                          "ts": message.get("ts"), **row})
            except asyncio.CancelledError:
                raise
            except (ConnectionClosed, OSError, asyncio.TimeoutError) as exc:
                logger.warning("Bybit %s WS disconnected: %s", self.category, type(exc).__name__)
            except Exception:
                logger.exception("Bybit %s WS error", self.category)
            finally:
                self.connected = False
                self._ws = None
            if self._running:
                self.reconnect_count += 1
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

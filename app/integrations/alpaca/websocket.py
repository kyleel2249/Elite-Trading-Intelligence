"""Alpaca WebSocket — trades/quotes/bars (requires data subscription)."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import websockets
from websockets.exceptions import ConnectionClosed

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)


class AlpacaWebSocketManager:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.url = "wss://stream.data.alpaca.markets/v2/iex"  # IEX free tier common
        self._ws: Any = None
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._symbols: list[str] = []
        self._handlers: list[Callable[[dict], Any]] = []
        self.last_message_at: Optional[datetime] = None
        self.connected = False
        self.authenticated = False
        self.reconnect_count = 0

    def on_message(self, handler: Callable[[dict], Any]) -> None:
        self._handlers.append(handler)

    def subscribe_symbols(self, symbols: list[str]) -> None:
        for s in symbols:
            u = s.upper()
            if u not in self._symbols:
                self._symbols.append(u)

    async def start(self) -> None:
        if not self.settings.alpaca_api_key or not self.settings.alpaca_secret_key:
            logger.warning("Alpaca WS not started: missing credentials")
            return
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
        self.authenticated = False

    def status(self) -> dict[str, Any]:
        return {
            "provider": "alpaca",
            "connected": self.connected,
            "authenticated": self.authenticated,
            "symbols": list(self._symbols),
            "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
            "reconnect_count": self.reconnect_count,
        }

    async def _run_loop(self) -> None:
        backoff = 1.0
        while self._running:
            try:
                async with websockets.connect(self.url, ping_interval=20, ping_timeout=20) as ws:
                    self._ws = ws
                    self.connected = True
                    # Auth
                    auth = {
                        "action": "auth",
                        "key": self.settings.alpaca_api_key,
                        "secret": self.settings.alpaca_secret_key,
                    }
                    await ws.send(json.dumps(auth))
                    auth_resp = json.loads(await ws.recv())
                    # Expect list of messages
                    msgs = auth_resp if isinstance(auth_resp, list) else [auth_resp]
                    self.authenticated = any(m.get("T") == "success" or m.get("msg") == "authenticated" for m in msgs)
                    if not self.authenticated:
                        logger.error("Alpaca WS auth failed: %s", auth_resp)
                        self.connected = False
                        await asyncio.sleep(5)
                        continue
                    if self._symbols:
                        sub = {
                            "action": "subscribe",
                            "trades": self._symbols,
                            "quotes": self._symbols,
                            "bars": self._symbols,
                        }
                        await ws.send(json.dumps(sub))
                    backoff = 1.0
                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            data = json.loads(raw)
                            items = data if isinstance(data, list) else [data]
                            self.last_message_at = datetime.now(timezone.utc)
                            for item in items:
                                for h in self._handlers:
                                    try:
                                        res = h(item)
                                        if asyncio.iscoroutine(res):
                                            await res
                                    except Exception as e:
                                        logger.exception("Alpaca WS handler error: %s", e)
                        except json.JSONDecodeError:
                            continue
            except ConnectionClosed:
                self.connected = False
                self.authenticated = False
                self.reconnect_count += 1
            except Exception as e:
                self.connected = False
                self.authenticated = False
                self.reconnect_count += 1
                logger.warning("Alpaca WS error: %s", e)
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

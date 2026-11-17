"""Bybit V5 public WebSocket stream manager with live subscription updates and reconnects."""
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
_TOPICS_PER_SYMBOL = ("tickers.{symbol}", "publicTrade.{symbol}", "orderbook.1.{symbol}")


class BybitWebSocketManager:
    """One manager per Bybit category; subscriptions added after connect are sent live."""

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
        self._sent_topics: set[str] = set()
        self._handlers: list[Callable[[dict], Any]] = []
        self.last_message_at: Optional[datetime] = None
        self.connected = False
        self.reconnect_count = 0
        self.subscription_errors: list[str] = []

    def on_message(self, handler: Callable[[dict], Any]) -> None:
        if handler not in self._handlers:
            self._handlers.append(handler)

    def subscribe(self, symbols: list[str]) -> None:
        for symbol in symbols:
            sym = str(symbol).upper().strip()
            if not sym or not sym.isalnum():
                continue
            for template in _TOPICS_PER_SYMBOL:
                topic = template.format(symbol=sym)
                if topic not in self._topics:
                    self._topics.append(topic)

    def unsubscribe(self, symbols: list[str]) -> None:
        remove = {
            template.format(symbol=str(symbol).upper().strip())
            for symbol in symbols if str(symbol).strip().isalnum()
            for template in _TOPICS_PER_SYMBOL
        }
        self._topics = [topic for topic in self._topics if topic not in remove]

    async def _sync_subscriptions(self) -> None:
        """Apply queued additions/removals to an already-connected socket."""
        if not self._ws:
            return
        desired = set(self._topics)
        removed = sorted(self._sent_topics - desired)
        added = sorted(desired - self._sent_topics)
        if removed:
            await self._ws.send(json.dumps({"op": "unsubscribe", "args": removed}))
            self._sent_topics.difference_update(removed)
        if added:
            await self._ws.send(json.dumps({"op": "subscribe", "args": added}))
            self._sent_topics.update(added)

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
        self._sent_topics.clear()

    def status(self) -> dict[str, Any]:
        return {
            "provider": "bybit", "category": self.category, "connected": self.connected,
            "testnet": self.testnet, "subscriptions": list(self._topics),
            "active_subscriptions": sorted(self._sent_topics),
            "subscription_errors": list(self.subscription_errors[-10:]),
            "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
            "reconnect_count": self.reconnect_count,
        }

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
                    self._sent_topics.clear()
                    self.subscription_errors.clear()
                    backoff = 1.0
                    await self._sync_subscriptions()
                    logger.info("Bybit %s WS connected (%d topics)", self.category, len(self._sent_topics))
                    idle_seconds = 0
                    while self._running:
                        await self._sync_subscriptions()
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=2)
                            idle_seconds = 0
                        except asyncio.TimeoutError:
                            idle_seconds += 2
                            if idle_seconds >= 20:
                                await ws.send(json.dumps({"op": "ping"}))
                                idle_seconds = 0
                            continue
                        try:
                            message = json.loads(raw)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        if not isinstance(message, dict):
                            continue
                        if message.get("op") == "subscribe":
                            if message.get("success") is False:
                                error = str(message.get("ret_msg") or message.get("retMsg") or "subscription rejected")
                                self.subscription_errors.append(error[:200])
                                logger.warning("Bybit %s subscription rejected: %s", self.category, error[:200])
                            continue
                        if message.get("op") in ("pong", "unsubscribe"):
                            continue
                        if isinstance(message.get("data"), dict):
                            await self._dispatch({
                                "topic": message.get("topic"), "type": message.get("type"),
                                "ts": message.get("ts"), **message["data"],
                            })
                        elif isinstance(message.get("data"), list):
                            for row in message["data"]:
                                if isinstance(row, dict):
                                    await self._dispatch({
                                        "topic": message.get("topic"), "type": message.get("type"),
                                        "ts": message.get("ts"), **row,
                                    })
            except asyncio.CancelledError:
                raise
            except (ConnectionClosed, OSError, asyncio.TimeoutError) as exc:
                logger.warning("Bybit %s WS disconnected: %s", self.category, type(exc).__name__)
            except Exception:
                logger.exception("Bybit %s WS error", self.category)
            finally:
                self.connected = False
                self._ws = None
                self._sent_topics.clear()
            if self._running:
                self.reconnect_count += 1
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

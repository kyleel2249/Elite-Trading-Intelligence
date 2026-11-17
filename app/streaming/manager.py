"""Process-wide WebSocket lifecycle hub + live quote fan-out."""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import Settings, get_settings
from app.integrations.binance.websocket import BinanceWebSocketManager
from app.integrations.bybit.websocket import BybitWebSocketManager
from app.integrations.alpaca.websocket import AlpacaWebSocketManager

logger = logging.getLogger(__name__)

# Hard allowlist — research/demo symbols only (not a trading permission)
BINANCE_ALLOWLIST = {
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
}
ALPACA_ALLOWLIST = {"AAPL", "SPY", "QQQ", "MSFT", "TSLA", "NVDA", "AMZN", "META"}

_SYM_RE = re.compile(r"^[A-Z0-9]{2,20}$")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class StreamHub:
    """Singleton-style hub started from FastAPI lifespan."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.binance = BinanceWebSocketManager(testnet=self.settings.binance_testnet_enabled)  # legacy status only
        self.bybit = BybitWebSocketManager(category="spot", testnet=False)
        self.alpaca = AlpacaWebSocketManager(self.settings)
        self._started = False
        self.latest_binance: dict[str, Any] = {}
        self.latest_bybit: dict[str, Any] = {}
        self.latest_alpaca: dict[str, Any] = {}
        # Normalized last quote per SYMBOL (uppercase)
        self.quotes: dict[str, dict[str, Any]] = {}
        self._binance_symbols: set[str] = set()
        self._bybit_symbols: set[str] = set()
        self._alpaca_symbols: set[str] = set()
        self._sse_queues: list[asyncio.Queue] = []
        self._lock = asyncio.Lock()

        def _binance_handler(msg: dict) -> None:
            key = str(msg.get("s") or msg.get("symbol") or "unknown").upper()
            self.latest_binance[key] = msg
            q = self._normalize_binance(msg)
            if q:
                self.quotes[q["symbol"]] = q
                self._broadcast(q)

        def _alpaca_handler(msg: dict) -> None:
            sym = str(msg.get("S") or msg.get("symbol") or "unknown").upper()
            self.latest_alpaca[sym] = msg
            q = self._normalize_alpaca(msg)
            if q:
                self.quotes[q["symbol"]] = q
                self._broadcast(q)

        self.binance.on_message(_binance_handler)

        def _bybit_handler(msg: dict) -> None:
            q = self._normalize_bybit(msg)
            if not q.get("symbol") or not q.get("price"):
                return
            self.latest_bybit[q["symbol"]] = msg
            self.quotes[q["symbol"]] = q
            self._broadcast(q)

        self.bybit.on_message(_bybit_handler)
        self.alpaca.on_message(_alpaca_handler)

    def _broadcast(self, quote: dict[str, Any]) -> None:
        dead: list[asyncio.Queue] = []
        for q in self._sse_queues:
            try:
                q.put_nowait(quote)
            except asyncio.QueueFull:
                try:
                    _ = q.get_nowait()
                    q.put_nowait(quote)
                except Exception:
                    dead.append(q)
            except Exception:
                dead.append(q)
        for d in dead:
            if d in self._sse_queues:
                self._sse_queues.remove(d)

    def register_sse(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._sse_queues.append(q)
        return q

    def unregister_sse(self, q: asyncio.Queue) -> None:
        if q in self._sse_queues:
            self._sse_queues.remove(q)

    @staticmethod
    def _normalize_binance(msg: dict) -> Optional[dict[str, Any]]:
        sym = str(msg.get("s") or "").upper()
        if not sym:
            return None
        # trade
        if "p" in msg and msg.get("e") in (None, "trade") and "b" not in msg:
            try:
                price = float(msg["p"])
            except (TypeError, ValueError):
                return None
            return {
                "provider": "binance",
                "symbol": sym,
                "event": msg.get("e") or "trade",
                "price": price,
                "bid": None,
                "ask": None,
                "qty": float(msg["q"]) if msg.get("q") is not None else None,
                "ts": _utcnow().isoformat(),
                "raw_event": msg.get("e"),
            }
        # bookTicker
        if "b" in msg and "a" in msg:
            try:
                bid = float(msg["b"])
                ask = float(msg["a"])
            except (TypeError, ValueError):
                return None
            mid = (bid + ask) / 2.0 if bid and ask else None
            return {
                "provider": "binance",
                "symbol": sym,
                "event": "bookTicker",
                "price": mid,
                "bid": bid,
                "ask": ask,
                "qty": None,
                "ts": _utcnow().isoformat(),
                "raw_event": "bookTicker",
            }
        return None

    @staticmethod
    def _normalize_alpaca(msg: dict) -> Optional[dict[str, Any]]:
        t = msg.get("T")
        sym = str(msg.get("S") or "").upper()
        if not sym:
            return None
        if t == "t":  # trade
            try:
                price = float(msg.get("p"))
            except (TypeError, ValueError):
                return None
            return {
                "provider": "alpaca",
                "symbol": sym,
                "event": "trade",
                "price": price,
                "bid": None,
                "ask": None,
                "qty": float(msg["s"]) if msg.get("s") is not None else None,
                "ts": _utcnow().isoformat(),
                "raw_event": "t",
            }
        if t == "q":  # quote
            try:
                bid = float(msg.get("bp")) if msg.get("bp") is not None else None
                ask = float(msg.get("ap")) if msg.get("ap") is not None else None
            except (TypeError, ValueError):
                return None
            mid = None
            if bid is not None and ask is not None:
                mid = (bid + ask) / 2.0
            return {
                "provider": "alpaca",
                "symbol": sym,
                "event": "quote",
                "price": mid,
                "bid": bid,
                "ask": ask,
                "qty": None,
                "ts": _utcnow().isoformat(),
                "raw_event": "q",
            }
        return None

    @staticmethod
    def _normalize_bybit(msg: dict) -> dict[str, Any]:
        topic = str(msg.get("topic") or "")
        sym = str(msg.get("symbol") or topic.rsplit(".", 1)[-1]).upper()
        try:
            bid = float(msg.get("bid1Price") or 0)
            ask = float(msg.get("ask1Price") or 0)
            last = float(msg.get("lastPrice") or msg.get("p") or 0)
        except (TypeError, ValueError):
            return {"symbol": sym, "price": None}
        return {"provider": "bybit", "symbol": sym, "event": "ticker" if bid and ask else "trade",
                "price": last or ((bid + ask) / 2 if bid and ask else None), "bid": bid or None,
                "ask": ask or None, "qty": float(msg.get("v") or 0) or None,
                "ts": _utcnow().isoformat(), "raw_event": topic}

    def get_live(self, symbol: str, provider: Optional[str] = None) -> dict[str, Any]:
        sym = symbol.upper().strip()
        q = self.quotes.get(sym)
        if q and (provider is None or q.get("provider") == provider):
            age = None
            try:
                ts = datetime.fromisoformat(q["ts"].replace("Z", "+00:00"))
                age = (_utcnow() - ts).total_seconds()
            except Exception:
                pass
            return {
                "status": "ok",
                "source": "websocket",
                "fresh": age is not None and age < 5.0,
                "age_seconds": age,
                **q,
            }
        # Fallback: raw caches
        if provider in (None, "bybit") and sym in self.latest_bybit:
            return {"status": "ok", "source": "websocket_raw", "fresh": False, **self._normalize_bybit(self.latest_bybit[sym])}
        if provider in (None, "binance") and sym in self.latest_binance:
            n = self._normalize_binance(self.latest_binance[sym])
            if n:
                return {"status": "ok", "source": "websocket_raw", "fresh": False, **n}
        if provider in (None, "alpaca") and sym in self.latest_alpaca:
            n = self._normalize_alpaca(self.latest_alpaca[sym])
            if n:
                return {"status": "ok", "source": "websocket_raw", "fresh": False, **n}
        return {
            "status": "no_data",
            "symbol": sym,
            "provider": provider,
            "hint": "Symbol not streaming or no tick yet",
            "stream_started": self._started,
        }

    async def start(self, default_symbols: Optional[list[str]] = None) -> None:
        if self._started:
            return
        symbols = [s.lower() for s in (default_symbols or ["btcusdt", "ethusdt"])]
        for s in symbols:
            self._bybit_symbols.add(s.upper())
        self.bybit.subscribe([s.upper() for s in symbols])
        await self.bybit.start()

        if self.settings.alpaca_configured:
            for s in ("AAPL", "SPY"):
                self._alpaca_symbols.add(s)
            self.alpaca.subscribe_symbols(["AAPL", "SPY"])
            await self.alpaca.start()
        self._started = True
        logger.info("StreamHub started")

    async def stop(self) -> None:
        await self.bybit.stop()
        await self.binance.stop()
        await self.alpaca.stop()
        self._started = False
        logger.info("StreamHub stopped")

    async def subscribe(
        self,
        symbols: list[str],
        provider: str = "bybit",
    ) -> dict[str, Any]:
        """
        Dynamically add allowlisted symbols.
        Does not place orders — market data only.
        """
        provider = (provider or "bybit").lower()
        accepted: list[str] = []
        rejected: list[dict[str, str]] = []

        for raw in symbols:
            sym = (raw or "").upper().strip()
            if not _SYM_RE.match(sym):
                rejected.append({"symbol": sym, "reason": "invalid_format"})
                continue
            if provider == "bybit":
                if sym not in BINANCE_ALLOWLIST:
                    rejected.append({"symbol": sym, "reason": "not_in_allowlist"})
                    continue
                if sym in self._bybit_symbols:
                    accepted.append(sym)
                    continue
                self._bybit_symbols.add(sym)
                self.bybit.subscribe([sym])
                accepted.append(sym)
            elif provider == "alpaca":
                if sym not in ALPACA_ALLOWLIST:
                    rejected.append({"symbol": sym, "reason": "not_in_allowlist"})
                    continue
                if not self.settings.alpaca_configured:
                    rejected.append({"symbol": sym, "reason": "alpaca_not_configured"})
                    continue
                self._alpaca_symbols.add(sym)
                self.alpaca.subscribe_symbols([sym])
                accepted.append(sym)
            else:
                rejected.append({"symbol": sym, "reason": "unknown_provider"})

        # Reconnect Bybit after adding public topic subscriptions.
        if provider == "bybit" and accepted:
            await self.bybit.reconnect()

        return {
            "provider": provider,
            "accepted": accepted,
            "rejected": rejected,
            "active_bybit": sorted(self._bybit_symbols),
            "active_alpaca": sorted(self._alpaca_symbols),
            "note": "Market data subscribe only — no trading path",
        }

    def status(self) -> dict[str, Any]:
        return {
            "started": self._started,
            "bybit": self.bybit.status(),
            "binance": self.binance.status(),
            "alpaca": self.alpaca.status(),
            "latest_bybit_symbols": list(self.latest_bybit.keys())[:20],
            "latest_binance_symbols": list(self.latest_binance.keys())[:20],
            "latest_alpaca_symbols": list(self.latest_alpaca.keys())[:20],
            "normalized_quotes": list(self.quotes.keys())[:40],
            "sse_listeners": len(self._sse_queues),
            "allowlist": {
                "bybit": sorted(BINANCE_ALLOWLIST),
                "alpaca": sorted(ALPACA_ALLOWLIST),
            },
        }


stream_hub = StreamHub()

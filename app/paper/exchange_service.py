"""Async service around PaperEngine: loads/saves state, fetches VERIFIED live quotes, processes working orders."""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Protocol

from app.paper.engine import EPS, PaperConfig, PaperEngine, Snapshot, utcnow
from app.paper.exchange_store import PaperStore, StaleStateError

logger = logging.getLogger("eti.paper")


class QuoteProvider(Protocol):
    async def get(self, symbol: str) -> Optional[Snapshot]: ...


def config_from_env(env: Optional[dict] = None) -> PaperConfig:
    e = env if env is not None else os.environ
    c = PaperConfig()
    for name, cast in (("starting_cash", float), ("taker_fee_bps", float), ("maker_fee_bps", float), ("base_slippage_bps", float),
                       ("impact_bps_full_level", float), ("participation", float), ("max_quote_age_s", float), ("max_spread_bps", float),
                       ("min_notional", float), ("max_open_positions", int), ("max_position_pct", float), ("max_order_pct", float),
                       ("duplicate_window_s", float)):
        raw = e.get(f"PAPER_{name.upper()}")
        if raw not in (None, ""):
            try:
                setattr(c, name, cast(raw))
            except ValueError:
                logger.warning("ignoring invalid PAPER_%s=%r", name.upper(), raw)
    c.participation = min(max(c.participation, 0.01), 1.0)
    return c


class LiveQuoteProvider:
    """Public market data only (no keys). A quote is returned only if the data-quality layer calls it fresh."""

    def __init__(self, settings: Any, provider: str = "binance"):
        self.settings, self.provider = settings, provider

    async def get(self, symbol: str) -> Optional[Snapshot]:
        from app.market.service import MarketService
        svc = MarketService(self.settings)
        try:
            s = await svc.get_snapshot(self.provider, symbol)
        except Exception:
            logger.warning("paper quote fetch failed for %s", symbol, exc_info=True)
            return None
        bid, ask = s.get("bid"), s.get("ask")
        if bid is None or ask is None:
            return None
        try:
            ts = datetime.fromisoformat(str(s.get("ts_utc")).replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
        bids = asks = None
        if self.provider == "binance":
            try:
                book = await svc.get_order_book(symbol, depth=20)
                b, a = book.get("bids"), book.get("asks")
                if b and a:
                    bids = [(float(x[0]), float(x[1])) for x in b]; asks = [(float(x[0]), float(x[1])) for x in a]
            except Exception:
                logger.info("order book unavailable for %s; liquidity will be treated as unknown", symbol)
        return Snapshot(symbol.upper(), float(bid), float(ask), ts, last=s.get("price"), bids=bids, asks=asks,
                        verified=(s.get("data_status") == "fresh"))


class PaperExchange:
    def __init__(self, store: PaperStore, quotes: QuoteProvider, config: Optional[PaperConfig] = None,
                 clock: Callable[[], datetime] = utcnow, kill_switch: Callable[[], bool] = lambda: False, account_id: str = "default"):
        self.store, self.quotes, self.cfg, self.clock = store, quotes, config or PaperConfig(), clock
        self.kill_switch, self.account_id = kill_switch, account_id
        self._lock = asyncio.Lock()

    # -- state plumbing ------------------------------------------------------------------
    def _load(self) -> tuple[PaperEngine, int]:
        state, ver = self.store.load(self.account_id)
        if state is None:
            eng = PaperEngine(self.account_id, self.cfg, clock=self.clock, kill_switch=self.kill_switch)
            eng._log("account_created", None, starting_cash=eng.starting_cash)
            return eng, 0
        return PaperEngine.from_state(state, self.cfg, clock=self.clock, kill_switch=self.kill_switch), ver

    def _save(self, eng: PaperEngine, ver: int) -> int:
        return self.store.save(self.account_id, eng.to_state(), eng.drain_audit(), ver)

    async def _mutate(self, fn: Callable[[PaperEngine], Any]) -> Any:
        async with self._lock:
            for attempt in range(3):
                eng, ver = self._load()
                result = fn(eng)
                try:
                    self._save(eng, ver)
                    return result
                except StaleStateError:
                    logger.info("paper state changed concurrently; retrying (%d)", attempt + 1)
            raise RuntimeError("paper account is busy; try again")

    async def _snap(self, symbol: str) -> Optional[Snapshot]:
        try:
            return await self.quotes.get(symbol.upper())
        except Exception:
            logger.warning("quote provider failed for %s", symbol, exc_info=True)
            return None

    # -- operations ----------------------------------------------------------------------
    async def submit(self, **kw: Any) -> dict:
        snap = await self._snap(kw["symbol"])
        return await self._mutate(lambda e: e.submit(snap=snap, **kw))

    async def submit_oco(self, **kw: Any) -> dict:
        snap = await self._snap(kw["symbol"])
        return await self._mutate(lambda e: e.submit_oco(snap=snap, **kw))

    async def preview(self, **kw: Any) -> dict:
        snap = await self._snap(kw["symbol"])
        eng, _ = self._load()
        return eng.preview(snap=snap, **kw)

    async def cancel(self, order_id: str) -> dict:
        return await self._mutate(lambda e: e.cancel(order_id))

    async def cancel_all(self, symbol: Optional[str] = None) -> dict:
        return {"canceled": await self._mutate(lambda e: e.cancel_all(symbol))}

    async def reset(self, starting_cash: Optional[float] = None) -> dict:
        await self._mutate(lambda e: e.reset(starting_cash))
        return await self.account()

    async def tick(self) -> dict:
        eng, _ = self._load()
        symbols = sorted({o.symbol for o in eng.orders.values() if o.working} | {s for s, h in eng.holdings.items() if h["qty"] > EPS})
        snaps = {s: await self._snap(s) for s in symbols}

        def apply(e: PaperEngine) -> list:
            out = []
            for s, sn in snaps.items():
                if sn is not None:
                    out += e.process_market(sn)
            return out
        fills = await self._mutate(apply) if symbols else []
        return {"symbols": symbols, "fills": fills, "unpriced": [s for s, sn in snaps.items() if sn is None]}

    async def account(self, tick: bool = True) -> dict:
        if tick:
            await self.tick()
        eng, _ = self._load()
        marks = {}
        for s, h in eng.holdings.items():
            if h["qty"] > EPS:
                sn = await self._snap(s)
                if sn and not sn.problem(self.clock(), self.cfg):
                    marks[s] = sn.mid
        view = eng.account_view(marks)
        view["kill_switch"] = bool(self.kill_switch())
        view["unmarked_symbols"] = [p["symbol"] for p in view["positions"] if p["open"] and p["symbol"] not in marks]
        return view

    async def orders(self, status: str = "all") -> list:
        return self._load()[0].list_orders(status)

    async def fills(self, limit: int = 200) -> list:
        return list(reversed(self._load()[0].fills[-limit:]))

    async def audit(self, limit: int = 200) -> list:
        return self.store.audit(self.account_id, limit)


class PaperTickJob:
    """Background loop so resting limit/stop/take-profit orders execute without anyone polling."""

    def __init__(self, exchange_factory: Callable[[], PaperExchange], interval_seconds: float = 5.0):
        self.factory, self.interval_seconds = exchange_factory, interval_seconds
        self._task: Optional[asyncio.Task] = None
        self.runs = 0; self.last_error: Optional[str] = None; self.last_fills = 0

    async def _loop(self) -> None:
        while True:
            try:
                res = await self.factory().tick(); self.runs += 1; self.last_fills = len(res["fills"]); self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as e:  # keep the loop alive
                self.last_error = type(e).__name__
                logger.warning("paper tick failed", exc_info=True)
            await asyncio.sleep(max(self.interval_seconds, 1.0))

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def status(self) -> dict:
        return {"running": self._task is not None, "interval_seconds": self.interval_seconds, "runs": self.runs,
                "last_error": self.last_error, "last_fills": self.last_fills}

"""Async service over the pure engine: fetch a verified book, run the engine under a lock, persist the result.

No FastAPI / SQLAlchemy imports here, so it is unit-testable with an in-memory store and a fake book source.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

from .core import (EPS, Account, Book, MARKET, Order, OrderRequest, PaperConfig, PaperEngine, PaperError, STOP_LOSS,
                   TAKE_PROFIT, utcnow)
from .store import VersionConflict


@dataclass
class PaperSettings:
    starting_cash: float = 10_000.0
    taker_fee_bps: float = 10.0
    maker_fee_bps: float = 10.0
    extra_slippage_bps: float = 1.0
    max_position_notional_pct: float = 25.0

    def config(self) -> PaperConfig:
        return PaperConfig(starting_cash=self.starting_cash, taker_fee_bps=self.taker_fee_bps,
                           maker_fee_bps=self.maker_fee_bps, extra_slippage_bps=self.extra_slippage_bps,
                           max_position_notional_pct=self.max_position_notional_pct)


class PaperService:
    def __init__(self, store, books, settings: Optional[PaperSettings] = None,
                 kill_switch: Callable[[], bool] = lambda: False, clock: Callable[[], datetime] = utcnow):
        self.store, self.books, self.settings = store, books, settings or PaperSettings()
        self._kill, self.clock = kill_switch, clock
        self._locks: dict = {}

    def _lock(self, account_id: str) -> asyncio.Lock:
        return self._locks.setdefault(account_id, asyncio.Lock())

    # ------------------------------------------------------------------ persistence helpers
    def _load(self, account_id: str) -> tuple:
        row = self.store.load(account_id)
        if row is None:
            acct = PaperEngine.new_account(account_id, self.settings.config(), self.clock())
            return PaperEngine(acct), 0
        version, state = row
        return PaperEngine(Account.from_dict(state)), version

    def _commit(self, eng: PaperEngine, version: int) -> int:
        new = self.store.save(eng.acct.account_id, eng.acct.to_dict(), version)
        eng.acct.version = new
        events, eng.audit = eng.audit, []
        self.store.append_events(events)
        return new

    async def _mutate(self, account_id: str, fn):
        """Load -> run -> persist (also when fn raises PaperError, so rejections are audited)."""
        async with self._lock(account_id):
            eng, version = self._load(account_id)
            try:
                result = await fn(eng)
            except PaperError:
                if eng.audit:
                    self.store.append_events(eng.audit)
                    eng.audit = []
                raise
            try:
                self._commit(eng, version)
            except VersionConflict:
                raise PaperError("Account was modified concurrently; please retry")
            return result

    async def _book(self, symbol: str) -> Book:
        return await self.books.get_book(symbol)

    # ------------------------------------------------------------------ operations
    async def ensure_account(self, account_id: str = "default") -> dict:
        async def fn(eng):
            return None
        if self.store.load(account_id) is None:
            await self._mutate(account_id, fn)
        return await self.summary(account_id)

    async def submit(self, account_id: str, req: OrderRequest) -> Order:
        async def fn(eng: PaperEngine):
            book = await self._book(req.symbol)
            o = eng.place_order(req, book, self.clock(), halted=bool(self._kill()))
            return Order.from_dict(o.to_dict())
        return await self._mutate(account_id, fn)

    async def submit_bracket(self, account_id: str, symbol: str, qty: float, stop_price: float,
                             take_profit_price: float, client_order_id: Optional[str] = None) -> list:
        """Stop-loss + take-profit as one OCO pair against existing holdings."""
        async def fn(eng: PaperEngine):
            book = await self._book(symbol)
            now = self.clock()
            group = f"oco-{eng.acct.seq + 1}"
            base = client_order_id or f"bracket-{group}"
            sl = eng.place_order(OrderRequest(symbol, "sell", STOP_LOSS, qty, stop_price=stop_price,
                                              client_order_id=f"{base}-sl", oco_group=group), book, now,
                                 halted=bool(self._kill()))
            try:
                tp = eng.place_order(OrderRequest(symbol, "sell", TAKE_PROFIT, qty, limit_price=take_profit_price,
                                                  client_order_id=f"{base}-tp", oco_group=group), book, now,
                                     halted=bool(self._kill()))
            except PaperError:
                eng.cancel_order(sl.id, now)       # never leave half a bracket
                raise
            return [Order.from_dict(sl.to_dict()), Order.from_dict(tp.to_dict())]
        return await self._mutate(account_id, fn)

    async def preview(self, account_id: str, req: OrderRequest) -> dict:
        eng, _ = self._load(account_id)
        book = await self._book(req.symbol)
        out = eng.preview(req, book, self.clock())
        out["halted"] = bool(self._kill())
        out["available_cash"] = eng.available_cash()
        out["available_qty"] = eng.available_qty(req.symbol.strip().upper())
        return out

    async def cancel(self, account_id: str, order_id: str) -> Order:
        async def fn(eng: PaperEngine):
            return Order.from_dict(eng.cancel_order(order_id, self.clock()).to_dict())
        return await self._mutate(account_id, fn)

    async def cancel_all(self, account_id: str) -> int:
        async def fn(eng: PaperEngine):
            return len(eng.cancel_all(self.clock()))
        return await self._mutate(account_id, fn)

    async def tick(self, account_id: str) -> dict:
        """Advance resting orders using fresh books. Failures to fetch a book skip that symbol only."""
        async def fn(eng: PaperEngine):
            changed, skipped = [], []
            for sym in sorted({o.symbol for o in eng.open_orders()}):
                try:
                    book = await self._book(sym)
                except PaperError as e:
                    skipped.append({"symbol": sym, "reason": str(e)})
                    continue
                changed += [o.id for o in eng.on_tick(book, self.clock())]
            return {"changed": changed, "skipped": skipped}
        return await self._mutate(account_id, fn)

    async def flatten(self, account_id: str) -> dict:
        async def fn(eng: PaperEngine):
            books = {}
            for sym, pos in eng.acct.positions.items():
                if pos.qty > EPS:
                    try:
                        books[sym] = await self._book(sym)
                    except PaperError:
                        pass
            return eng.flatten(books, self.clock())
        return await self._mutate(account_id, fn)

    async def reset(self, account_id: str, starting_cash: Optional[float] = None) -> dict:
        """Explicit, audited wipe of a paper account back to a fresh balance."""
        async with self._lock(account_id):
            row = self.store.load(account_id)
            version = row[0] if row else 0
            cfg = self.settings.config()
            if starting_cash is not None:
                cfg.starting_cash = starting_cash
            eng = PaperEngine(PaperEngine.new_account(account_id, cfg, self.clock()))
            eng.acct.seq = (row[1].get("seq", 0) if row else 0)          # ids keep increasing across resets
            eng._log("account_reset", self.clock(), starting_cash=cfg.starting_cash)
            self._commit(eng, version)
        return await self.summary(account_id)

    # ------------------------------------------------------------------ reads
    async def quote(self, symbol: str) -> dict:
        return (await self._book(symbol)).to_dict()

    async def summary(self, account_id: str = "default") -> dict:
        eng, _ = self._load(account_id)
        marks = {}
        for sym, pos in eng.acct.positions.items():
            if pos.qty > EPS:
                try:
                    marks[sym] = (await self._book(sym)).best_bid
                except PaperError:
                    pass            # fall back to the last stored mark; flagged below
        s = eng.summary(marks)
        stale = [p["symbol"] for p in s["positions"] if p["symbol"] not in marks]
        s["marks_stale_for"] = stale
        s["config"] = eng.acct.config.to_dict()
        s["halted"] = bool(self._kill())
        return s

    def orders(self, account_id: str, status: str = "all", limit: int = 200) -> list:
        eng, _ = self._load(account_id)
        rows = sorted(eng.acct.orders.values(), key=lambda o: o.created_at or self.clock(), reverse=True)
        if status == "open":
            rows = [o for o in rows if o.is_open]
        elif status == "closed":
            rows = [o for o in rows if not o.is_open]
        return [o.to_dict() for o in rows[:limit]]

    def fills(self, account_id: str, limit: int = 200) -> list:
        eng, _ = self._load(account_id)
        return [f.to_dict() for f in reversed(eng.acct.fills[-limit:])]

    def events(self, account_id: str, limit: int = 200, event: Optional[str] = None) -> list:
        return self.store.list_events(account_id, limit, event)

    def record_event(self, account_id: str, event: str, **details) -> None:
        self.store.append_events([{"ts": self.clock().isoformat(), "event": event, "order_id": None,
                                   "account_id": account_id, "details": details}])

"""Periodic mark-to-market for open positions."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from app.config import get_settings
from app.database import SessionLocal
from app.market.service import MarketService
from app.trading.portfolio import PortfolioService

logger = logging.getLogger(__name__)


class MarkToMarketJob:
    def __init__(self, interval_seconds: int = 60):
        self.interval_seconds = interval_seconds
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.last_run: Optional[str] = None
        self.last_error: Optional[str] = None
        self.last_marked: int = 0

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("MarkToMarketJob started (interval=%ss)", self.interval_seconds)

    async def stop(self) -> None:
        self._running = False
        task = self._task
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            finally:
                self._task = None

    def status(self) -> dict:
        return {
            "running": self._running,
            "interval_seconds": self.interval_seconds,
            "last_run": self.last_run,
            "last_marked": self.last_marked,
            "last_error": self.last_error,
            "owner": "Claire Bennett / Omar Diallo process",
        }

    async def run_once(self) -> int:
        settings = get_settings()
        db = SessionLocal()
        try:
            portfolio = PortfolioService(db)
            open_pos = portfolio.list_positions(status="open")
            if not open_pos:
                self.last_marked = 0
                return 0
            mkt = MarketService(settings)
            marks = {}
            for p in open_pos:
                try:
                    snap = await mkt.get_snapshot(p.provider, p.symbol)
                    px = snap.get("price")
                    if px is not None:
                        marks[(p.provider, p.environment, p.symbol)] = float(px)
                except Exception as e:
                    logger.warning("MTM snapshot failed %s %s: %s", p.provider, p.symbol, e)
            portfolio.mark_positions(marks)
            self.last_marked = len(marks)
            from datetime import datetime, timezone

            self.last_run = datetime.now(timezone.utc).isoformat()
            self.last_error = None
            return self.last_marked
        except Exception as e:
            self.last_error = str(e)
            logger.exception("Mark-to-market failed")
            return 0
        finally:
            db.close()

    async def _loop(self) -> None:
        while self._running:
            await self.run_once()
            await asyncio.sleep(self.interval_seconds)


mtm_job = MarkToMarketJob(interval_seconds=60)

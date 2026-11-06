"""Periodic order reconciliation job (Omar Diallo / Claire Bennett)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import get_settings
from app.database import SessionLocal
from app.trading.reconciliation import OrderReconciler

logger = logging.getLogger(__name__)


class ReconcileJob:
    def __init__(self, interval_seconds: int = 120):
        self.interval_seconds = interval_seconds
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.last_run: Optional[str] = None
        self.last_result: Optional[dict[str, Any]] = None
        self.last_error: Optional[str] = None

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("ReconcileJob started (interval=%ss)", self.interval_seconds)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "interval_seconds": self.interval_seconds,
            "last_run": self.last_run,
            "last_result": self.last_result,
            "last_error": self.last_error,
            "analyst": "Omar Diallo",
            "auditor": "Claire Bennett",
        }

    async def run_once(self) -> dict[str, Any]:
        db = SessionLocal()
        try:
            settings = get_settings()
            result = await OrderReconciler(db, settings).reconcile_open(limit=50)
            self.last_result = result
            self.last_run = datetime.now(timezone.utc).isoformat()
            self.last_error = None
            return result
        except Exception as e:
            self.last_error = str(e)
            logger.exception("Reconcile job failed")
            return {"error": str(e)}
        finally:
            db.close()

    async def _loop(self) -> None:
        while self._running:
            await self.run_once()
            await asyncio.sleep(self.interval_seconds)


reconcile_job = ReconcileJob(interval_seconds=120)

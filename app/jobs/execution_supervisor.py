"""Periodic supervisor: venue health pings, open-order/partial-fill management, reconciliation, emergency retries."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


class ExecutionSupervisorJob:
    def __init__(self, interval_seconds: int = 15):
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

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def status(self) -> dict[str, Any]:
        return {"running": self._running, "interval_seconds": self.interval_seconds, "last_run": self.last_run,
                "last_error": self.last_error}

    async def _loop(self) -> None:
        from app.execution.service import get_engine   # lazy: keeps import-time light
        while self._running:
            try:
                self.last_result = await get_engine().supervise_once()
                self.last_error = None
            except Exception as e:      # the loop must survive anything
                self.last_error = f"{type(e).__name__}: {e}"[:300]
                logger.exception("execution supervisor tick failed")
            self.last_run = datetime.now(timezone.utc).isoformat()
            await asyncio.sleep(self.interval_seconds)


execution_supervisor_job = ExecutionSupervisorJob()

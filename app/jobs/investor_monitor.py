"""Background investor disclosure scan (Quiver). Does not place orders."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import get_settings
from app.intelligence.investor_activity import InvestorActivityEngine


class InvestorMonitorJob:
    def __init__(self) -> None:
        self.interval_seconds = 1800
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.last_run: Optional[str] = None
        self.last_result: dict[str, Any] = {}
        self.last_error: Optional[str] = None

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "interval_seconds": self.interval_seconds,
            "last_run": self.last_run,
            "last_error": self.last_error,
            "last_congress_count": (self.last_result.get("congress") or {}).get("count"),
            "officer": "Claire Bennett",
            "auto_trade": False,
        }

    async def run_once(self) -> dict[str, Any]:
        settings = get_settings()
        engine = InvestorActivityEngine(settings)
        try:
            result = await engine.full_scan()
            self.last_result = result
            self.last_run = datetime.now(timezone.utc).isoformat()
            self.last_error = None
            return result
        except Exception as e:
            self.last_error = str(e)
            return {"status": "error", "error": str(e)}

    async def _loop(self) -> None:
        while self._running:
            await self.run_once()
            await asyncio.sleep(self.interval_seconds)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        settings = get_settings()
        self.interval_seconds = getattr(settings, "investor_monitor_interval_seconds", 1800) or 1800
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass
            self._task = None


investor_monitor_job = InvestorMonitorJob()

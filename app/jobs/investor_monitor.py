"""Continuous investor disclosure monitor (Quiver-backed when configured)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import get_settings
from app.integrations.quiver.client import QuiverClient

logger = logging.getLogger(__name__)


class InvestorMonitorJob:
    def __init__(self, interval_seconds: int = 1800):
        self.interval_seconds = interval_seconds
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.last_run: Optional[str] = None
        self.last_status: Optional[dict[str, Any]] = None
        self.last_error: Optional[str] = None
        self.alerts: list[dict[str, Any]] = []

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
        return {
            "running": self._running,
            "interval_seconds": self.interval_seconds,
            "last_run": self.last_run,
            "last_status": self.last_status,
            "last_error": self.last_error,
            "alert_count": len(self.alerts),
            "note": "Monitoring interval ≠ source publication frequency",
            "desk": {"strategist": "Adrian Cole", "auditor": "Claire Bennett", "risk": "Helena Frost"},
        }

    async def run_once(self) -> dict[str, Any]:
        client = QuiverClient(get_settings())
        health = await client.health()
        congress = await client.congress_trading_live() if client.configured else {"status": "not_configured"}
        result = {
            "health": health,
            "congress_feed": {
                "status": congress.get("status"),
                "http_status": congress.get("http_status"),
                "retrieved_at": congress.get("retrieved_at"),
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        # Store lightweight alert only on successful new retrieval
        if congress.get("status") == "ok":
            self.alerts.append(
                {
                    "type": "congress_feed_refresh",
                    "verification": "VERIFIED PRIMARY SOURCE" if health.get("status") == "ok" else "UNCONFIRMED",
                    "retrieved_at": congress.get("retrieved_at"),
                    "significance": "INFORMATIONAL",
                    "note": "Feed refresh — individual trades require per-record verification",
                }
            )
            self.alerts = self.alerts[-100:]
        self.last_status = result
        self.last_run = result["timestamp"]
        self.last_error = None if health.get("status") in ("ok", "not_configured", "plan_restricted") else str(health)
        return result

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.run_once()
            except Exception as e:
                self.last_error = str(e)
                logger.exception("Investor monitor failed")
            await asyncio.sleep(self.interval_seconds)


investor_monitor = InvestorMonitorJob(interval_seconds=1800)

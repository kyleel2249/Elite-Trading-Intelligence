"""Background investor disclosure scan — persist activities + alerts. No orders."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import get_settings
from app.database import SessionLocal
from app.intelligence.investor_activity import InvestorActivityEngine
from app.intelligence.significance import consensus_report
from app.services.activity_store import ActivityStore
from app.integrations.edgar.client import EdgarClient, WATCH_CIKS


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
            "last_ingest": self.last_result.get("ingest"),
            "officer": "Claire Bennett",
            "auto_trade": False,
        }

    async def run_once(self) -> dict[str, Any]:
        settings = get_settings()
        engine = InvestorActivityEngine(settings)
        db = SessionLocal()
        try:
            full = await engine.full_scan()
            activities: list[dict[str, Any]] = []
            for key in ("congress", "government_contracts", "lobbying"):
                block = full.get(key) or {}
                activities.extend(block.get("activities") or [])

            # EDGAR 13F index snapshots for watch CIKs (historical only)
            edgar = EdgarClient()
            edgar_acts = []
            for cik in list(WATCH_CIKS.keys())[:3]:
                try:
                    sub = await edgar.company_submissions(cik)
                    edgar_acts.extend(edgar.activities_from_13f_index(sub))
                except Exception:
                    continue
            activities.extend(edgar_acts)

            store = ActivityStore(db)
            ingest = store.ingest_many(activities)
            consensus = consensus_report(activities)

            result = {
                "status": "ok",
                "scanned_at": datetime.now(timezone.utc).isoformat(),
                "raw_activity_count": len(activities),
                "ingest": ingest,
                "consensus": consensus,
                "edgar_13f_index_count": len(edgar_acts),
                "auto_trade": False,
                "watchlist": full.get("watchlist"),
            }
            self.last_result = result
            self.last_run = result["scanned_at"]
            self.last_error = None
            return result
        except Exception as e:
            self.last_error = str(e)
            return {"status": "error", "error": str(e)}
        finally:
            db.close()

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

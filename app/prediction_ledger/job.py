"""Background evaluator: scores matured predictions and publishes last month's report."""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import get_settings
from app.database import SessionLocal
from app.market.service import MarketService
from app.prediction_ledger.reports import get_report, previous_period, publish_report
from app.prediction_ledger.service import pending_matured, resolve_prediction

logger = logging.getLogger(__name__)


class PredictionResolverJob:
    def __init__(self, interval_seconds: int = 300):
        self.interval_seconds = interval_seconds
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.last_run: Optional[str] = None
        self.last_result: Optional[dict[str, Any]] = None
        self.last_error: Optional[str] = None

    async def start(self) -> None:
        if self._running:
            return
        self.interval_seconds = int(os.getenv("PREDICTION_RESOLVE_INTERVAL_SECONDS", self.interval_seconds))
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
                "last_result": self.last_result, "last_error": self.last_error}

    async def run_once(self) -> dict[str, Any]:
        db = SessionLocal()
        res: dict[str, Any] = {"resolved": 0, "skipped_no_price": 0, "errors": 0, "report_published": None}
        try:
            mkt = MarketService(get_settings())
            prices: dict[tuple[str, str], Optional[float]] = {}
            for p in pending_matured(db):
                provider = (p.provider or "").lower()
                if provider not in ("binance", "alpaca"):
                    res["skipped_no_price"] += 1  # no feed; settle via POST /api/predictions/{uid}/outcome
                    continue
                key = (provider, p.asset)
                if key not in prices:
                    try:
                        snap = await mkt.get_snapshot(provider, p.asset)
                        ok = snap.get("price") and snap.get("data_status") not in ("invalid", "unavailable")
                        prices[key] = float(snap["price"]) if ok else None
                    except Exception:
                        logger.warning("price fetch failed for %s", key, exc_info=True)
                        prices[key] = None
                if prices[key] is None:
                    res["errors"] += 1
                    continue
                try:
                    resolve_prediction(db, p, prices[key], price_source=f"{provider}:snapshot")
                    res["resolved"] += 1
                except Exception:
                    db.rollback()
                    res["errors"] += 1
                    logger.warning("resolve failed for %s", p.prediction_uid, exc_info=True)
            period = previous_period()
            if get_report(db, period) is None:
                _, created = publish_report(db, period)
                res["report_published"] = period if created else None
            self.last_error = None
        except Exception as e:  # keep the loop alive
            self.last_error = type(e).__name__
            logger.exception("prediction resolver failed")
            res["error"] = type(e).__name__
        finally:
            db.close()
        self.last_run = datetime.now(timezone.utc).isoformat()
        self.last_result = res
        return res

    async def _loop(self) -> None:
        while self._running:
            await self.run_once()
            await asyncio.sleep(self.interval_seconds)


prediction_resolver_job = PredictionResolverJob()

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
from app.prediction_ledger.service import kline_resolution, pending_matured, resolve_prediction

logger = logging.getLogger(__name__)

# Candle sizes tried (finest first). A size is used only if it is <= 10% of the prediction's horizon.
KLINE_INTERVALS = (("1m", 60_000), ("5m", 300_000), ("1h", 3_600_000))


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

    async def _klines(self, mkt: MarketService, cache: dict, provider: str, asset: str, interval: str):
        key = (provider, asset, interval)
        if key not in cache:
            try:
                cache[key] = await mkt.get_history(provider, asset, interval=interval, limit=1000)
            except Exception:
                logger.warning("kline fetch failed for %s", key, exc_info=True)
                cache[key] = None
        return cache[key]

    async def run_once(self) -> dict[str, Any]:
        db = SessionLocal()
        res: dict[str, Any] = {"resolved": 0, "resolved_from_candles": 0, "skipped_no_price": 0, "errors": 0,
                               "report_published": None}
        try:
            mkt = MarketService(get_settings())
            prices: dict[tuple[str, str], Optional[float]] = {}
            kcache: dict = {}
            for p in pending_matured(db):
                provider = (p.provider or "").lower()
                if provider not in ("binance", "alpaca"):
                    res["skipped_no_price"] += 1  # no feed; settle via POST /api/predictions/{uid}/outcome
                    continue
                try:
                    # 1) Preferred: the candle close at expiry + the high/low path (exact, never late).
                    if provider == "binance":
                        resolved = False
                        for iv, bar_ms in KLINE_INTERVALS:
                            if bar_ms > 0.1 * p.horizon_seconds * 1000:
                                continue
                            ks = await self._klines(mkt, kcache, provider, p.asset, iv)
                            r = kline_resolution(ks, p.created_at, p.expires_at, bar_ms) if ks else None
                            if r:
                                resolve_prediction(
                                    db, p, r["price"], price_source=f"binance:kline-{iv}-close-at-expiry",
                                    observed_at=r["observed_at"], path_low=r["low"], path_high=r["high"], historical=True,
                                    notes=f"path of {r['bars']} {iv} candles")
                                res["resolved"] += 1
                                res["resolved_from_candles"] += 1
                                resolved = True
                                break
                        if resolved:
                            continue
                    # 2) Fallback: live snapshot (flagged 'late' if evaluated too long after expiry).
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

"""Process-wide scanner/execution singletons and the background scan job."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from app.config import Settings, get_settings
from app.quant.controls import controls
from app.quant.execution import ExecutionEngine
from app.quant.scanner import GlobalScanner

logger = logging.getLogger("eti.quant")

_scanner: Optional[GlobalScanner] = None
_engine: Optional[ExecutionEngine] = None


def get_scanner(settings: Optional[Settings] = None) -> GlobalScanner:
    global _scanner
    if _scanner is None:
        from app.quant.providers import AlpacaSnapshotProvider, BinanceBulkProvider
        s = settings or get_settings()
        _scanner = GlobalScanner(
            {"binance": BinanceBulkProvider(), "alpaca": AlpacaSnapshotProvider(s)},
            max_age_seconds=s.data_max_age_seconds, interval_seconds=s.scan_interval_seconds)
    return _scanner


def reset_scanner_for_tests() -> None:
    global _scanner, _engine
    _scanner, _engine = None, None


async def load_universe(settings: Optional[Settings] = None) -> int:
    from app.quant.providers import build_equity_universe
    s = settings or get_settings()
    sc = get_scanner(s)
    entries = []
    try:
        entries += await sc.providers["binance"].load_universe(limit=s.scan_binance_top_n)
    except Exception:
        logger.warning("binance universe load failed", exc_info=True)
    if s.scan_equity_symbols:
        entries += build_equity_universe(s.scan_equity_symbols.split(","))
    sc.set_universe(entries)
    return len(entries)


def get_engine(settings: Optional[Settings] = None) -> ExecutionEngine:
    global _engine
    if _engine is None:
        from app.database import SessionLocal
        from app.trading.service import TradingService
        s = settings or get_settings()

        async def submitter(**kw):
            db = SessionLocal()
            try:
                return await TradingService(s, db=db).place_order(**kw)
            finally:
                db.close()

        _engine = ExecutionEngine(s, submitter, controls=controls)
    return _engine


class GlobalScanJob:
    """Matches the start/stop/status/run_once shape of the other jobs."""

    def __init__(self):
        self.interval_seconds = 600
        self._task: Optional[asyncio.Task] = None
        self.last_error: Optional[str] = None
        self.last_convergence: Optional[dict] = None

    async def run_once(self) -> dict:
        from app.database import SessionLocal
        from app.quant.convergence import track_open_alerts
        from app.quant.service import QuantStore
        sc = get_scanner()
        if not sc.universe:
            await load_universe()
        m = await sc.scan_once()
        controls.check_data_health(sc.fresh_ratio())
        db = SessionLocal()
        try:
            QuantStore(db).save_scan(m, sc.coverage)
            self.last_convergence = track_open_alerts(db, sc)
        finally:
            db.close()
        return {**m.to_dict(), "convergence": self.last_convergence}

    async def _loop(self):
        while True:
            try:
                await self.run_once()
                self.last_error = None
            except Exception as e:  # noqa: BLE001
                self.last_error = type(e).__name__
                logger.warning("global scan failed", exc_info=True)
            await asyncio.sleep(max(1, self.interval_seconds))

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            self._task = None

    def status(self) -> dict:
        return {"running": self._task is not None, "interval_seconds": self.interval_seconds,
                "last_error": self.last_error, "last_convergence": self.last_convergence,
                **get_scanner().status()}


scan_job = GlobalScanJob()

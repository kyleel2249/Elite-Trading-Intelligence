"""Background adaptive-edge monitoring cycle."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from app.config import get_settings
from app.database import SessionLocal

logger = logging.getLogger("eti.adaptive_edge_job")


class AdaptiveEdgeJob:
    def __init__(self) -> None:
        self.interval_seconds = 900
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop())
        logger.info("adaptive_edge_job started interval=%s", self.interval_seconds)

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except Exception:
                self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._run_once()
            except Exception:
                logger.warning("adaptive_edge_job cycle failed", exc_info=True)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval_seconds)
            except asyncio.TimeoutError:
                pass

    async def _run_once(self) -> None:
        from app.adaptive_edge.orchestrator import AdaptiveEdgeOrchestrator
        from app.market.service import MarketService
        from app.knowledge.strategies import STRATEGY_MODULES

        settings = get_settings()
        symbols = ["BTCUSDT", "ETHUSDT"]
        db = SessionLocal()
        try:
            ms = MarketService(settings)
            orch = AdaptiveEdgeOrchestrator(db)
            for sym in symbols:
                closes: list[float] = []
                volumes: list[float] = []
                try:
                    hist = await ms.get_history("binance", sym, interval="1h", limit=120)
                    for bar in hist or []:
                        if bar.get("close") is not None:
                            closes.append(float(bar["close"]))
                        if bar.get("volume") is not None:
                            volumes.append(float(bar["volume"]))
                except Exception:
                    logger.info("adaptive_edge_job: no history for %s; skip", sym)
                    continue
                if len(closes) < 20:
                    continue
                strategy_trades = {mid: [] for mid in list(STRATEGY_MODULES.keys())[:4]}
                result = orch.run_cycle(
                    symbol=sym,
                    provider="binance",
                    closes=closes,
                    volumes=volumes or None,
                    strategy_trades=strategy_trades,
                )
                logger.info(
                    "adaptive_edge cycle %s regime=%s defensive=%s notes=%s",
                    result.cycle_id,
                    result.regime.get("primary_regime"),
                    result.defensive,
                    result.notes[:3],
                )
        finally:
            db.close()


adaptive_edge_job = AdaptiveEdgeJob()

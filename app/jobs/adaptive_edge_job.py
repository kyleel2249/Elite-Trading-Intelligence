"""Background adaptive-edge monitoring cycle.

Each cycle now:
* feeds every strategy's REAL closed-trade history (from ETI memory) into the edge-health monitor
  instead of empty samples,
* scores due signals (prediction accuracy) using a fresh quote, and expires the ones whose scoring
  window was missed rather than silently dropping them.
"""
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
        self.last_run: Optional[str] = None
        self.last_error: Optional[str] = None

    def status(self) -> dict:
        running = bool(self._task and not self._task.done())
        return {
            "running": running, "interval_seconds": self.interval_seconds,
            "last_run": self.last_run, "last_error": self.last_error,
        }

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

    async def run_once(self) -> None:
        await self._run_once()

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._run_once()
                self.last_error = None
            except Exception as exc:
                self.last_error = type(exc).__name__
                logger.warning("adaptive_edge_job cycle failed", exc_info=True)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval_seconds)
            except asyncio.TimeoutError:
                pass

    async def _score_due_signals(self, db, ms) -> None:
        from app.memory.signals import SignalMemoryService

        svc = SignalMemoryService(db)
        prices: dict[tuple[str, str], float] = {}
        for provider, symbol in svc.due_keys():
            try:
                snap = await ms.get_snapshot(provider, symbol)
                if snap.get("price") is not None:
                    prices[(provider, symbol)] = float(snap["price"])
            except Exception:
                logger.info("signal scoring: no quote for %s %s", provider, symbol)
        summary = svc.resolve_due(prices)
        if any(summary.values()):
            logger.info("signal scoring: %s", summary)

    async def _run_once(self) -> None:
        from datetime import datetime, timezone

        from app.adaptive_edge.orchestrator import AdaptiveEdgeOrchestrator
        from app.market.service import MarketService
        from app.knowledge.strategies import STRATEGY_MODULES
        from app.memory.learning import TradeLearningService

        settings = get_settings()
        symbols = ["BTCUSDT", "ETHUSDT"]
        db = SessionLocal()
        try:
            ms = MarketService(settings)
            try:
                await self._score_due_signals(db, ms)
            except Exception:
                db.rollback()
                logger.warning("signal scoring failed", exc_info=True)

            real_samples = TradeLearningService(db).strategy_samples()
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
                # Real closed-trade samples for every strategy that has traded; documented modules
                # without trades yet stay UNDER_VALIDATION (empty sample).
                strategy_trades = {mid: [] for mid in list(STRATEGY_MODULES.keys())[:4]}
                strategy_trades.update(real_samples)
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
            self.last_run = datetime.now(timezone.utc).isoformat()
        finally:
            db.close()


adaptive_edge_job = AdaptiveEdgeJob()

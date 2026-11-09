"""Continuous research loop: discover, validate, resolve predictions, monitor plans, compete strategies.
Never submits orders; exits for already-open ETI plans are the only order path (reduce-only, paper/testnet)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.alpha.db_models import AlphaCandidate, AlphaResearchRun
from app.alpha.context import gather_context
from app.alpha.discovery import DiscoveryEngine
from app.alpha.execution import AlphaExecutor
from app.alpha.fusion import validate
from app.alpha.providers import AlpacaMarketData, BinanceUniverse
from app.alpha.strategy_lab import run_competition
from app.config import get_settings
from app.database import SessionLocal

logger = logging.getLogger("eti.alpha")


def make_bars_fn(binance: BinanceUniverse, alpaca: Optional[AlpacaMarketData]):
    async def fn(cand: AlphaCandidate):
        if cand.asset_class == "crypto":
            return await binance.klines(cand.symbol, "1d", 200)
        if cand.asset_class in ("equity", "etf") and alpaca is not None and alpaca.configured:
            return await alpaca.daily_bars(cand.symbol, 250)
        return []
    return fn


class AlphaResearchJob:
    def __init__(self) -> None:
        self.interval_seconds = 3600
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.last_run: Optional[str] = None
        self.last_error: Optional[str] = None
        self.last_result: dict[str, Any] = {}
        self._last_competition: Optional[datetime] = None
        self._lock = asyncio.Lock()

    def status(self) -> dict[str, Any]:
        return {"running": self._running, "interval_seconds": self.interval_seconds, "last_run": self.last_run,
                "last_error": self.last_error, "last_result": self.last_result, "auto_trade": False}

    async def run_once(self, force_competition: bool = False) -> dict[str, Any]:
        async with self._lock:
            settings = get_settings()
            db = SessionLocal()
            run = AlphaResearchRun(kind="cycle", status="running")
            db.add(run)
            db.commit()
            summary: dict[str, Any] = {}
            try:
                binance = BinanceUniverse(db=db)
                alpaca = AlpacaMarketData(settings.alpaca_api_key, settings.alpaca_secret_key, db=db)
                eng = DiscoveryEngine(db, binance=binance, alpaca=alpaca)
                for name, coro in (("crypto", eng.scan_crypto(settings.alpha_crypto_scan_limit)),
                                   ("equities", eng.scan_equities([s.strip() for s in settings.alpha_equity_universe.split(",") if s.strip()])),
                                   ("dex", eng.scan_dex())):
                    try:
                        summary[name] = await coro
                    except Exception as exc:  # noqa: BLE001
                        summary[name] = {"status": "error", "error": type(exc).__name__}
                bars_fn = make_bars_fn(binance, alpaca)
                top = (db.query(AlphaCandidate).filter(AlphaCandidate.status.in_(("EARLY_ACCUMULATION", "DEVELOPING_OPPORTUNITY")),
                                                       AlphaCandidate.asset_class.in_(("crypto", "equity", "etf")))
                       .order_by(AlphaCandidate.overall_rank_score.desc().nullslast()).limit(5).all())
                validated = []
                for c in top:
                    try:
                        bars = await bars_fn(c)
                        res = validate(db, c, bars, settings=settings, **await gather_context(db, settings, c, bars))
                        validated.append({"candidate": c.candidate_id, "decision": res["decision"]})
                    except Exception:  # noqa: BLE001
                        logger.warning("validation failed %s", c.candidate_id, exc_info=True)
                summary["validated"] = validated
                summary["plan_monitor"] = await AlphaExecutor(db, settings).monitor()
                now = datetime.now(timezone.utc)
                if force_competition or self._last_competition is None or now - self._last_competition > timedelta(hours=24):
                    cands = (db.query(AlphaCandidate).filter(AlphaCandidate.asset_class == "crypto", AlphaCandidate.data_status == "fresh")
                             .order_by(AlphaCandidate.volume_24h.desc().nullslast()).limit(12).all())
                    ds = {}
                    for c in cands:
                        try:
                            bars = await binance.klines(c.symbol, "1d", 1000)
                            if len(bars) >= 400:
                                ds[("crypto", c.symbol)] = bars
                        except Exception:  # noqa: BLE001
                            continue
                    if ds:
                        comp = run_competition(db, ds)
                        summary["competition"] = {"evaluated": comp["evaluated"], "top": comp["leaderboard"][:3]}
                        self._last_competition = now
                run.status = "ok"
                self.last_error = None
            except Exception as exc:  # noqa: BLE001
                run.status = "error"
                summary["error"] = type(exc).__name__
                self.last_error = type(exc).__name__
                logger.warning("alpha research cycle failed", exc_info=True)
            finally:
                run.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
                run.summary = _jsonable(summary)
                db.commit()
                db.close()
            self.last_run = datetime.now(timezone.utc).isoformat()
            self.last_result = _jsonable(summary)
            return self.last_result

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.run_once()
            except Exception:  # noqa: BLE001
                logger.warning("research loop error", exc_info=True)
            await asyncio.sleep(self.interval_seconds)

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
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


def _jsonable(o: Any) -> Any:
    import json
    return json.loads(json.dumps(o, default=str))


alpha_research_job = AlphaResearchJob()

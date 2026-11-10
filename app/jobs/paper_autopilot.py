"""Background jobs for the internal paper engine.

Tick loop  (always on): advances resting limit/stop-loss/take-profit orders using fresh public prices.
Scan loop  (PAPER_AUTOPILOT_ENABLED=true): runs the Trading Council on configured symbols and places simulated
           paper trades with a stop-loss/take-profit bracket. Simulation only: no exchange order is ever sent.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

ACCOUNT = "default"
STOP_PCT, TAKE_PCT, MAX_NOTIONAL_PCT = 2.0, 4.0, 20.0


def normalize_confidence(c) -> float:
    try:
        c = float(c)
    except (TypeError, ValueError):
        return 0.0
    return c / 100.0 if c > 1.0 else c


def classify_action(action: str) -> Optional[str]:
    a = (action or "").lower()
    if "sell" in a or "short" in a or "reduce" in a:
        return "sell"
    if "buy" in a or "long" in a:
        return "buy"
    return None


def size_buy(equity: float, price: float, risk_pct: float) -> float:
    """Risk `risk_pct` of equity against a STOP_PCT stop, capped at MAX_NOTIONAL_PCT of equity. Floors to 6 dp."""
    if not (equity > 0 and price > 0):
        return 0.0
    notional = min(equity * (risk_pct / 100.0) / (STOP_PCT / 100.0), equity * MAX_NOTIONAL_PCT / 100.0)
    return math.floor(notional / price * 1e6) / 1e6


class PaperJob:
    def __init__(self):
        self.tick_interval = 5
        self.scan_interval = 120
        self.enabled_scan = False
        self.symbols: list = []
        self.min_confidence = 0.6
        self._tasks: list = []
        self._running = False
        self.last_tick: Optional[str] = None
        self.last_scan: Optional[str] = None
        self.last_error: Optional[str] = None
        self.last_scan_result: list = []

    def configure(self, settings) -> None:
        self.tick_interval = max(1, int(settings.paper_tick_interval_seconds))
        self.scan_interval = max(10, int(settings.paper_autopilot_interval_seconds))
        self.enabled_scan = bool(settings.paper_autopilot_enabled)
        self.symbols = [s.strip().upper() for s in settings.paper_autopilot_symbols.split(",") if s.strip()]
        self.min_confidence = float(settings.paper_autopilot_min_confidence)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._tasks = [asyncio.create_task(self._tick_loop())]
        if self.enabled_scan:
            self._tasks.append(asyncio.create_task(self._scan_loop()))

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        self._tasks = []

    def status(self) -> dict[str, Any]:
        return {"running": self._running, "tick_interval_seconds": self.tick_interval,
                "autopilot_enabled": self.enabled_scan, "symbols": self.symbols, "last_tick": self.last_tick,
                "last_scan": self.last_scan, "last_error": self.last_error, "mode": "internal_paper"}

    async def _tick_loop(self) -> None:
        from app.paper.wiring import get_paper_service
        while self._running:
            try:
                svc = get_paper_service()
                for acct in svc.store.list_accounts():
                    if any(o["status"] in ("new", "partially_filled") for o in svc.orders(acct, "open", 500)):
                        await svc.tick(acct)
                self.last_error = None
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"[:300]
                logger.warning("paper tick failed: %s", type(e).__name__, exc_info=True)
            self.last_tick = datetime.now(timezone.utc).isoformat()
            await asyncio.sleep(self.tick_interval)

    async def _scan_loop(self) -> None:
        while self._running:
            try:
                self.last_scan_result = await self.scan_once()
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"[:300]
                logger.warning("paper scan failed: %s", type(e).__name__, exc_info=True)
            self.last_scan = datetime.now(timezone.utc).isoformat()
            await asyncio.sleep(self.scan_interval)

    async def scan_once(self) -> list:
        from app.config import get_settings
        from app.intelligence.council import TradingCouncil
        from app.market.service import MarketService
        from app.paper.core import OrderRequest, PaperError
        from app.paper.wiring import get_paper_service
        settings, svc, mkt = get_settings(), get_paper_service(), MarketService(get_settings())
        out = []
        for sym in self.symbols:
            row = {"symbol": sym, "action": None, "outcome": "skipped"}
            try:
                snap = await mkt.get_snapshot("binance", sym)
                book = await mkt.get_order_book(sym, depth=20)
                klines = await mkt.get_history("binance", sym, interval="1h", limit=48)
                d = TradingCouncil().analyse(symbol=sym, provider="binance", price=snap.get("price"),
                                             bid=snap.get("bid"), ask=snap.get("ask"),
                                             data_status=snap.get("data_status", "unknown"), order_book=book,
                                             klines=klines, context={})
                action, conf = classify_action(str(d.action.value)), normalize_confidence(d.confidence)
                row.update(action=str(d.action.value), confidence=conf, risk_veto=bool(d.risk_veto))
                svc.record_event(ACCOUNT, "autopilot_decision", symbol=sym, action=row["action"], confidence=conf,
                                 risk_veto=row["risk_veto"])
                if d.risk_veto or action is None or conf < self.min_confidence:
                    row["outcome"] = "no_trade"
                    out.append(row)
                    continue
                summary = await svc.summary(ACCOUNT)
                held = next((p for p in summary["positions"] if p["symbol"] == sym), None)
                bucket = int(time.time() // self.scan_interval)
                if action == "buy":
                    if held or any(o["symbol"] == sym for o in svc.orders(ACCOUNT, "open", 500)):
                        row["outcome"] = "already_positioned"
                    else:
                        px = (await svc.quote(sym))["best_ask"]
                        qty = size_buy(summary["equity"], px, settings.default_risk_per_trade_pct)
                        o = await svc.submit(ACCOUNT, OrderRequest(sym, "buy", "market", qty,
                                                                   client_order_id=f"auto-{sym}-{bucket}"))
                        row.update(outcome=o.status, order_id=o.id, qty=o.filled_qty)
                        if o.filled_qty > 0 and o.avg_fill_price:
                            try:
                                await svc.submit_bracket(ACCOUNT, sym, o.filled_qty,
                                                         o.avg_fill_price * (1 - STOP_PCT / 100),
                                                         o.avg_fill_price * (1 + TAKE_PCT / 100),
                                                         client_order_id=f"auto-{sym}-{bucket}")
                            except PaperError as e:
                                row["bracket_error"] = str(e)
                else:
                    if held and held["available_qty"] > 0:
                        o = await svc.submit(ACCOUNT, OrderRequest(sym, "sell", "market", held["available_qty"],
                                                                   client_order_id=f"auto-{sym}-{bucket}"))
                        row.update(outcome=o.status, order_id=o.id, qty=o.filled_qty)
                    else:
                        row["outcome"] = "nothing_to_sell"
            except PaperError as e:
                row.update(outcome="rejected", reason=str(e))
            except Exception as e:
                row.update(outcome="error", reason=type(e).__name__)
                logger.warning("paper autopilot %s failed", sym, exc_info=True)
            out.append(row)
        return out


paper_job = PaperJob()

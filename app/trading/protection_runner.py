"""Executes the Capital Protection System's sweep: emergency liquidation and stop-loss enforcement.

Run after every mark-to-market cycle (and on demand through the admin API). Exits are submitted through
TradingService like any other order, so they are still logged, journaled and reconciled; the protection
system only recognises them as exits (never blocked) when server-side positions confirm they reduce risk.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.risk.protection_service import CapitalProtectionService
from app.trading.service import TradingService

logger = logging.getLogger("eti.capital_protection.runner")

ENVIRONMENTS = ("paper", "testnet", "live")


async def run_protection_sweep(
    db: Session, settings: Optional[Settings] = None, environments: Iterable[str] = ENVIRONMENTS,
) -> list[dict[str, Any]]:
    settings = settings or get_settings()
    protection = CapitalProtectionService(db, settings)
    results: list[dict[str, Any]] = []
    for env in environments:
        try:
            report = protection.sweep(env)
        except Exception:
            logger.error("protection sweep failed for %s", env, exc_info=True)
            results.append({"environment": env, "error": "sweep_failed"})
            continue
        executed: list[dict[str, Any]] = []
        if report.liquidations:
            trading = TradingService(settings, db=db)
            for intent in report.liquidations:
                try:
                    out = await trading.place_order(
                        provider=intent.provider, environment=env, symbol=intent.symbol, side=intent.side,
                        qty=intent.qty, order_type="market", equity=0.0, fill_price_hint=intent.price,
                        reference_price=intent.price, strategy_id=intent.strategy_id, system_exit=True,
                        thesis=f"Capital protection exit ({intent.source})",
                    )
                    executed.append({"symbol": intent.symbol, "side": intent.side, "qty": intent.qty, "status": out.get("status"),
                                     "reasons": (out.get("risk") or {}).get("reasons", []) if out.get("status") != "submitted" else []})
                except Exception:
                    logger.error("protection exit failed for %s %s", env, intent.symbol, exc_info=True)
                    executed.append({"symbol": intent.symbol, "status": "error"})
        results.append({**report.to_dict(), "executed": executed})
    return results

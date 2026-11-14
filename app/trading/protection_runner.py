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
        if env == "paper":
            results.append(await _sweep_internal_paper(protection, settings))
    return results


async def _sweep_internal_paper(protection: CapitalProtectionService, settings: Settings) -> dict[str, Any]:
    """Emergency rules for the internal paper engine's own account (the simulator keeps its state outside the portfolio tables).

    A breach of the emergency drawdown halts paper trading and, when auto-liquidation is on, cancels working orders and
    sells every holding. Stop-loss enforcement there is done by the resting protective `stop` orders the gate places.
    """
    out: dict[str, Any] = {"environment": "paper_internal", "emergency": False, "halted": False, "executed": []}
    try:
        from app.paper.runtime import get_exchange
        from app.risk.protection import OpenPosition, assess_emergency

        ex = get_exchange()
        acct = await ex.account(tick=False)
        positions = tuple(
            OpenPosition(provider="binance", symbol=p["symbol"], side="long", qty=float(p["qty"]),
                         price=float(p["mark_price"] or p["avg_cost"] or 0.0), avg_entry=float(p["avg_cost"] or 0.0))
            for p in acct.get("positions", []) if p.get("open")
        )
        snap = protection.external_snapshot("paper_internal", equity=float(acct["equity"]), start_equity=float(acct["starting_cash"]),
                                            positions=positions, halt_environment="paper")
        out["halted"] = snap.halted
        verdict = assess_emergency(snap, protection.policy)
        if not verdict.triggered:
            return out
        out.update(emergency=True, emergency_reasons=verdict.reasons)
        protection.halt("paper", "; ".join(verdict.reasons))
        out["halted"] = True
        if protection.policy.auto_liquidate_on_emergency:
            protection.audit("EMERGENCY_LIQUIDATION", {"environment": "paper_internal", "reasons": verdict.reasons,
                                                         "positions": [p.symbol for p in positions]})
            await ex.cancel_all()
            for p in positions:
                res = await ex.submit(symbol=p.symbol, side="sell", qty=p.qty, order_type="market",
                                      client_order_id=f"cps-flat-{p.symbol[:12]}-{int(__import__('time').time())}",
                                      thesis="capital protection: emergency liquidation")
                out["executed"].append({"symbol": p.symbol, "side": "sell", "qty": p.qty,
                                        "status": "submitted" if res.get("accepted") else "rejected", "reasons": res.get("reasons", [])})
    except Exception:
        logger.error("internal paper protection sweep failed", exc_info=True)
        out["error"] = "sweep_failed"
    return out

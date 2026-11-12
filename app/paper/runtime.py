"""Process-wide wiring for the internal paper exchange (uses the application database and public market data only)."""
from __future__ import annotations

import os
from typing import Any, Optional

from app.config import get_settings
from app.database import SessionLocal
from app.paper.service import LiveQuoteProvider, PaperExchange, PaperTickJob, config_from_env
from app.paper.sql_store import SqlPaperStore

_exchange: Optional[PaperExchange] = None
_job: Optional[PaperTickJob] = None


def get_exchange() -> PaperExchange:
    global _exchange
    if _exchange is None:
        settings = get_settings()
        _exchange = PaperExchange(SqlPaperStore(SessionLocal), LiveQuoteProvider(settings), config_from_env(),
                                  kill_switch=lambda: bool(get_settings().kill_switch), account_id=os.environ.get("PAPER_ACCOUNT_ID", "default"))
    return _exchange


def get_tick_job() -> PaperTickJob:
    global _job
    if _job is None:
        try:
            interval = float(os.environ.get("PAPER_TICK_SECONDS", "5"))
        except ValueError:
            interval = 5.0
        _job = PaperTickJob(get_exchange, interval)
    return _job


def shape_result(res: dict, label: str) -> dict:
    """Uniform order response: explicit execution mode on every reply."""
    order = res.get("order") or {}
    status = order.get("status", "rejected" if not res.get("accepted") else "submitted")
    return {"status": status, "accepted": bool(res.get("accepted")), "duplicate": bool(res.get("duplicate")), "reasons": res.get("reasons", []),
            "execution_mode": "INTERNAL_PAPER", "mode_label": label, "order": order, "fills": res.get("fills", [])}


async def place_via_trading_service(*, symbol: str, side: str, qty: float, order_type: str, limit_price: Optional[float], thesis: Optional[str],
                                    client_order_id: str, mode_info: dict) -> dict[str, Any]:
    """Entry used by TradingService for paper (and credential-less testnet) orders."""
    from app.paper.mode import LABELS, INTERNAL_PAPER
    ex = get_exchange()
    res = await ex.submit(symbol=symbol, side=side, qty=qty, order_type=order_type, limit_price=limit_price, thesis=thesis, client_order_id=client_order_id)
    out = shape_result(res, LABELS[INTERNAL_PAPER])
    acct = await ex.account(tick=False)
    out.update({
        "client_order_id": client_order_id, "mode_resolution": mode_info, "account": {k: acct[k] for k in ("cash", "available_cash", "equity", "realized_pnl", "unrealized_pnl", "total_pnl")},
        "risk": {"decision": "APPROVED" if out["accepted"] else "REJECTED", "reasons": out["reasons"], "notes": "Validated by the internal paper engine (balances, holdings, limits, kill switch).",
                 "warnings": [mode_info["warning"]] if mode_info.get("warning") else [], "officer": "INTERNAL_PAPER_ENGINE"},
        "provider_response": None,
    })
    return out

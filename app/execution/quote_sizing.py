"""USDT-amount sizing for execution signals.

The quantity is computed on the server from a price the server trusts: the order's own limit price, or a live quote
that is FRESH. A stale, delayed, invalid or missing quote is refused rather than guessed, because the quantity (and so
the capital at risk) depends on it. USDT-quoted symbols only. Exchange lot-size / minimum-notional rules are still
enforced downstream, and a market fill can differ from the reference price.
"""
from __future__ import annotations

from typing import Any, Optional

from app.config import Settings
from app.market.service import MarketService
from app.trading.sizing import SizingError, quote_to_qty

NOT_USDT = "quote_amount is in USDT and only works with USDT-quoted symbols such as BTCUSDT; send qty instead"


class QuoteSizingError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


async def size_from_usdt(quote_amount: float, symbol: str, limit_price: Optional[float], provider: str,
                         settings: Settings, market: Optional[Any] = None) -> tuple[float, dict]:
    sym = (symbol or "").upper()
    if not sym.endswith("USDT"):
        raise QuoteSizingError(422, NOT_USDT)
    if limit_price is not None:
        ref, source = limit_price, "limit_price"
    else:
        svc = market or MarketService(settings)
        try:
            snap = await svc.get_snapshot(provider, sym)
        except Exception:
            raise QuoteSizingError(502, "Could not fetch a reference price to convert the USDT amount; try again or send qty")
        price, status = snap.get("price"), snap.get("data_status")
        if price is None or status != "fresh":
            raise QuoteSizingError(503, f"No fresh reference price for {sym} (data status: {status or 'unknown'}); "
                                        "the USDT amount was not converted. Try again or send qty.")
        ref, source = price, "live_quote"
    try:
        sizing = quote_to_qty(quote_amount, ref, sym)
    except SizingError as exc:
        raise QuoteSizingError(422, str(exc))
    sizing["price_source"] = source
    sizing["note"] = ("Quantity is rounded down from the USDT amount at the reference price. Market fills can differ, "
                      "and exchange lot-size/minimum-notional rules still apply.")
    return sizing["qty"], sizing

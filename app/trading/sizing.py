"""Convert a USDT amount into an order quantity.

The conversion is done server-side from a price the server trusts (the limit price for limit orders, otherwise
the live quote). Quantity is rounded DOWN so the order never costs more than the requested USDT amount at the
reference price. Exchange lot-size / min-notional filters are not known here and are still enforced downstream;
for market orders the actual fill price (and so the actual cost) can differ from the reference price.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_DOWN
from typing import Optional

QTY_DECIMALS = 8


class SizingError(ValueError):
    """The USDT amount cannot be converted to a quantity."""


def quote_to_qty(quote_amount: float, price: Optional[float], symbol: str, decimals: int = QTY_DECIMALS) -> dict:
    if not str(symbol).upper().endswith("USDT"):
        raise SizingError("quote_amount is in USDT and only works with USDT-quoted symbols such as BTCUSDT; send qty instead")
    if price is None:
        raise SizingError("no reference price is available to convert the USDT amount; try again or send qty")
    try:
        amt, px = Decimal(str(quote_amount)), Decimal(str(price))
    except Exception:
        raise SizingError("quote_amount or price is not a valid number")
    if not amt.is_finite() or not px.is_finite() or amt <= 0 or px <= 0:
        raise SizingError("quote_amount and the reference price must be positive numbers")
    qty = (amt / px).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_DOWN)
    if qty <= 0:
        raise SizingError("quote_amount is too small to buy or sell any quantity at this price")
    return {
        "quote_amount": float(amt),
        "quote_currency": "USDT",
        "reference_price": float(px),
        "qty": float(qty),
        "estimated_notional_usdt": float((qty * px).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)),
    }

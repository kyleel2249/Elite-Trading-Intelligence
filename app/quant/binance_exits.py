"""Pure helpers for Binance spot exit (OCO) orders. No network; unit-testable.

A SELL OCO protects a long: ABOVE leg = LIMIT_MAKER at the take-profit price,
BELOW leg = STOP_LOSS_LIMIT (stop trigger + limit slightly under it). Binance requires
    take_profit > last_price > stop_price
for a SELL OCO, quantity on a LOT_SIZE step, prices on the PRICE_FILTER tick and notional >= minNotional.
Endpoint: POST /api/v3/orderList/oco (aboveType/belowType form).
"""
from __future__ import annotations

from decimal import ROUND_DOWN, Decimal
from typing import Any, Optional

STOP_LIMIT_BUFFER = Decimal("0.002")   # limit leg 0.2% under the stop trigger so it can fill


def fmt(value: Decimal | float | str) -> str:
    """Plain decimal string (no scientific notation, no trailing zeros)."""
    d = Decimal(str(value))
    s = format(d.normalize(), "f")
    return s if "." not in s else s.rstrip("0").rstrip(".")


def round_down(value: float | Decimal, step: float | str | Decimal) -> Decimal:
    step_d = Decimal(str(step))
    if step_d <= 0:
        return Decimal(str(value))
    v = Decimal(str(value))
    return (v / step_d).to_integral_value(rounding=ROUND_DOWN) * step_d


def base_qty_after_fees(executed_qty: float, fills: Optional[list[dict[str, Any]]], base_asset: str) -> Decimal:
    """Commission paid in the base asset reduces what can be sold; commission in BNB/quote does not."""
    qty = Decimal(str(executed_qty))
    for f in fills or []:
        if str(f.get("commissionAsset", "")).upper() == base_asset.upper():
            qty -= Decimal(str(f.get("commission", "0")))
    return max(Decimal("0"), qty)


def plan_exit_oco(*, qty: Decimal, take_profit: float, stop_price: float, last_price: float,
                  tick_size: str, step_size: str, min_qty: str, min_notional: Optional[str]) -> dict[str, Decimal]:
    """Validate and round an exit plan; raises ValueError (never submits a doomed order)."""
    q = round_down(qty, step_size)
    if q < Decimal(str(min_qty)) or q <= 0:
        raise ValueError(f"exit quantity {q} below minimum {min_qty} after step rounding")
    tp = round_down(take_profit, tick_size)
    stop = round_down(stop_price, tick_size)
    stop_limit = round_down(Decimal(str(stop_price)) * (1 - STOP_LIMIT_BUFFER), tick_size)
    last = Decimal(str(last_price))
    if not (tp > last > stop > 0):
        raise ValueError(f"OCO needs take_profit {tp} > last {last} > stop {stop}")
    if stop_limit <= 0 or stop_limit > stop:
        raise ValueError("invalid stop-limit price")
    if min_notional is not None and q * stop_limit < Decimal(str(min_notional)):
        raise ValueError(f"exit notional below minNotional {min_notional}")
    return {"quantity": q, "take_profit": tp, "stop": stop, "stop_limit": stop_limit}


def build_oco_params(symbol: str, plan: dict[str, Decimal], timestamp_ms: int,
                     list_client_order_id: Optional[str] = None) -> dict[str, Any]:
    params: dict[str, Any] = {
        "symbol": symbol.upper(), "side": "SELL", "quantity": fmt(plan["quantity"]),
        "aboveType": "LIMIT_MAKER", "abovePrice": fmt(plan["take_profit"]),
        "belowType": "STOP_LOSS_LIMIT", "belowStopPrice": fmt(plan["stop"]),
        "belowPrice": fmt(plan["stop_limit"]), "belowTimeInForce": "GTC",
        "timestamp": timestamp_ms,
    }
    if list_client_order_id:
        params["listClientOrderId"] = list_client_order_id
    return params


def parse_symbol_filters(exchange_info: dict[str, Any]) -> dict[str, Any]:
    sym = (exchange_info.get("symbols") or [None])[0]
    if not sym:
        raise ValueError("symbol not found in exchangeInfo")
    f = {x.get("filterType"): x for x in sym.get("filters", [])}
    notional = f.get("NOTIONAL") or f.get("MIN_NOTIONAL") or {}
    return {
        "base_asset": sym.get("baseAsset"), "quote_asset": sym.get("quoteAsset"),
        "tick_size": (f.get("PRICE_FILTER") or {}).get("tickSize", "0.00000001"),
        "step_size": (f.get("LOT_SIZE") or {}).get("stepSize", "0.00000001"),
        "min_qty": (f.get("LOT_SIZE") or {}).get("minQty", "0"),
        "min_notional": notional.get("minNotional"),
    }


def protective_from_oco(resp: dict[str, Any]) -> dict[str, Any]:
    """Report 'attached' only if Binance returned an order list with live orders."""
    orders = resp.get("orders") or []
    if resp.get("orderListId") is not None and orders:
        return {"status": "attached", "method": "binance_oco", "order_list_id": resp.get("orderListId"),
                "list_status": resp.get("listOrderStatus"), "orders": [o.get("orderId") for o in orders]}
    return {"status": "requested_unconfirmed", "reason": "OCO response contained no order list"}

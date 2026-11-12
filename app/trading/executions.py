"""Normalize confirmed cumulative executions, never quote hints."""
from __future__ import annotations
import math
from typing import Any


def normalize_execution(provider: str, data: dict[str, Any]) -> dict[str, Any]:
    raw = str(data.get("status") or "").lower()
    status = {"new": "submitted", "accepted": "submitted", "pending_new": "pending",
              "partially_filled": "partial", "cancelled": "canceled",
              "pending_cancel": "submitted", "pending_replace": "submitted"}.get(raw, raw)
    if status not in {"submitted", "pending", "partial", "filled", "canceled", "rejected", "expired"}:
        # Unknown broker states must stay visible to the reconciler.
        status = "submitted"
    key = "filled_qty" if provider == "alpaca" else "executedQty"
    raw_qty = data.get(key)
    if raw_qty is None and status in {"partial", "filled"}:
        raise ValueError("Execution response lacks cumulative filled quantity")
    qty = float(raw_qty or 0)
    if not math.isfinite(qty) or qty < 0:
        raise ValueError("Invalid cumulative filled quantity")
    price = None
    if qty > 0:
        if provider == "alpaca":
            price = float(data.get("filled_avg_price") or 0)
        else:
            quote = data.get("cummulativeQuoteQty", data.get("cumulativeQuoteQty"))
            if quote is not None:
                price = float(quote) / qty
            elif data.get("fills"):
                fills = data["fills"]
                filled = sum(float(f["qty"]) for f in fills)
                if not math.isclose(filled, qty, rel_tol=1e-10, abs_tol=1e-12):
                    raise ValueError("Incomplete execution fills")
                price = sum(float(f["qty"]) * float(f["price"]) for f in fills) / qty
            else:
                price = float(data.get("avgPrice") or 0)
        if not math.isfinite(price) or price <= 0:
            raise ValueError("Execution response lacks valid cumulative execution price")
    if status == "filled" and qty <= 0:
        raise ValueError("Filled order has no executed quantity")
    return {"status": status, "filled_qty": qty, "fill_price": price,
            "provider_order_id": str(data.get("id") or data.get("orderId") or "") or None}

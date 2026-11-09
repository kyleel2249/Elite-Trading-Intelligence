"""Alpaca (US equities/ETFs) REST adapter.

Endpoints used: GET /v2/account, /v2/positions, /v2/orders, /v2/orders:by_client_order_id, /v2/clock,
POST /v2/orders, DELETE /v2/orders/{id}; market data GET /v2/stocks/{sym}/quotes/latest on data.alpaca.markets.
Alpaca API keys cannot withdraw funds, so there is nothing to refuse there.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from ..domain import BrokerOrder, BrokerPosition, OrderStatus, OrderType, Quote, Side, utcnow
from ..errors import (OrderRejectedError, PermanentProviderError, TransientProviderError)
from .base import BrokerAdapter
from .transport import HttpxTransport

_STATUS = {
    "new": OrderStatus.SUBMITTED, "accepted": OrderStatus.SUBMITTED, "pending_new": OrderStatus.SUBMITTED,
    "accepted_for_bidding": OrderStatus.SUBMITTED, "held": OrderStatus.SUBMITTED,
    "partially_filled": OrderStatus.PARTIALLY_FILLED, "filled": OrderStatus.FILLED,
    "canceled": OrderStatus.CANCELED, "pending_cancel": OrderStatus.SUBMITTED,
    "expired": OrderStatus.EXPIRED, "rejected": OrderStatus.REJECTED, "done_for_day": OrderStatus.EXPIRED,
    "replaced": OrderStatus.CANCELED, "stopped": OrderStatus.REJECTED, "suspended": OrderStatus.REJECTED,
}


def raise_for(status: int, body, what: str):
    if status in (200, 201, 204):
        return
    text = str(body)[:200]
    if status in (408, 425, 429) or status >= 500:
        raise TransientProviderError(f"{what}: HTTP {status}")
    if status in (401, 403):
        raise PermanentProviderError(f"{what}: authentication/permission failure (HTTP {status})")
    raise OrderRejectedError(f"{what}: HTTP {status} {text}")


class AlpacaAdapter(BrokerAdapter):
    name = "alpaca"

    def __init__(self, key_id: str, secret: str, *, paper: bool = True, transport=None):
        self.environment = "paper" if paper else "live"
        self._h = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
        self.base = "https://paper-api.alpaca.markets" if paper else "https://api.alpaca.markets"
        self.data = "https://data.alpaca.markets"
        self.t = transport or HttpxTransport()

    async def _get(self, path, params=None, base=None, what="request"):
        s, b = await self.t.request("GET", (base or self.base) + path, params=params, headers=self._h)
        return s, b

    async def get_quote(self, symbol):
        s, b = await self._get(f"/v2/stocks/{symbol.upper()}/quotes/latest", base=self.data)
        raise_for(s, b, "alpaca quote")
        q = (b or {}).get("quote") or {}
        try:
            bid, ask = float(q["bp"]), float(q["ap"])
        except (KeyError, TypeError, ValueError):
            raise TransientProviderError("alpaca quote: malformed response") from None
        try:
            ts = datetime.fromisoformat(str(q["t"]).replace("Z", "+00:00")).astimezone(timezone.utc)
        except (KeyError, ValueError):
            ts = utcnow()
        return Quote("alpaca", symbol.upper(), bid, ask, ts)

    async def get_equity(self):
        s, b = await self._get("/v2/account")
        raise_for(s, b, "alpaca account")
        if b.get("trading_blocked") or b.get("account_blocked"):
            raise PermanentProviderError("alpaca account is blocked from trading")
        return float(b["equity"])

    async def get_positions(self):
        s, b = await self._get("/v2/positions")
        raise_for(s, b, "alpaca positions")
        out = []
        for p in b:
            qty = float(p["qty"])
            if p.get("side") == "short":
                qty = -abs(qty)
            out.append(BrokerPosition(p["symbol"], qty, float(p.get("avg_entry_price") or 0),
                                      float(p["current_price"]) if p.get("current_price") else None))
        return out

    async def market_open(self, symbol):
        s, b = await self._get("/v2/clock")
        raise_for(s, b, "alpaca clock")
        return bool(b.get("is_open"))

    def _order(self, o) -> BrokerOrder:
        st = _STATUS.get(str(o.get("status", "")).lower(), OrderStatus.UNKNOWN)
        avg = o.get("filled_avg_price")
        return BrokerOrder(o.get("client_order_id", ""), o.get("id"), st, float(o.get("qty") or 0),
                           float(o.get("filled_qty") or 0), float(avg) if avg else None)

    async def submit_order(self, *, client_order_id, symbol, side, qty, order_type, limit_price, reduce_only=False):
        body = {"symbol": symbol.upper(), "qty": f"{qty:.8f}".rstrip("0").rstrip("."), "side": side.value,
                "type": order_type.value, "time_in_force": "day", "client_order_id": client_order_id}
        if order_type == OrderType.LIMIT:
            body["limit_price"] = f"{limit_price:.8f}".rstrip("0").rstrip(".")
        s, b = await self.t.request("POST", self.base + "/v2/orders", json=body, headers=self._h, write=True)
        raise_for(s, b, "alpaca order")
        return self._order(b)

    async def get_order_by_client_id(self, symbol, client_order_id):
        s, b = await self._get("/v2/orders:by_client_order_id", params={"client_order_id": client_order_id})
        if s == 404:
            return None
        raise_for(s, b, "alpaca order lookup")
        return self._order(b)

    async def cancel_order(self, symbol, client_order_id, provider_order_id):
        oid = provider_order_id
        if not oid:
            o = await self.get_order_by_client_id(symbol, client_order_id)
            if o is None:
                return
            oid = o.provider_order_id
        s, b = await self.t.request("DELETE", f"{self.base}/v2/orders/{oid}", headers=self._h)
        if s in (404, 422):     # already filled/cancelled/unknown: nothing left to cancel
            return
        raise_for(s, b, "alpaca cancel")

    async def list_open_orders(self):
        s, b = await self._get("/v2/orders", params={"status": "open", "limit": 500})
        raise_for(s, b, "alpaca open orders")
        return [self._order(o) for o in b]

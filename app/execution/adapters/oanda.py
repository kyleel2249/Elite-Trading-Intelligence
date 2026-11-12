"""OANDA v20 REST adapter (forex/CFDs, practice or live). Supports shorting; positions are native.

Instruments use OANDA's form (EUR_USD). Idempotency uses clientExtensions.id and lookups via the
`@<clientID>` order alias. Withdrawals are not exposed by the v20 trading API token.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from ..domain import BrokerOrder, BrokerPosition, OrderStatus, OrderType, Quote, Side, utcnow
from ..errors import OrderRejectedError, PermanentProviderError, TransientProviderError
from .alpaca import raise_for
from .base import BrokerAdapter
from .transport import HttpxTransport


def _units(side: Side, qty: float) -> str:
    n = int(round(qty))
    return f"{n if side == Side.BUY else -n}"


class OandaAdapter(BrokerAdapter):
    name = "oanda"
    supports_order_book = False

    def __init__(self, token: str, account_id: str, *, practice: bool = True, transport=None):
        self.environment = "paper" if practice else "live"
        self.base = "https://api-fxpractice.oanda.com" if practice else "https://api-fxtrade.oanda.com"
        self.acct = account_id
        self._h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self.t = transport or HttpxTransport()

    async def _get(self, path, params=None):
        return await self.t.request("GET", f"{self.base}/v3/accounts/{self.acct}{path}", params=params,
                                    headers=self._h)

    async def get_quote(self, symbol):
        s, b = await self._get("/pricing", {"instruments": symbol.upper()})
        raise_for(s, b, "oanda pricing")
        try:
            p = b["prices"][0]
            if not p.get("tradeable", True):
                raise TransientProviderError("oanda: instrument not tradeable (market closed or halted)")
            bid, ask = float(p["bids"][0]["price"]), float(p["asks"][0]["price"])
            ts = datetime.fromisoformat(p["time"][:26].rstrip("Z") + "+00:00") if "time" in p else utcnow()
        except (KeyError, IndexError, TypeError, ValueError):
            raise TransientProviderError("oanda pricing: malformed response") from None
        return Quote("oanda", symbol.upper(), bid, ask, ts.astimezone(timezone.utc))

    async def get_equity(self):
        s, b = await self._get("/summary")
        raise_for(s, b, "oanda summary")
        return float(b["account"]["NAV"])

    async def get_positions(self):
        s, b = await self._get("/openPositions")
        raise_for(s, b, "oanda positions")
        out = []
        for p in b.get("positions", []):
            long_u, short_u = float(p["long"]["units"]), float(p["short"]["units"])
            net = long_u + short_u
            side = p["long"] if long_u else p["short"]
            if abs(net) > 0:
                out.append(BrokerPosition(p["instrument"], net, float(side.get("averagePrice") or 0)))
        return out

    async def market_open(self, symbol):
        try:
            await self.get_quote(symbol)
            return True
        except TransientProviderError:
            return False

    def _order(self, o: dict, fill: Optional[dict] = None) -> BrokerOrder:
        state = str(o.get("state", "")).upper()
        qty = abs(float(o.get("units") or (fill or {}).get("units") or 0))
        cid = (o.get("clientExtensions") or {}).get("id", "")
        st = {"PENDING": OrderStatus.SUBMITTED, "FILLED": OrderStatus.FILLED,
              "CANCELLED": OrderStatus.CANCELED, "TRIGGERED": OrderStatus.FILLED}.get(state, OrderStatus.UNKNOWN)
        filled = abs(float((fill or {}).get("units") or 0)) if fill else (qty if st == OrderStatus.FILLED else 0.0)
        px = float(fill["price"]) if fill and fill.get("price") else None
        return BrokerOrder(cid, o.get("id"), st, qty, filled, px)

    async def submit_order(self, *, client_order_id, symbol, side, qty, order_type, limit_price, reduce_only=False):
        order = {"instrument": symbol.upper(), "units": _units(side, qty), "positionFill": "REDUCE_ONLY" if reduce_only else "DEFAULT",
                 "clientExtensions": {"id": client_order_id}}
        if order_type == OrderType.MARKET:
            order.update(type="MARKET", timeInForce="FOK")
        else:
            order.update(type="LIMIT", price=f"{limit_price:.5f}", timeInForce="IOC")
        s, b = await self.t.request("POST", f"{self.base}/v3/accounts/{self.acct}/orders", json={"order": order},
                                    headers=self._h, write=True)
        if s not in (200, 201):
            raise_for(s, b, "oanda order")
        if "orderCancelTransaction" in b and "orderFillTransaction" not in b:
            reason = b["orderCancelTransaction"].get("reason", "cancelled")
            if order_type == OrderType.MARKET or reason in ("MARKET_HALTED", "INSUFFICIENT_MARGIN", "LOSING_TAKE_PROFIT"):
                raise OrderRejectedError(f"oanda order cancelled: {reason}")
            return BrokerOrder(client_order_id, b["orderCancelTransaction"].get("orderID"), OrderStatus.CANCELED,
                               abs(float(order["units"])))
        fill = b.get("orderFillTransaction")
        create = b.get("orderCreateTransaction", {})
        if fill:
            req = abs(float(order["units"]))
            got = abs(float(fill["units"]))
            return BrokerOrder(client_order_id, create.get("id") or fill.get("orderID"),
                               OrderStatus.FILLED if got >= req else OrderStatus.PARTIALLY_FILLED,
                               req, got, float(fill["price"]))
        return BrokerOrder(client_order_id, create.get("id"), OrderStatus.SUBMITTED, abs(float(order["units"])))

    async def get_order_by_client_id(self, symbol, client_order_id):
        s, b = await self._get(f"/orders/@{client_order_id}")
        if s == 404:
            return None
        raise_for(s, b, "oanda order lookup")
        o = b["order"]
        fill = None
        if o.get("fillingTransactionID"):
            fs, fb = await self._get(f"/transactions/{o['fillingTransactionID']}")
            raise_for(fs, fb, "oanda fill lookup")
            fill = fb.get("transaction")
        return self._order(o, fill)

    async def cancel_order(self, symbol, client_order_id, provider_order_id):
        s, b = await self.t.request("PUT", f"{self.base}/v3/accounts/{self.acct}/orders/@{client_order_id}/cancel",
                                    headers=self._h)
        if s == 404:
            return
        raise_for(s, b, "oanda cancel")

    async def list_open_orders(self):
        s, b = await self._get("/orders", {"state": "PENDING"})
        raise_for(s, b, "oanda open orders")
        return [self._order(o) for o in b.get("orders", [])]

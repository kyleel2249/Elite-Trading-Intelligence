"""Binance Spot REST adapter (live or testnet).

Spot has balances rather than positions, so positions are derived from non-zero base-asset balances for the
symbols the account is approved to trade. Shorting is not available on spot.
Withdrawal safety: on live, GET /sapi/v1/account/apiRestrictions is read and the adapter refuses to operate
when the key has withdrawals enabled.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlencode

from ..domain import (BrokerOrder, BrokerPosition, InstrumentRules, OrderBook, OrderStatus, OrderType, Quote, Side,
                      utcnow)
from ..errors import (OrderRejectedError, PermanentProviderError, PermissionPolicyError, TransientProviderError)
from .base import BrokerAdapter
from .transport import HttpxTransport

_STATUS = {"NEW": OrderStatus.SUBMITTED, "PARTIALLY_FILLED": OrderStatus.PARTIALLY_FILLED,
           "FILLED": OrderStatus.FILLED, "CANCELED": OrderStatus.CANCELED, "PENDING_CANCEL": OrderStatus.SUBMITTED,
           "REJECTED": OrderStatus.REJECTED, "EXPIRED": OrderStatus.EXPIRED,
           "EXPIRED_IN_MATCH": OrderStatus.EXPIRED}
_QUOTE_ASSETS = ("USDT", "USDC", "FDUSD", "BUSD", "TUSD", "EUR", "GBP", "BTC", "ETH", "BNB")


def split_symbol(symbol: str) -> tuple:
    s = symbol.upper()
    for q in _QUOTE_ASSETS:
        if s.endswith(q) and len(s) > len(q):
            return s[: -len(q)], q
    return s, ""


def _fmt(x: float) -> str:
    return f"{x:.8f}".rstrip("0").rstrip(".")


class BinanceAdapter(BrokerAdapter):
    name = "binance"
    supports_order_book = True
    supports_short = False      # spot only

    def __init__(self, api_key: str, secret: str, *, testnet: bool = True, symbols=(), transport=None,
                 clock_ms=lambda: int(time.time() * 1000)):
        self.environment = "paper" if testnet else "live"
        self.testnet = testnet
        self.base = "https://testnet.binance.vision" if testnet else "https://api.binance.com"
        self._key, self._secret = api_key, secret.encode()
        self.symbols = [s.upper() for s in symbols]
        self.t = transport or HttpxTransport()
        self._ms = clock_ms
        self._rules: dict = {}
        self._perms_ok = False

    # ---- plumbing ----
    def _sign(self, params: dict) -> dict:
        params = dict(params, timestamp=self._ms(), recvWindow=5000)
        params["signature"] = hmac.new(self._secret, urlencode(params).encode(), hashlib.sha256).hexdigest()
        return params

    async def _pub(self, path, params=None):
        return await self.t.request("GET", self.base + path, params=params)

    async def _signed(self, method, path, params=None, write=False):
        s, b = await self.t.request(method, self.base + path, params=self._sign(params or {}),
                                    headers={"X-MBX-APIKEY": self._key}, write=write)
        return s, b

    @staticmethod
    def _raise(s, b, what):
        if s == 200:
            return
        code = b.get("code") if isinstance(b, dict) else None
        msg = (b.get("msg") if isinstance(b, dict) else str(b))[:200]
        if s in (418, 429) or s >= 500:
            raise TransientProviderError(f"{what}: HTTP {s}")
        if code == -1021:      # timestamp outside recvWindow: clock drift, retryable after resync
            raise TransientProviderError(f"{what}: clock drift ({msg})")
        if s in (401, 403) or code in (-2014, -2015):
            raise PermanentProviderError(f"{what}: authentication/permission failure")
        raise OrderRejectedError(f"{what}: {code} {msg}")

    # ---- safety ----
    async def verify_permissions(self):
        if self.testnet:
            self._perms_ok = True
            return
        s, b = await self._signed("GET", "/sapi/v1/account/apiRestrictions")
        self._raise(s, b, "binance apiRestrictions")
        if b.get("enableWithdrawals"):
            raise PermissionPolicyError("API key has withdrawals enabled; ETI refuses to use it. "
                                        "Create a trade-only key (no withdrawals) and re-register.")
        if not b.get("enableSpotAndMarginTrading"):
            raise PermissionPolicyError("API key lacks spot trading permission")
        self._perms_ok = True

    # ---- market data ----
    async def get_quote(self, symbol):
        s, b = await self._pub("/api/v3/ticker/bookTicker", {"symbol": symbol.upper()})
        self._raise(s, b, "binance quote")
        try:
            bid, ask = float(b["bidPrice"]), float(b["askPrice"])
        except (KeyError, TypeError, ValueError):
            raise TransientProviderError("binance quote: malformed response") from None
        # bookTicker carries no timestamp: retrieval time is the freshest honest value.
        return Quote("binance", symbol.upper(), bid, ask, utcnow())

    async def get_order_book(self, symbol, depth=20):
        s, b = await self._pub("/api/v3/depth", {"symbol": symbol.upper(), "limit": depth})
        self._raise(s, b, "binance depth")
        return OrderBook(symbol.upper(), tuple((float(p), float(q)) for p, q in b["bids"]),
                         tuple((float(p), float(q)) for p, q in b["asks"]), utcnow())

    async def get_rules(self, symbol):
        sym = symbol.upper()
        if sym not in self._rules:
            s, b = await self._pub("/api/v3/exchangeInfo", {"symbol": sym})
            self._raise(s, b, "binance exchangeInfo")
            f = {x["filterType"]: x for x in b["symbols"][0]["filters"]}
            notional = f.get("NOTIONAL") or f.get("MIN_NOTIONAL") or {}
            self._rules[sym] = InstrumentRules(
                tick_size=float(f.get("PRICE_FILTER", {}).get("tickSize", 0)),
                step_size=float(f.get("LOT_SIZE", {}).get("stepSize", 0)),
                min_qty=float(f.get("LOT_SIZE", {}).get("minQty", 0)),
                min_notional=float(notional.get("minNotional", 0)))
        return self._rules[sym]

    # ---- account ----
    async def _balances(self) -> dict:
        s, b = await self._signed("GET", "/api/v3/account")
        self._raise(s, b, "binance account")
        if not b.get("canTrade", True):
            raise PermanentProviderError("binance account cannot trade")
        return {x["asset"]: float(x["free"]) + float(x["locked"]) for x in b["balances"]}

    async def get_positions(self):
        bal = await self._balances()
        out = []
        for sym in self.symbols:
            base, _ = split_symbol(sym)
            qty = bal.get(base, 0.0)
            if qty > 0:
                try:
                    mark = (await self.get_quote(sym)).mid
                except TransientProviderError:
                    mark = None
                out.append(BrokerPosition(sym, qty, 0.0, mark))
        return out

    async def get_equity(self):
        bal = await self._balances()
        total = sum(bal.get(a, 0.0) for a in ("USDT", "USDC", "FDUSD", "BUSD"))
        for p in await self.get_positions():
            if p.mark_price:
                total += p.qty * p.mark_price
        return total

    # ---- orders ----
    def _order(self, o) -> BrokerOrder:
        executed = float(o.get("executedQty") or 0)
        quote_qty = float(o.get("cummulativeQuoteQty") or 0)
        return BrokerOrder(o.get("clientOrderId", ""), str(o.get("orderId", "")) or None,
                           _STATUS.get(str(o.get("status", "")).upper(), OrderStatus.UNKNOWN),
                           float(o.get("origQty") or 0), executed, quote_qty / executed if executed else None)

    async def submit_order(self, *, client_order_id, symbol, side, qty, order_type, limit_price, reduce_only=False):
        if not self._perms_ok:
            await self.verify_permissions()
        if order_type == OrderType.MARKET:
            params = {"symbol": symbol.upper(), "side": side.value.upper(), "type": "MARKET",
                      "quantity": _fmt(qty)}
        else:
            # IOC: anything not filled immediately is cancelled, so no resting order outlives the guard checks.
            params = {"symbol": symbol.upper(), "side": side.value.upper(), "type": "LIMIT",
                      "timeInForce": "IOC", "quantity": _fmt(qty), "price": _fmt(limit_price)}
        params.update(newClientOrderId=client_order_id, newOrderRespType="FULL")
        s, b = await self._signed("POST", "/api/v3/order", params, write=True)
        self._raise(s, b, "binance order")
        return self._order(b)

    async def get_order_by_client_id(self, symbol, client_order_id):
        s, b = await self._signed("GET", "/api/v3/order",
                                  {"symbol": symbol.upper(), "origClientOrderId": client_order_id})
        if s == 400 and isinstance(b, dict) and b.get("code") == -2013:    # Order does not exist
            return None
        self._raise(s, b, "binance order lookup")
        return self._order(b)

    async def cancel_order(self, symbol, client_order_id, provider_order_id):
        s, b = await self._signed("DELETE", "/api/v3/order",
                                  {"symbol": symbol.upper(), "origClientOrderId": client_order_id})
        if s == 400 and isinstance(b, dict) and b.get("code") in (-2011, -2013):   # unknown / already done
            return
        self._raise(s, b, "binance cancel")

    async def list_open_orders(self):
        out = []
        for sym in self.symbols:
            s, b = await self._signed("GET", "/api/v3/openOrders", {"symbol": sym})
            self._raise(s, b, "binance openOrders")
            out.extend(self._order(o) for o in b)
        return out

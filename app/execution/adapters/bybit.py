"""Bybit V5 Unified Trading Account adapter (spot, linear and inverse).

Credentials stay server-side. Testnet is the default; live requires explicit account environment
and the existing ETI live-trading/risk approvals. This adapter never exposes transfer/withdrawal APIs.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Optional
from urllib.parse import urlencode

from ..domain import (BrokerOrder, BrokerPosition, InstrumentRules, OrderBook, OrderStatus, OrderType, Quote, Side, utcnow)
from ..errors import (OrderRejectedError, PermanentProviderError, PermissionPolicyError, TransientProviderError,
                      UnknownOutcomeError)
from .base import BrokerAdapter
from .transport import HttpxTransport

_STATUS = {
    "New": OrderStatus.SUBMITTED, "PartiallyFilled": OrderStatus.PARTIALLY_FILLED,
    "Filled": OrderStatus.FILLED, "Cancelled": OrderStatus.CANCELED,
    "Rejected": OrderStatus.REJECTED, "PartiallyFilledCanceled": OrderStatus.CANCELED,
    "Deactivated": OrderStatus.CANCELED, "Untriggered": OrderStatus.SUBMITTED,
    "Triggered": OrderStatus.SUBMITTED, "Active": OrderStatus.SUBMITTED,
}


def _fmt(value: float) -> str:
    return format(value, ".16g")


class BybitAdapter(BrokerAdapter):
    name = "bybit"
    supports_order_book = True

    def __init__(self, api_key: str, secret: str, *, testnet: bool = True, symbols=(),
                 category: str = "spot", margin_enabled: bool = False, transport=None, clock_ms=lambda: int(time.time() * 1000)):
        if category not in ("spot", "linear", "inverse"):
            raise ValueError("Bybit category must be spot, linear or inverse")
        self.environment = "paper" if testnet else "live"
        self.testnet, self.category = testnet, category
        self.margin_enabled = bool(margin_enabled) and category == "spot"
        self.base = "https://api-testnet.bybit.com" if testnet else "https://api.bybit.com"
        self._key, self._secret = api_key, secret.encode()
        self.symbols = [str(s).upper() for s in symbols]
        self.t = transport or HttpxTransport()
        self._ms = clock_ms
        self._rules: dict = {}
        self._perms_ok = False
        self.supports_short = category != "spot"

    def _signature(self, timestamp: str, payload: str) -> str:
        prehash = timestamp + self._key + "5000" + payload
        return hmac.new(self._secret, prehash.encode(), hashlib.sha256).hexdigest()

    async def _request(self, method: str, path: str, params=None, body=None, *, write=False):
        method = method.upper()
        params = dict(params or {})
        timestamp = str(self._ms())
        if method == "GET":
            query = urlencode(sorted((k, str(v)) for k, v in params.items() if v is not None))
            signature = self._signature(timestamp, query)
            headers = {"X-BAPI-API-KEY": self._key, "X-BAPI-SIGN": signature,
                       "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": "5000"}
            params = dict(sorted(params.items()))
            status, data = await self.t.request(method, self.base + path, params=params, headers=headers, write=write)
        else:
            payload = json.dumps(body or {}, separators=(",", ":"), ensure_ascii=False)
            signature = self._signature(timestamp, payload)
            headers = {"X-BAPI-API-KEY": self._key, "X-BAPI-SIGN": signature,
                       "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": "5000",
                       "Content-Type": "application/json"}
            status, data = await self.t.request(method, self.base + path, data=payload, headers=headers, write=write)
        if not isinstance(data, dict):
            raise TransientProviderError("Bybit returned a malformed response")
        code = data.get("retCode")
        if status == 429 or status >= 500 or code in (10000, 10002, 10006, 10016, 10018):
            if write:
                raise UnknownOutcomeError("Bybit write outcome is not confirmed; reconcile by orderLinkId")
            raise TransientProviderError(f"Bybit temporary failure ({status}/{code})")
        if status in (401, 403) or code in (10003, 10004, 10005, 10007, 10010):
            raise PermanentProviderError(f"Bybit authentication or permission failure ({code})")
        if code == 110001:
            return {}
        if status >= 400 or code != 0:
            raise OrderRejectedError(f"Bybit rejected request ({code}): {str(data.get('retMsg', 'rejected'))[:180]}")
        return data.get("result") or {}

    async def verify_permissions(self):
        if self.testnet:
            self._perms_ok = True
            return
        result = await self._request("GET", "/v5/user/query-api")
        info = result.get("apiKey") or result
        permissions = info.get("permissions") or {}
        flat = " ".join(str(x) for x in permissions.values()) if isinstance(permissions, dict) else str(permissions)
        if info.get("readOnly") in (1, "1", True):
            raise PermissionPolicyError("Bybit API key is read-only; enable the required trade permissions.")
        if any(term in flat.lower() for term in ("withdraw", "assettransfer", "transfer")):
            raise PermissionPolicyError("Bybit API key has transfer/withdrawal capability; ETI refuses to use it.")
        self._perms_ok = True

    async def get_quote(self, symbol):
        result = await self._request("GET", "/v5/market/tickers", {"category": self.category, "symbol": symbol.upper()})
        rows = result.get("list") or []
        if not rows:
            raise TransientProviderError("Bybit ticker returned no instrument")
        row = rows[0]
        try:
            bid, ask = float(row["bid1Price"]), float(row["ask1Price"])
            last = float(row.get("lastPrice") or 0) or None
        except (KeyError, TypeError, ValueError):
            raise TransientProviderError("Bybit ticker payload is malformed") from None
        quote = Quote("bybit", symbol.upper(), bid, ask, utcnow(), last)
        if not quote.valid:
            raise TransientProviderError("Bybit returned an invalid bid/ask")
        return quote

    async def get_order_book(self, symbol, depth=20):
        result = await self._request("GET", "/v5/market/orderbook",
                                     {"category": self.category, "symbol": symbol.upper(), "limit": min(200, max(1, depth))})
        try:
            bids = tuple((float(p), float(q)) for p, q in result["b"])
            asks = tuple((float(p), float(q)) for p, q in result["a"])
            if not bids or not asks or bids[0][0] >= asks[0][0]:
                raise ValueError("empty or crossed book")
            return OrderBook(symbol.upper(), bids, asks, utcnow())
        except (KeyError, TypeError, ValueError):
            raise TransientProviderError("Bybit order book payload is malformed") from None

    async def get_rules(self, symbol):
        sym = symbol.upper()
        if sym not in self._rules:
            result = await self._request("GET", "/v5/market/instruments-info",
                                         {"category": self.category, "symbol": sym})
            rows = result.get("list") or []
            if not rows:
                raise OrderRejectedError(f"Bybit instrument {sym} is not listed in {self.category}")
            row = rows[0]
            lot, price = row.get("lotSizeFilter") or {}, row.get("priceFilter") or {}
            self._rules[sym] = InstrumentRules(
                tick_size=float(price.get("tickSize") or 0),
                step_size=float(lot.get("qtyStep") or 0),
                min_qty=float(lot.get("minOrderQty") or 0),
                min_notional=float(lot.get("minNotionalValue") or 0))
        return self._rules[sym]

    async def get_equity(self):
        result = await self._request("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})
        rows = result.get("list") or []
        if not rows:
            raise TransientProviderError("Bybit Unified Trading Account balance is unavailable")
        try:
            return float(rows[0]["totalEquity"])
        except (KeyError, TypeError, ValueError):
            raise TransientProviderError("Bybit account equity payload is malformed") from None

    async def get_positions(self):
        if self.category == "spot":
            if not self.symbols:
                return []
            result = await self._request("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})
            accounts = result.get("list") or []
            coins = {str(c.get("coin") or "").upper(): float(c.get("walletBalance") or 0)
                     for c in (accounts[0].get("coin") or [])} if accounts else {}
            out = []
            for symbol in self.symbols:
                base = next((symbol[:-len(q)] for q in ("USDT", "USDC", "BTC", "ETH", "USD") if symbol.endswith(q)), "")
                qty = coins.get(base, 0.0)
                if qty > 0:
                    quote = await self.get_quote(symbol)
                    out.append(BrokerPosition(symbol, qty, 0.0, quote.mid))
            return out
        out = []
        targets = self.symbols or [None]
        for symbol in targets:
            params = {"category": self.category, "symbol": symbol}
            if symbol is None:
                params["settleCoin"] = "USDT" if self.category == "linear" else "BTC"
            result = await self._request("GET", "/v5/position/list", params)
            for row in result.get("list") or []:
                size = float(row.get("size") or 0)
                if size <= 0:
                    continue
                signed = size if row.get("side") == "Buy" else -size
                out.append(BrokerPosition(str(row["symbol"]), signed, float(row.get("avgPrice") or 0),
                                          float(row.get("markPrice") or 0) or None))
        return out

    def _order(self, row):
        qty = float(row.get("qty") or 0)
        filled = float(row.get("cumExecQty") or 0)
        value = float(row.get("cumExecValue") or 0)
        return BrokerOrder(str(row.get("orderLinkId") or ""), str(row.get("orderId") or "") or None,
                           _STATUS.get(str(row.get("orderStatus") or ""), OrderStatus.UNKNOWN), qty, filled,
                           value / filled if filled else None, raw=dict(row))

    async def submit_order(self, *, client_order_id, symbol, side, qty, order_type, limit_price, reduce_only=False):
        if not self._perms_ok:
            await self.verify_permissions()
        if order_type == OrderType.MARKET:
            payload = {"category": self.category, "symbol": symbol.upper(), "side": "Buy" if side == Side.BUY else "Sell",
                       "orderType": "Market", "qty": _fmt(qty), "orderLinkId": client_order_id}
            if self.category == "spot":
                payload["marketUnit"] = "baseCoin"
                payload["isLeverage"] = 1 if self.margin_enabled else 0
        else:
            payload = {"category": self.category, "symbol": symbol.upper(), "side": "Buy" if side == Side.BUY else "Sell",
                       "orderType": "Limit", "qty": _fmt(qty), "price": _fmt(limit_price),
                       "timeInForce": "IOC", "orderLinkId": client_order_id}
        if self.category != "spot":
            payload["reduceOnly"] = bool(reduce_only)
            payload["positionIdx"] = 0
        elif reduce_only:
            raise OrderRejectedError("reduce_only is not supported for spot orders")
        elif self.category == "spot":
            payload["isLeverage"] = 1 if self.margin_enabled else 0
        result = await self._request("POST", "/v5/order/create", body=payload, write=True)
        if not result.get("orderId"):
            raise UnknownOutcomeError("Bybit accepted no verifiable order id; reconcile before retrying")
        return BrokerOrder(client_order_id, str(result["orderId"]), OrderStatus.SUBMITTED, qty)

    async def get_order_by_client_id(self, symbol, client_order_id):
        for path in ("/v5/order/realtime", "/v5/order/history"):
            result = await self._request("GET", path, {"category": self.category, "symbol": symbol.upper(),
                                                       "orderLinkId": client_order_id})
            rows = result.get("list") or []
            if rows:
                return self._order(rows[0])
        return None

    async def cancel_order(self, symbol, client_order_id, provider_order_id):
        payload = {"category": self.category, "symbol": symbol.upper(), "orderLinkId": client_order_id}
        if provider_order_id:
            payload["orderId"] = provider_order_id
        await self._request("POST", "/v5/order/cancel", body=payload, write=True)

    async def list_open_orders(self):
        out = []
        for symbol in self.symbols:
            result = await self._request("GET", "/v5/order/realtime", {"category": self.category, "symbol": symbol})
            out.extend(self._order(row) for row in result.get("list") or [])
        return out

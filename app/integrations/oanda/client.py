"""OANDA v20 REST integration: forex, spot metals and index/commodity CFDs.

Paper trading uses OANDA's *practice* environment (a real simulated brokerage account);
the live host is only contacted for environment="live", which the RiskEngine blocks unless
OANDA_LIVE_TRADING_ENABLED=true. Credentials are read only from settings (environment).

Endpoints used (OANDA v20 REST):
  GET  /v3/accounts/{id}/summary
  GET  /v3/accounts/{id}/instruments
  GET  /v3/accounts/{id}/pricing?instruments=
  GET  /v3/instruments/{instrument}/candles
  POST /v3/accounts/{id}/orders
  GET  /v3/accounts/{id}/orders/@{clientOrderId}
  GET  /v3/accounts/{id}/transactions/{id}
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote
from app.markets.oanda_map import resolve_oanda_name
from app.markets.registry import classify

PRACTICE_URL = "https://api-fxpractice.oanda.com"
LIVE_URL = "https://api-fxtrade.oanda.com"

GRANULARITY = {"1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D", "1w": "W", "1M": "M"}
GRANULARITY_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D": 86400, "W": 604800, "M": 2592000}

_ORDER_STATUS = {"PENDING": "submitted", "TRIGGERED": "submitted", "FILLED": "filled", "CANCELLED": "canceled"}


class OandaError(RuntimeError):
    """OANDA rejected the call or returned something unusable. Never contains credentials."""


def parse_oanda_time(raw: Any) -> datetime:
    """RFC3339 with nanoseconds ('2026-11-09T19:00:00.123456789Z') or UNIX seconds; always UTC."""
    s = str(raw)
    if s.replace(".", "", 1).isdigit():
        return datetime.fromtimestamp(float(s), tz=timezone.utc)
    s = s.rstrip("Z")
    if "." in s:
        head, frac = s.split(".", 1)
        s = f"{head}.{frac[:6].ljust(6, '0')}"
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _fmt(value: float, places: int) -> str:
    q = Decimal(1).scaleb(-places)
    return format(Decimal(str(value)).quantize(q, rounding=ROUND_DOWN), "f")


class OandaClient(BaseProvider):
    name = "oanda"

    def __init__(self, settings: Optional[Settings] = None, use_practice: bool = True,
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        self.settings = settings or get_settings()
        self.token = self.settings.oanda_api_token
        self.account_id = self.settings.oanda_account_id
        self.use_practice = use_practice
        self.base_url = PRACTICE_URL if use_practice else LIVE_URL
        self._transport = transport          # injection point for tests
        self._instruments: Optional[dict[str, dict]] = None

    @property
    def configured(self) -> bool:
        return bool(self.token and self.account_id)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "Accept-Datetime-Format": "RFC3339"}

    def _require_configured(self) -> None:
        if not self.configured:
            raise OandaError("OANDA not configured (set OANDA_API_TOKEN and OANDA_ACCOUNT_ID)")

    async def _request(self, method: str, path: str, *, params: Optional[dict] = None, json: Optional[dict] = None) -> dict:
        self._require_configured()
        async with httpx.AsyncClient(timeout=15.0, transport=self._transport) as http:
            r = await http.request(method, f"{self.base_url}{path}", params=params, json=json, headers=self._headers())
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code not in (200, 201):
            msg = body.get("errorMessage") or body.get("rejectReason") or f"HTTP {r.status_code}"
            raise OandaError(f"OANDA request failed ({r.status_code}): {str(msg)[:300]}")
        return body

    # ---------------------------------------------------------------- account / instruments
    async def health(self) -> dict[str, Any]:
        base = {"provider": self.name, "environment": "practice" if self.use_practice else "live", "base_url": self.base_url}
        if not self.configured:
            return {**base, "status": "not_configured", "configured": False}
        try:
            acct = (await self.get_account_summary()).get("account", {})
            return {**base, "status": "connected", "configured": True, "currency": acct.get("currency"),
                    "margin_available": acct.get("marginAvailable")}
        except Exception as exc:  # report, never raise from a health probe
            return {**base, "status": "error", "configured": True, "error": str(exc)[:200]}

    async def get_account_summary(self) -> dict[str, Any]:
        return await self._request("GET", f"/v3/accounts/{self.account_id}/summary")

    async def instruments(self, refresh: bool = False) -> dict[str, dict]:
        """The account's tradable instruments with their precision and minimum size (cached)."""
        if self._instruments is None or refresh:
            data = await self._request("GET", f"/v3/accounts/{self.account_id}/instruments")
            self._instruments = {i["name"]: i for i in data.get("instruments", []) if "name" in i}
        return self._instruments

    async def resolve(self, symbol: str) -> str:
        """ETI symbol -> OANDA name that this account can actually trade."""
        available = set((await self.instruments()).keys())
        name = resolve_oanda_name(symbol, available)
        if not name:
            raise OandaError(f"{symbol} is not available on this OANDA account (unmapped, or not offered in your jurisdiction)")
        return name

    # ---------------------------------------------------------------- market data
    async def get_quote(self, symbol: str) -> NormalizedQuote:
        name = await self.resolve(symbol)
        data = await self._request("GET", f"/v3/accounts/{self.account_id}/pricing", params={"instruments": name})
        prices = data.get("prices") or []
        if not prices:
            raise OandaError(f"No price returned for {name}")
        p = prices[0]
        try:
            bid, ask = float(p["bids"][0]["price"]), float(p["asks"][0]["price"])
        except (KeyError, IndexError, ValueError) as exc:
            raise OandaError(f"Malformed price payload for {name}") from exc
        ts = parse_oanda_time(p["time"])
        now = datetime.now(timezone.utc)
        inst = classify(symbol, provider_hint="oanda")
        tradeable = bool(p.get("tradeable", True))
        return NormalizedQuote(
            provider=self.name, symbol=inst.symbol if inst.symbol else name, normalized_symbol=name,
            asset_class=inst.asset_class.value, price=(bid + ask) / 2.0, bid=bid, ask=ask, volume=None,
            ts_provider=ts, ts_utc=ts, retrieved_at=now, data_status="fresh" if tradeable else "market_closed",
            exchange="OANDA", quote_currency=inst.quote,
            meta={"source": "pricing", "venue_symbol": name, "tradeable": tradeable, "status": p.get("status")},
        )

    async def get_candles(self, symbol: str, interval: str = "1h", limit: int = 100) -> list[dict[str, Any]]:
        """Completed mid-price candles in the same shape as the Binance kline rows ETI already consumes."""
        gran = GRANULARITY.get(interval)
        if not gran:
            raise OandaError(f"Unsupported interval {interval!r}; use one of {sorted(GRANULARITY)}")
        name = await self.resolve(symbol)
        data = await self._request("GET", f"/v3/instruments/{name}/candles",
                                   params={"granularity": gran, "count": max(1, min(int(limit), 5000)), "price": "M"})
        step_ms = GRANULARITY_SECONDS[gran] * 1000
        out = []
        for c in data.get("candles", []):
            if not c.get("complete", True) or "mid" not in c:   # drop the forming candle: partial bars distort indicators
                continue
            open_ms = int(parse_oanda_time(c["time"]).timestamp() * 1000)
            m = c["mid"]
            out.append({"open_time": open_ms, "open": float(m["o"]), "high": float(m["h"]), "low": float(m["l"]),
                        "close": float(m["c"]), "volume": float(c.get("volume", 0)), "close_time": open_ms + step_ms - 1})
        return out

    # ---------------------------------------------------------------- orders
    async def submit_order(self, symbol: str, qty: float, side: str, order_type: str = "market",
                           limit_price: Optional[float] = None, client_order_id: Optional[str] = None) -> dict[str, Any]:
        """Submit a market (FOK) or limit (good-for-day) order. Raises if OANDA rejects or cancels it."""
        side, order_type = side.lower(), order_type.lower()
        if side not in ("buy", "sell"):
            raise OandaError("side must be buy or sell")
        if order_type not in ("market", "limit"):
            raise OandaError("OANDA adapter supports market and limit orders only")
        if order_type == "limit" and (limit_price is None or limit_price <= 0):
            raise OandaError("limit orders require a positive limit_price")
        name = await self.resolve(symbol)
        meta = (await self.instruments()).get(name, {})
        unit_places = int(meta.get("tradeUnitsPrecision", 0))
        price_places = int(meta.get("displayPrecision", 5))
        units = Decimal(_fmt(qty, unit_places))
        min_units = Decimal(str(meta.get("minimumTradeSize", "1")))
        if units < min_units:
            raise OandaError(f"Quantity {qty} rounds to {units} units, below {name} minimum trade size {min_units}")
        max_units = Decimal(str(meta.get("maximumOrderUnits", "0")))
        if max_units > 0 and units > max_units:
            raise OandaError(f"Quantity {units} exceeds {name} maximum order size {max_units}")
        order: dict[str, Any] = {
            "type": "MARKET" if order_type == "market" else "LIMIT", "instrument": name,
            "units": format(units if side == "buy" else -units, "f"),
            "timeInForce": "FOK" if order_type == "market" else "GFD", "positionFill": "DEFAULT",
        }
        if order_type == "limit":
            order["price"] = _fmt(float(limit_price), price_places)
        if client_order_id:
            order["clientExtensions"] = {"id": client_order_id[:128], "tag": "eti"}
        resp = await self._request("POST", f"/v3/accounts/{self.account_id}/orders", json={"order": order})

        fill = resp.get("orderFillTransaction")
        cancel = resp.get("orderCancelTransaction")
        if cancel and not fill:
            raise OandaError(f"OANDA canceled the order: {cancel.get('reason', 'unknown reason')}")
        reject = resp.get("orderRejectTransaction")
        if reject:
            raise OandaError(f"OANDA rejected the order: {reject.get('rejectReason', 'unknown reason')}")
        created = resp.get("orderCreateTransaction") or {}
        fill_price = float(fill["price"]) if fill and fill.get("price") is not None else None
        order_id = (fill or {}).get("orderID") or created.get("id")
        return {**resp, "id": order_id, "fill_price": fill_price, "venue_symbol": name,
                "filled": fill is not None, "environment": "practice" if self.use_practice else "live"}

    async def get_order_status(self, client_order_id: str) -> Optional[dict[str, Any]]:
        """Normalised status for reconciliation, looked up by the client order id ('@id' specifier)."""
        try:
            data = await self._request("GET", f"/v3/accounts/{self.account_id}/orders/@{client_order_id}")
        except OandaError as exc:
            if "404" in str(exc):
                return None
            raise
        order = data.get("order") or {}
        state = str(order.get("state", "")).upper()
        status = _ORDER_STATUS.get(state, state.lower() or None)
        fill_price = None
        fill_id = order.get("fillingTransactionID")
        if state == "FILLED" and fill_id:
            tx = (await self._request("GET", f"/v3/accounts/{self.account_id}/transactions/{fill_id}")).get("transaction") or {}
            if tx.get("price") is not None:
                fill_price = float(tx["price"])
        return {"status": status, "fill_price": fill_price, "provider_order_id": order.get("id")}

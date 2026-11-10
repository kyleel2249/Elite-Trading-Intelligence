"""Binance integration — public market data + testnet/live trading paths."""
from __future__ import annotations

import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote
from app.quant.binance_exits import (base_qty_after_fees, build_oco_params, parse_symbol_filters,
                                     plan_exit_oco)


class BinanceClient(BaseProvider):
    name = "binance"

    def __init__(self, settings: Optional[Settings] = None, use_testnet: Optional[bool] = None):
        self.settings = settings or get_settings()
        self.api_key = self.settings.binance_api_key
        self.secret_key = self.settings.binance_secret_key
        self.use_testnet = (
            use_testnet if use_testnet is not None else self.settings.binance_testnet_enabled
        )
        if self.use_testnet:
            self.base_url = "https://testnet.binance.vision"
        else:
            self.base_url = "https://api.binance.com"

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.secret_key)

    def _sign(self, params: dict[str, Any]) -> str:
        query = urlencode(params)
        return hmac.new(
            (self.secret_key or "").encode("utf-8"),
            query.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _headers(self) -> dict[str, str]:
        return {"X-MBX-APIKEY": self.api_key or ""}

    async def health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(f"{self.base_url}/api/v3/ping")
                public_ok = r.status_code == 200
                account_status = "not_configured"
                if self.configured:
                    try:
                        await self.get_account()
                        account_status = "connected"
                    except Exception as e:
                        account_status = f"error: {e}"
                return {
                    "provider": self.name,
                    "status": "connected" if public_ok else "error",
                    "testnet": self.use_testnet,
                    "public_api": public_ok,
                    "account": account_status,
                    "base_url": self.base_url,
                }
        except Exception as e:
            return {
                "provider": self.name,
                "status": "error",
                "testnet": self.use_testnet,
                "error": str(e),
            }

    async def get_ticker_price(self, symbol: str) -> float:
        symbol = symbol.upper()
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{self.base_url}/api/v3/ticker/price",
                params={"symbol": symbol},
            )
            r.raise_for_status()
            return float(r.json()["price"])

    async def get_quote(self, symbol: str) -> NormalizedQuote:
        symbol = symbol.upper()
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{self.base_url}/api/v3/ticker/bookTicker",
                params={"symbol": symbol},
            )
            r.raise_for_status()
            data = r.json()
            bid = float(data["bidPrice"])
            ask = float(data["askPrice"])
            mid = (bid + ask) / 2.0
            now = datetime.now(timezone.utc)
            return NormalizedQuote(
                provider=self.name,
                symbol=symbol,
                normalized_symbol=symbol,
                asset_class="crypto",
                price=mid,
                bid=bid,
                ask=ask,
                volume=None,
                ts_provider=now,
                ts_utc=now,
                retrieved_at=now,
                data_status="fresh",
                exchange="BINANCE",
                quote_currency=symbol[-4:] if symbol.endswith("USDT") else None,
                meta={"source": "bookTicker", "bid_qty": data.get("bidQty"), "ask_qty": data.get("askQty")},
            )

    async def get_klines(
        self,
        symbol: str,
        interval: str = "1h",
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        symbol = symbol.upper()
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"{self.base_url}/api/v3/klines",
                params={"symbol": symbol, "interval": interval, "limit": limit},
            )
            r.raise_for_status()
            rows = r.json()
            out = []
            for k in rows:
                out.append(
                    {
                        "open_time": k[0],
                        "open": float(k[1]),
                        "high": float(k[2]),
                        "low": float(k[3]),
                        "close": float(k[4]),
                        "volume": float(k[5]),
                        "close_time": k[6],
                    }
                )
            return out

    async def get_order_book_raw(self, symbol: str, limit: int = 20) -> dict[str, Any]:
        symbol = symbol.upper()
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(
                f"{self.base_url}/api/v3/depth",
                params={"symbol": symbol, "limit": limit},
            )
            r.raise_for_status()
            return r.json()

    async def get_account(self) -> dict[str, Any]:
        if not self.configured:
            raise RuntimeError("Binance not configured")
        params = {"timestamp": int(time.time() * 1000)}
        params["signature"] = self._sign(params)
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                f"{self.base_url}/api/v3/account",
                params=params,
                headers=self._headers(),
            )
            r.raise_for_status()
            return r.json()

    async def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str = "MARKET",
        client_order_id: Optional[str] = None,
        limit_price: Optional[float] = None,
        time_in_force: str = "GTC",
    ) -> dict[str, Any]:
        if not self.configured:
            raise RuntimeError("Binance not configured")
        params: dict[str, Any] = {
            "symbol": symbol.upper(),
            "side": side.upper(),
            "type": order_type.upper(),
            "quantity": f"{qty:.8f}".rstrip("0").rstrip("."),
            "timestamp": int(time.time() * 1000),
        }
        if order_type.upper() == "LIMIT":
            if limit_price is None:
                raise ValueError("LIMIT orders require limit_price")
            params["price"] = f"{limit_price:.8f}".rstrip("0").rstrip(".")
            params["timeInForce"] = time_in_force
        if client_order_id:
            params["newClientOrderId"] = client_order_id
        params["signature"] = self._sign(params)
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                f"{self.base_url}/api/v3/order",
                params=params,
                headers=self._headers(),
            )
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Binance order failed: {r.status_code} {r.text[:400]}")
            return r.json()

    async def get_symbol_filters(self, symbol: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(f"{self.base_url}/api/v3/exchangeInfo", params={"symbol": symbol.upper()})
            r.raise_for_status()
            return parse_symbol_filters(r.json())

    async def place_exit_oco(
        self,
        symbol: str,
        executed_qty: float,
        fills: Optional[list[dict[str, Any]]],
        take_profit: float,
        stop_price: float,
        list_client_order_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Place a SELL OCO (take-profit + stop-loss-limit) protecting a filled long.

        Quantity is the filled amount net of base-asset commission, rounded down to the LOT_SIZE step.
        Raises ValueError for a plan Binance would reject (prices vs last, dust, min notional) instead
        of sending a doomed request.
        """
        if not self.configured:
            raise RuntimeError("Binance not configured")
        filt = await self.get_symbol_filters(symbol)
        last = await self.get_ticker_price(symbol)
        qty = base_qty_after_fees(executed_qty, fills, filt["base_asset"])
        plan = plan_exit_oco(
            qty=qty, take_profit=take_profit, stop_price=stop_price, last_price=last,
            tick_size=filt["tick_size"], step_size=filt["step_size"], min_qty=filt["min_qty"],
            min_notional=filt["min_notional"],
        )
        params = build_oco_params(symbol, plan, int(time.time() * 1000), list_client_order_id)
        params["signature"] = self._sign(params)
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                f"{self.base_url}/api/v3/orderList/oco",
                params=params,
                headers=self._headers(),
            )
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Binance OCO failed: {r.status_code} {r.text[:400]}")
            return r.json()

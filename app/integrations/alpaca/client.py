"""Alpaca integration — paper by default, live path available when configured and risk-approved."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote


def _px(v: float) -> str:
    """Alpaca price increments: 2 decimals at/above $1, 4 below."""
    return str(round(v, 2) if v >= 1 else round(v, 4))


def build_order_body(
    symbol: str,
    qty: float,
    side: str,
    order_type: str = "market",
    time_in_force: str = "day",
    limit_price: Optional[float] = None,
    client_order_id: Optional[str] = None,
    stop_loss: Optional[float] = None,
    take_profit: Optional[float] = None,
) -> dict[str, Any]:
    """Build the Alpaca order payload. Both exits => bracket; one exit => OTO (one-triggers-other).

    Alpaca does not accept fractional quantities on bracket/OTO orders, so those are rejected here
    rather than silently submitted without protection.
    """
    body: dict[str, Any] = {
        "symbol": symbol.upper(),
        "qty": str(qty),
        "side": side.lower(),
        "type": order_type.lower(),
        "time_in_force": time_in_force,
    }
    if limit_price is not None:
        body["limit_price"] = str(limit_price)
    if client_order_id:
        body["client_order_id"] = client_order_id
    if stop_loss is not None or take_profit is not None:
        if float(qty) != int(float(qty)):
            raise ValueError("Alpaca bracket/OTO orders require whole-share quantities")
        body["qty"] = str(int(float(qty)))
        body["order_class"] = "bracket" if (stop_loss is not None and take_profit is not None) else "oto"
        if take_profit is not None:
            body["take_profit"] = {"limit_price": _px(take_profit)}
        if stop_loss is not None:
            body["stop_loss"] = {"stop_price": _px(stop_loss)}
    return body


def protective_status(resp: dict[str, Any], stop_loss: Optional[float], take_profit: Optional[float]) -> dict[str, Any]:
    """Report protection only when Alpaca's response actually contains the exit legs."""
    if stop_loss is None and take_profit is None:
        return {"status": "not_requested"}
    legs = resp.get("legs") or []
    if legs:
        return {"status": "attached", "method": f"alpaca_{resp.get('order_class') or 'bracket'}",
                "legs": [{"id": leg.get("id"), "type": leg.get("type"), "status": leg.get("status")} for leg in legs]}
    return {"status": "requested_unconfirmed", "reason": "provider response contained no exit legs"}


class AlpacaClient(BaseProvider):
    name = "alpaca"

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.api_key = self.settings.alpaca_api_key
        self.secret_key = self.settings.alpaca_secret_key
        self.paper = self.settings.alpaca_paper
        self.base_url = self.settings.alpaca_base_url.rstrip("/")
        # Data API is separate
        self.data_url = "https://data.alpaca.markets"

    def _headers(self) -> dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.api_key or "",
            "APCA-API-SECRET-KEY": self.secret_key or "",
        }

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.secret_key)

    async def health(self) -> dict[str, Any]:
        if not self.configured:
            return {
                "provider": self.name,
                "status": "not_configured",
                "paper": self.paper,
                "message": "ALPACA_API_KEY / ALPACA_SECRET_KEY missing",
            }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(f"{self.base_url}/v2/account", headers=self._headers())
                if r.status_code == 200:
                    data = r.json()
                    return {
                        "provider": self.name,
                        "status": "connected",
                        "paper": self.paper,
                        "account_status": data.get("status"),
                        "currency": data.get("currency"),
                        "buying_power": data.get("buying_power"),
                        "equity": data.get("equity"),
                        "trading_blocked": data.get("trading_blocked"),
                    }
                return {
                    "provider": self.name,
                    "status": "error",
                    "paper": self.paper,
                    "http_status": r.status_code,
                    "detail": r.text[:300],
                }
        except Exception as e:
            return {
                "provider": self.name,
                "status": "error",
                "paper": self.paper,
                "error": str(e),
            }

    async def get_account(self) -> dict[str, Any]:
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{self.base_url}/v2/account", headers=self._headers())
            r.raise_for_status()
            return r.json()

    async def get_quote(self, symbol: str) -> NormalizedQuote:
        """Latest trade / quote via data API (requires data entitlement)."""
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
        symbol = symbol.upper()
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Latest trade
            r = await client.get(
                f"{self.data_url}/v2/stocks/{symbol}/trades/latest",
                headers=self._headers(),
            )
            if r.status_code != 200:
                raise RuntimeError(f"Alpaca quote failed: {r.status_code} {r.text[:200]}")
            payload = r.json()
            trade = payload.get("trade") or {}
            price = float(trade.get("p") or 0)
            ts_raw = trade.get("t")
            ts_utc = datetime.now(timezone.utc)
            if ts_raw:
                try:
                    ts_utc = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).astimezone(timezone.utc)
                except Exception:
                    pass
            now = datetime.now(timezone.utc)
            age = (now - ts_utc).total_seconds()
            status = "fresh" if age <= 60 else ("delayed" if age <= 300 else "stale")
            return NormalizedQuote(
                provider=self.name,
                symbol=symbol,
                normalized_symbol=symbol,
                asset_class="equity",
                price=price,
                bid=None,
                ask=None,
                volume=None,
                ts_provider=ts_utc,
                ts_utc=ts_utc,
                retrieved_at=now,
                data_status=status,
                exchange="ALPACA",
                quote_currency="USD",
                meta={"source": "trades/latest"},
            )

    async def submit_order(
        self,
        symbol: str,
        qty: float,
        side: str,
        order_type: str = "market",
        time_in_force: str = "day",
        limit_price: Optional[float] = None,
        client_order_id: Optional[str] = None,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
    ) -> dict[str, Any]:
        """Submit order to the configured Alpaca environment (paper or live).

        Optional ``stop_loss`` / ``take_profit`` attach exit legs (bracket, or OTO when only one is given).
        """
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
        body = build_order_body(symbol, qty, side, order_type, time_in_force, limit_price,
                                client_order_id, stop_loss, take_profit)
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                f"{self.base_url}/v2/orders",
                headers=self._headers(),
                json=body,
            )
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Alpaca order failed: {r.status_code} {r.text[:400]}")
            return r.json()

"""Alpaca integration — paper by default, live path available when configured and risk-approved."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote


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
            timestamp_valid = False
            if ts_raw:
                try:
                    parsed = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
                    if parsed.tzinfo is not None:
                        ts_utc = parsed.astimezone(timezone.utc)
                        timestamp_valid = True
                except Exception:
                    pass
            now = datetime.now(timezone.utc)
            age = (now - ts_utc).total_seconds()
            status = "fresh" if 0 <= age <= 60 else ("delayed" if 60 < age <= 300 else "stale")
            if not timestamp_valid or age < 0:
                status = "invalid"
            return NormalizedQuote(
                provider=self.name,
                symbol=symbol,
                normalized_symbol=symbol,
                asset_class="equity",
                price=price,
                bid=None,
                ask=None,
                volume=None,
                ts_provider=ts_utc if timestamp_valid else None,
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
    ) -> dict[str, Any]:
        """Submit order to the configured Alpaca environment (paper or live)."""
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
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
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                f"{self.base_url}/v2/orders",
                headers=self._headers(),
                json=body,
            )
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Alpaca order failed: {r.status_code} {r.text[:400]}")
            return r.json()
"""Alpaca integration — paper by default, live path available when configured and risk-approved."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.base import BaseProvider, NormalizedQuote


class AlpacaClient(BaseProvider):
    name = "alpaca"

    def __init__(self, settings: Optional[Settings] = None, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.settings = settings or get_settings()
        self._transport = transport          # injectable for tests; None in production
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
            async with httpx.AsyncClient(timeout=10.0, transport=self._transport) as client:
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
        async with httpx.AsyncClient(timeout=15.0, transport=self._transport) as client:
            r = await client.get(f"{self.base_url}/v2/account", headers=self._headers())
            r.raise_for_status()
            return r.json()

    async def get_quote(self, symbol: str) -> NormalizedQuote:
        """Latest trade / quote via data API (requires data entitlement)."""
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
        symbol = symbol.upper()
        async with httpx.AsyncClient(timeout=15.0, transport=self._transport) as client:
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
            bid = ask = None
            try:                                   # best bid/offer enables a measured spread; absence is tolerated
                rq = await client.get(f"{self.data_url}/v2/stocks/{symbol}/quotes/latest", headers=self._headers())
                if rq.status_code == 200:
                    qt = rq.json().get("quote") or {}
                    b, a = float(qt.get("bp") or 0), float(qt.get("ap") or 0)
                    if b > 0 and a >= b:
                        bid, ask = b, a
            except Exception:
                pass
            return NormalizedQuote(
                provider=self.name,
                symbol=symbol,
                normalized_symbol=symbol,
                asset_class="equity",
                price=price,
                bid=bid,
                ask=ask,
                volume=None,
                ts_provider=ts_utc,
                ts_utc=ts_utc,
                retrieved_at=now,
                data_status=status,
                exchange="ALPACA",
                quote_currency="USD",
                meta={"source": "trades/latest"},
            )

    _TF = {"1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day"}
    _TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}

    async def get_bars(self, symbol: str, interval: str = "1d", limit: int = 30) -> list[dict[str, Any]]:
        """Split/dividend-unadjusted bars in the shared kline shape. Free plans serve the IEX feed (partial volume)."""
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
        if interval not in self._TF:
            raise RuntimeError(f"Unsupported interval {interval!r}")
        # request a generous calendar window; the API returns only trading bars
        start = datetime.now(timezone.utc) - timedelta(seconds=self._TF_SECONDS[interval] * max(limit, 1) * (3 if interval == "1d" else 8))
        async with httpx.AsyncClient(timeout=15.0, transport=self._transport) as client:
            r = await client.get(f"{self.data_url}/v2/stocks/{symbol.upper()}/bars", headers=self._headers(),
                                 params={"timeframe": self._TF[interval], "limit": 10000, "adjustment": "raw",
                                         "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "feed": "iex"})
        if r.status_code != 200:
            raise RuntimeError(f"Alpaca bars failed: {r.status_code} {r.text[:200]}")
        out = []
        step = self._TF_SECONDS[interval] * 1000
        for b in (r.json().get("bars") or [])[-limit:]:
            t = int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp() * 1000)
            out.append({"open_time": t, "open": float(b["o"]), "high": float(b["h"]), "low": float(b["l"]),
                        "close": float(b["c"]), "volume": float(b.get("v") or 0), "close_time": t + step - 1})
        return out

    async def get_option_quote(self, occ_symbol: str) -> NormalizedQuote:
        """Latest option quote from the options snapshot endpoint.

        UNVERIFIED against a live account: parsed per Alpaca's documented snapshot shape
        (latestQuote bp/ap, latestTrade p, t). Needs an options-enabled account/data entitlement.
        """
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
        sym = occ_symbol.upper().replace(" ", "")
        async with httpx.AsyncClient(timeout=15.0, transport=self._transport) as client:
            r = await client.get(f"{self.data_url}/v1beta1/options/snapshots", headers=self._headers(), params={"symbols": sym})
        if r.status_code != 200:
            raise RuntimeError(f"Alpaca option quote failed: {r.status_code} {r.text[:200]}")
        snap = (r.json().get("snapshots") or {}).get(sym)
        if not snap:
            raise RuntimeError(f"No option snapshot for {sym}")
        q, t = snap.get("latestQuote") or {}, snap.get("latestTrade") or {}
        bid, ask = float(q.get("bp") or 0) or None, float(q.get("ap") or 0) or None
        mid = (bid + ask) / 2 if bid and ask and ask >= bid else None
        price = mid or float(t.get("p") or 0)
        if not price:
            raise RuntimeError(f"Option snapshot for {sym} has no usable price")
        ts_raw = q.get("t") or t.get("t")
        now = datetime.now(timezone.utc)
        ts = now
        if ts_raw:
            try:
                ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).astimezone(timezone.utc)
            except Exception:
                pass
        age = (now - ts).total_seconds()
        return NormalizedQuote(provider=self.name, symbol=sym, normalized_symbol=sym, asset_class="option", price=price, bid=bid, ask=ask,
                               volume=None, ts_provider=ts, ts_utc=ts, retrieved_at=now,
                               data_status="fresh" if age <= 60 else ("delayed" if age <= 300 else "stale"),
                               exchange="OPRA", quote_currency="USD", meta={"source": "options/snapshots", "unverified_live": True})

    async def submit_order(
        self,
        symbol: str,
        qty: float,
        side: str,
        order_type: str = "market",
        time_in_force: str = "day",
        limit_price: Optional[float] = None,
        client_order_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Submit order to the configured Alpaca environment (paper or live)."""
        if not self.configured:
            raise RuntimeError("Alpaca not configured")
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
        async with httpx.AsyncClient(timeout=20.0, transport=self._transport) as client:
            r = await client.post(
                f"{self.base_url}/v2/orders",
                headers=self._headers(),
                json=body,
            )
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Alpaca order failed: {r.status_code} {r.text[:400]}")
            return r.json()

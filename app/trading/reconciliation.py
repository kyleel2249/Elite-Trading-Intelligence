"""Idempotent order status reconciliation against providers."""
from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.integrations.oanda import OandaClient
from app.models import OrderRecord
from app.trading.portfolio import PortfolioService

logger = logging.getLogger(__name__)


class OrderReconciler:
    """
    Omar Diallo / Claire Bennett — reconcile local order records with provider state.
    Idempotent: safe to re-run; only advances status forward.
    """

    TERMINAL = {"filled", "canceled", "cancelled", "rejected", "expired"}

    def __init__(self, db: Session, settings: Optional[Settings] = None):
        self.db = db
        self.settings = settings or get_settings()
        self.alpaca = AlpacaClient(self.settings)
        self.binance = BinanceClient(self.settings)
        self.oanda = OandaClient(self.settings)

    async def reconcile_open(self, limit: int = 50) -> dict[str, Any]:
        rows = (
            self.db.query(OrderRecord)
            .filter(OrderRecord.status.in_(["submitted", "pending", "partial", "new"]))
            .order_by(OrderRecord.created_at.desc())
            .limit(limit)
            .all()
        )
        updated = []
        errors = []
        for row in rows:
            try:
                remote = await self._fetch_status(row)
                if not remote:
                    continue
                new_status = remote.get("status")
                fill_price = remote.get("fill_price")
                if new_status and new_status != row.status:
                    # Only advance
                    row.status = new_status
                    if fill_price is not None:
                        row.fill_price = fill_price
                    if remote.get("provider_order_id"):
                        row.provider_order_id = str(remote["provider_order_id"])
                    self.db.add(row)
                    if new_status == "filled" and fill_price is not None and row.risk_approved:
                        PortfolioService(self.db).record_order_event(
                            client_order_id=row.client_order_id,
                            provider=row.provider,
                            environment=row.environment,
                            symbol=row.symbol,
                            side=row.side,
                            qty=row.qty,
                            status="filled",
                            fill_price=fill_price,
                            risk_approved=True,
                            risk_notes=row.risk_notes or "",
                            thesis="Reconciled fill",
                            provider_order_id=row.provider_order_id,
                        )
                    updated.append(row.client_order_id)
            except Exception as e:
                errors.append({"client_order_id": row.client_order_id, "error": str(e)})
                logger.warning("Reconcile failed %s: %s", row.client_order_id, e)
        self.db.commit()
        return {
            "checked": len(rows),
            "updated": updated,
            "errors": errors,
            "analyst": "Omar Diallo",
            "auditor": "Claire Bennett",
        }

    async def _fetch_status(self, row: OrderRecord) -> Optional[dict[str, Any]]:
        if row.provider == "alpaca" and self.alpaca.configured:
            return await self._alpaca_status(row)
        if row.provider == "binance" and self.binance.configured:
            return await self._binance_status(row)
        if row.provider == "oanda" and self.oanda.configured:
            client = OandaClient(self.settings, use_practice=(row.environment or "paper").lower() != "live")
            return await client.get_order_status(row.client_order_id)
        return None

    async def _alpaca_status(self, row: OrderRecord) -> Optional[dict[str, Any]]:
        import httpx

        order_id = row.provider_order_id or row.client_order_id
        url = f"{self.alpaca.base_url}/v2/orders/{order_id}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, headers=self.alpaca._headers())
            if r.status_code == 404:
                # try by client order id
                r = await client.get(
                    f"{self.alpaca.base_url}/v2/orders:by_client_order_id",
                    params={"client_order_id": row.client_order_id},
                    headers=self.alpaca._headers(),
                )
            if r.status_code != 200:
                return None
            data = r.json()
            status = (data.get("status") or "").lower()
            mapped = {
                "new": "submitted",
                "accepted": "submitted",
                "pending_new": "pending",
                "partially_filled": "partial",
                "filled": "filled",
                "canceled": "canceled",
                "cancelled": "canceled",
                "expired": "expired",
                "rejected": "rejected",
            }.get(status, status)
            fill = data.get("filled_avg_price")
            return {
                "status": mapped,
                "fill_price": float(fill) if fill else None,
                "provider_order_id": data.get("id"),
            }

    async def _binance_status(self, row: OrderRecord) -> Optional[dict[str, Any]]:
        import hashlib
        import hmac
        import time
        from urllib.parse import urlencode

        import httpx

        client = BinanceClient(self.settings, use_testnet=row.environment in ("paper", "testnet"))
        params: dict[str, Any] = {
            "symbol": row.symbol.upper(),
            "timestamp": int(time.time() * 1000),
        }
        if row.provider_order_id:
            params["orderId"] = row.provider_order_id
        else:
            params["origClientOrderId"] = row.client_order_id
        query = urlencode(params)
        sig = hmac.new(
            (client.secret_key or "").encode(),
            query.encode(),
            hashlib.sha256,
        ).hexdigest()
        params["signature"] = sig
        async with httpx.AsyncClient(timeout=15.0) as http:
            r = await http.get(
                f"{client.base_url}/api/v3/order",
                params=params,
                headers=client._headers(),
            )
            if r.status_code != 200:
                return None
            data = r.json()
            status = (data.get("status") or "").upper()
            mapped = {
                "NEW": "submitted",
                "PARTIALLY_FILLED": "partial",
                "FILLED": "filled",
                "CANCELED": "canceled",
                "REJECTED": "rejected",
                "EXPIRED": "expired",
            }.get(status, status.lower())
            fill = data.get("avgPrice") or data.get("price")
            try:
                fill_f = float(fill) if fill and float(fill) > 0 else None
            except Exception:
                fill_f = None
            return {
                "status": mapped,
                "fill_price": fill_f,
                "provider_order_id": str(data.get("orderId") or ""),
            }

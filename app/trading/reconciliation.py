"""Idempotent order status reconciliation against providers."""
from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.models import OrderRecord
from app.trading.portfolio import PortfolioService
from app.trading.executions import normalize_execution

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
                # Account cumulative executions even when status did not change,
                # and before terminalizing canceled/expired orders.
                PortfolioService(self.db).record_order_event(
                    client_order_id=row.client_order_id, provider=row.provider,
                    environment=row.environment, symbol=row.symbol, side=row.side,
                    qty=row.qty, status=remote["status"],
                    filled_qty=remote.get("filled_qty"), fill_price=remote.get("fill_price"),
                    risk_approved=row.risk_approved, risk_notes=row.risk_notes or "",
                    thesis="Reconciled execution", provider_order_id=remote.get("provider_order_id"),
                )
                updated.append(row.client_order_id)
            except Exception as e:
                self.db.rollback()
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
            return normalize_execution("alpaca", data)

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
            return normalize_execution("binance", data)
"""Idempotent order status reconciliation against providers."""
"""
Trading service — single entry point for paper and live orders.
Every order must pass RiskEngine before any provider submission.
Paper fills update portfolio + journal (Claire Bennett audit trail).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.risk.engine import RiskEngine, OrderProposal, RiskDecision
from app.trading.portfolio import PortfolioService

_LONG = ("buy", "long")
_SHORT = ("sell", "short")


class TradingService:
    def __init__(self, settings: Optional[Settings] = None, db: Optional[Session] = None):
        self.settings = settings or get_settings()
        self.risk = RiskEngine(self.settings)
        self.alpaca = AlpacaClient(self.settings)
        self.binance = BinanceClient(self.settings)
        self.db = db

    def _client_order_id(self) -> str:
        return f"eti-{uuid.uuid4().hex[:20]}"

    def _reduces_exposure(self, provider: str, environment: str, symbol: str, side: str, qty: float) -> bool:
        """True only when the order closes (part of) an existing opposite position.

        Closing orders are never blocked by the single-position allocation cap; anything that
        opens or adds exposure is. Fails closed (False) when the position cannot be determined.
        """
        if self.db is None:
            return False
        try:
            from app.models import Position
            rows = (
                self.db.query(Position)
                .filter(Position.provider == provider.lower(), Position.environment == environment.lower(),
                        Position.symbol == symbol.upper(), Position.status == "open")
                .all()
            )
        except Exception:
            return False
        side = side.lower()
        for p in rows:
            held = (p.side or "").lower()
            opposite = (side in _SHORT and held in _LONG) or (side in _LONG and held in _SHORT)
            if opposite and (p.qty or 0.0) + 1e-12 >= qty:
                return True
        return False

    async def place_order(
        self,
        *,
        provider: str,
        environment: str,
        symbol: str,
        side: str,
        qty: float,
        order_type: str = "market",
        limit_price: Optional[float] = None,
        equity: float,
        current_open_positions: int = 0,
        daily_realized_pnl_pct: float = 0.0,
        current_drawdown_pct: float = 0.0,
        data_age_seconds: Optional[float] = None,
        data_status: str = "unknown",
        estimated_risk_amount: Optional[float] = None,
        fill_price_hint: Optional[float] = None,
        thesis: Optional[str] = None,
        council_action: Optional[str] = None,
    ) -> dict[str, Any]:
        client_order_id = self._client_order_id()
        proposal = OrderProposal(
            provider=provider.lower(),
            environment=environment.lower(),
            symbol=symbol.upper(),
            side=side.lower(),
            qty=qty,
            order_type=order_type.lower(),
            limit_price=limit_price,
            client_order_id=client_order_id,
            equity=equity,
            current_open_positions=current_open_positions,
            daily_realized_pnl_pct=daily_realized_pnl_pct,
            current_drawdown_pct=current_drawdown_pct,
            estimated_risk_amount=estimated_risk_amount,
            data_age_seconds=data_age_seconds,
            data_status=data_status,
            # Server-side valuation of the order for the 6% position allocation cap.
            reference_price=limit_price if limit_price is not None else fill_price_hint,
            reduces_exposure=self._reduces_exposure(provider, environment, symbol, side, qty),
        )

        decision: RiskDecision = self.risk.evaluate(proposal)
        if not decision.approved:
            result = {
                "status": "rejected",
                "client_order_id": client_order_id,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                    "officer": "Helena Frost",
                },
                "provider_response": None,
            }
            if self.db is not None:
                PortfolioService(self.db).record_order_event(
                    client_order_id=client_order_id,
                    provider=provider,
                    environment=environment,
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    status="rejected",
                    risk_approved=False,
                    risk_notes=decision.notes,
                    thesis=thesis,
                    council_action=council_action,
                )
            return result

        try:
            if provider.lower() == "alpaca":
                if environment.lower() == "paper" and not self.settings.alpaca_paper:
                    return {
                        "status": "rejected",
                        "client_order_id": client_order_id,
                        "risk": {
                            "decision": "REJECTED",
                            "reasons": ["Alpaca live credentials configured but paper environment requested"],
                            "notes": "Mismatch between environment and ALPACA_PAPER",
                            "officer": "Helena Frost",
                        },
                        "provider_response": None,
                    }
                resp = await self.alpaca.submit_order(
                    symbol=symbol,
                    qty=qty,
                    side=side,
                    order_type=order_type,
                    limit_price=limit_price,
                    client_order_id=client_order_id,
                )
                fill_price = fill_price_hint
            elif provider.lower() == "binance":
                use_testnet = environment.lower() in ("paper", "testnet")
                # Paper without keys: simulate fill for journal/positions
                if use_testnet and not self.binance.configured and fill_price_hint is not None:
                    resp = {
                        "simulated": True,
                        "symbol": symbol.upper(),
                        "side": side.upper(),
                        "executedQty": str(qty),
                        "status": "FILLED",
                    }
                    fill_price = fill_price_hint
                else:
                    client = BinanceClient(self.settings, use_testnet=use_testnet)
                    resp = await client.submit_order(
                        symbol=symbol,
                        side=side,
                        qty=qty,
                        order_type=order_type.upper(),
                        client_order_id=client_order_id,
                    )
                    fill_price = fill_price_hint
            else:
                return {
                    "status": "rejected",
                    "client_order_id": client_order_id,
                    "risk": {
                        "decision": "REJECTED",
                        "reasons": [f"Unknown provider: {provider}"],
                        "notes": "",
                        "officer": "Helena Frost",
                    },
                    "provider_response": None,
                }

            result = {
                "status": "submitted",
                "client_order_id": client_order_id,
                "environment": environment,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                    "officer": "Helena Frost",
                },
                "provider_response": resp,
                "submitted_at": datetime.now(timezone.utc).isoformat(),
            }

            if self.db is not None:
                # For paper/sim: treat as filled when we have a price hint
                status = "filled" if fill_price is not None and environment.lower() in ("paper", "testnet") else "submitted"
                PortfolioService(self.db).record_order_event(
                    client_order_id=client_order_id,
                    provider=provider,
                    environment=environment,
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    status=status,
                    fill_price=fill_price,
                    risk_approved=True,
                    risk_notes=decision.notes,
                    thesis=thesis,
                    council_action=council_action,
                    provider_order_id=str(resp.get("orderId") or resp.get("id") or "") or None,
                )

            return result
        except Exception as e:
            return {
                "status": "error",
                "client_order_id": client_order_id,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                    "officer": "Helena Frost",
                },
                "error": str(e),
                "provider_response": None,
            }

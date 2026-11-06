"""
Trading service — single entry point for paper and live orders.
Every order must pass RiskEngine before any provider submission.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.risk.engine import RiskEngine, OrderProposal, RiskDecision


class TradingService:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.risk = RiskEngine(self.settings)
        self.alpaca = AlpacaClient(self.settings)
        self.binance = BinanceClient(self.settings)

    def _client_order_id(self) -> str:
        return f"eti-{uuid.uuid4().hex[:20]}"

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
    ) -> dict[str, Any]:
        """
        Risk-gated order placement.

        environment: paper | testnet | live
        """
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
        )

        decision: RiskDecision = self.risk.evaluate(proposal)
        if not decision.approved:
            return {
                "status": "rejected",
                "client_order_id": client_order_id,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                },
                "provider_response": None,
            }

        # Submit only after risk approval
        try:
            if provider.lower() == "alpaca":
                # Force paper client when environment is paper
                if environment.lower() == "paper" and not self.settings.alpaca_paper:
                    # Safety: do not accidentally hit live Alpaca when caller asked for paper
                    return {
                        "status": "rejected",
                        "client_order_id": client_order_id,
                        "risk": {
                            "decision": "REJECTED",
                            "reasons": ["Alpaca live credentials configured but paper environment requested"],
                            "notes": "Mismatch between environment and ALPACA_PAPER",
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
            elif provider.lower() == "binance":
                use_testnet = environment.lower() in ("paper", "testnet")
                client = BinanceClient(self.settings, use_testnet=use_testnet)
                resp = await client.submit_order(
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    order_type=order_type.upper(),
                    client_order_id=client_order_id,
                )
            else:
                return {
                    "status": "rejected",
                    "client_order_id": client_order_id,
                    "risk": {
                        "decision": "REJECTED",
                        "reasons": [f"Unknown provider: {provider}"],
                        "notes": "",
                    },
                    "provider_response": None,
                }

            return {
                "status": "submitted",
                "client_order_id": client_order_id,
                "environment": environment,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                },
                "provider_response": resp,
                "submitted_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as e:
            return {
                "status": "error",
                "client_order_id": client_order_id,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                },
                "error": str(e),
                "provider_response": None,
            }

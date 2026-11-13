"""
Trading service — single entry point for paper and live orders.
Every order must pass RiskEngine before any provider submission.
Paper fills update portfolio + journal (Claire Bennett audit trail).
"""
from __future__ import annotations

import uuid
import math
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.risk.engine import RiskEngine, OrderProposal, RiskDecision
from app.trading.portfolio import PortfolioService
from app.trading.executions import normalize_execution


class TradingService:
    def __init__(self, settings: Optional[Settings] = None, db: Optional[Session] = None):
        self.settings = settings or get_settings()
        self.risk = RiskEngine(self.settings)
        self.alpaca = AlpacaClient(self.settings)
        self.binance = BinanceClient(self.settings)
        self.db = db

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
        fill_price_hint: Optional[float] = None,
        reference_price: Optional[float] = None,
        thesis: Optional[str] = None,
        council_action: Optional[str] = None,
    ) -> dict[str, Any]:
        provider, environment = provider.strip().lower(), environment.strip().lower()
        side, order_type, symbol = side.strip().lower(), order_type.strip().lower(), symbol.strip().upper()
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
            reference_price=reference_price if reference_price is not None else (fill_price_hint if environment in ("paper", "testnet") else None),
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
            if self.db is not None and math.isfinite(qty) and qty > 0:
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

        # Persist intent BEFORE a remote side effect. Timeouts and malformed
        # responses remain discoverable by client_order_id during reconciliation.
        if self.db is not None:
            PortfolioService(self.db).record_order_event(
                client_order_id=client_order_id, provider=provider, environment=environment,
                symbol=symbol, side=side, qty=qty, status="pending", risk_approved=True,
                risk_notes=decision.notes, thesis=thesis, council_action=council_action,
            )
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
                execution = normalize_execution("alpaca", resp)
            elif provider.lower() == "binance":
                use_testnet = environment.lower() in ("paper", "testnet")
                # Paper without keys: simulate fill for journal/positions
                if use_testnet and not self.binance.configured and fill_price_hint is not None:
                    if not math.isfinite(fill_price_hint) or fill_price_hint <= 0:
                        raise ValueError("Simulation requires a finite positive market price")
                    crosses = (order_type == "market" or
                               (side == "buy" and fill_price_hint <= limit_price) or
                               (side == "sell" and fill_price_hint >= limit_price))
                    resp = {
                        "simulated": True, "symbol": symbol, "side": side.upper(),
                        "executedQty": str(qty if crosses else 0),
                        "cummulativeQuoteQty": str(qty * fill_price_hint if crosses else 0),
                        "status": "FILLED" if crosses else "NEW",
                    }
                    execution = normalize_execution("binance", resp)
                else:
                    client = BinanceClient(self.settings, use_testnet=use_testnet)
                    resp = await client.submit_order(
                        symbol=symbol,
                        side=side,
                        qty=qty,
                        order_type=order_type.upper(),
                        client_order_id=client_order_id,
                        limit_price=limit_price,
                    )
                    execution = normalize_execution("binance", resp)
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
                "status": execution["status"],
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
                status = execution["status"]
                PortfolioService(self.db).record_order_event(
                    client_order_id=client_order_id,
                    provider=provider,
                    environment=environment,
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    status=status,
                    fill_price=execution["fill_price"],
                    filled_qty=execution["filled_qty"],
                    risk_approved=True,
                    risk_notes=decision.notes,
                    thesis=thesis,
                    council_action=council_action,
                    provider_order_id=str(resp.get("orderId") or resp.get("id") or "") or None,
                )

            return result
        except Exception as e:
            if self.db is not None:
                self.db.rollback()
            return {
                "status": "submission_unknown",
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
"""
Trading service — single entry point for paper and live orders.
Paper orders (and testnet orders without exchange credentials) are executed by ETI's INTERNAL PAPER engine
(app.paper) and never touch an exchange. Exchange testnet / live orders must pass RiskEngine before any
provider submission. Paper fills update portfolio + journal (Claire Bennett audit trail).
"""
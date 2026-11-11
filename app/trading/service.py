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
from app.risk.protection import AccountSnapshot, OrderIntent
from app.risk.protection_service import CapitalProtectionService
from app.trading.portfolio import PortfolioService

PROTECTION_OFFICER = "ETI CAPITAL PROTECTION SYSTEM"


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
        thesis: Optional[str] = None,
        council_action: Optional[str] = None,
        strategy_id: Optional[str] = None,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
        atr_pct: Optional[float] = None,
        reference_price: Optional[float] = None,
        system_exit: bool = False,
    ) -> dict[str, Any]:
        """Every order passes BOTH the ETI Capital Protection System and the RiskEngine.

        Neither gate can be skipped, and nothing in the arguments can relax them: strategy_id, stop_loss,
        take_profit and atr_pct are inputs the protection system validates, not overrides.
        ``system_exit`` is only honoured when the protection system itself verifies (from server-side
        positions) that the order strictly reduces an existing position.
        """
        client_order_id = self._client_order_id()
        protection = CapitalProtectionService(self.db, self.settings)
        price_for_risk = limit_price or reference_price or fill_price_hint
        intent = OrderIntent(
            provider=provider.lower(), environment=environment.lower(), symbol=symbol.upper(), side=side.lower(),
            qty=qty, price=price_for_risk, stop_loss=stop_loss, take_profit=take_profit, strategy_id=strategy_id,
            atr_pct=atr_pct, order_type=order_type.lower(), source="system_exit" if system_exit else "api",
        )
        fallback = AccountSnapshot(
            equity=equity, peak_equity=equity, daily_pnl_pct=daily_realized_pnl_pct,
            drawdown_pct=current_drawdown_pct, source="caller",
        )
        verdict = protection.check_order(intent, fallback=fallback)

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
            reduces_exposure=bool(verdict.approved and verdict.reduces_exposure),
            meta=(
                {"live_confirmed": True, "ref_price": price_for_risk}
                if (system_exit and verdict.approved and verdict.reduces_exposure) else {}
            ),
        )

        decision: RiskDecision = self.risk.evaluate(proposal)
        if not (decision.approved and verdict.approved):
            reasons = ([] if verdict.approved else [f"[Capital Protection] {r}" for r in verdict.reasons]) + (
                [] if decision.approved else list(decision.reasons)
            )
            protection.log_attempt(
                strategy_id=strategy_id, environment=environment.lower(), provider=provider.lower(), symbol=symbol,
                side=side.lower(), qty=qty, reference_price=price_for_risk, fill_price=None,
                outcome="risk_refused", client_order_id=client_order_id,
            )
            result = {
                "status": "rejected",
                "client_order_id": client_order_id,
                "risk": {
                    "decision": "REJECTED",
                    "reasons": reasons,
                    "notes": "; ".join(reasons),
                    "officer": "Helena Frost",
                },
                "capital_protection": {"officer": PROTECTION_OFFICER, **verdict.to_dict()},
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
                    risk_notes="; ".join(reasons),
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
                    "warnings": decision.warnings,
                    "officer": "Helena Frost",
                },
                "provider_response": resp,
                "capital_protection": {"officer": PROTECTION_OFFICER, **verdict.to_dict()},
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
                    position_meta=(
                        None if verdict.reduces_exposure else
                        {"stop_loss": stop_loss, "take_profit": take_profit, "strategy_id": strategy_id}
                    ),
                )

            protection.log_attempt(
                strategy_id=strategy_id, environment=environment.lower(), provider=provider.lower(), symbol=symbol,
                side=side.lower(), qty=qty, reference_price=price_for_risk, fill_price=fill_price,
                outcome="filled" if fill_price is not None else "submitted", client_order_id=client_order_id,
            )
            return result
        except Exception as e:
            protection.log_attempt(
                strategy_id=strategy_id, environment=environment.lower(), provider=provider.lower(), symbol=symbol,
                side=side.lower(), qty=qty, reference_price=price_for_risk, fill_price=None,
                outcome="provider_error", client_order_id=client_order_id,
            )
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

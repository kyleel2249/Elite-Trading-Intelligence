"""
Trading service — single entry point for paper and live orders.
Paper orders (and testnet orders without exchange credentials) are executed by ETI's INTERNAL PAPER engine and never touch an exchange.
Exchange testnet / live orders must pass RiskEngine before any provider submission.
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
from app.integrations.oanda import OandaClient
from app.paper import mode as paper_mode
from app.risk.engine import RiskEngine, OrderProposal, RiskDecision
from app.trading.portfolio import PortfolioService


class TradingService:
    def __init__(self, settings: Optional[Settings] = None, db: Optional[Session] = None):
        self.settings = settings or get_settings()
        self.risk = RiskEngine(self.settings)
        self.alpaca = AlpacaClient(self.settings)
        self.binance = BinanceClient(self.settings)
        self.db = db

    def _client_order_id(self) -> str:
        return f"eti-{uuid.uuid4().hex[:20]}"

    def _creds_configured(self, provider: str) -> bool:
        p = provider.lower()
        if p == "alpaca":
            return bool(self.settings.alpaca_configured)
        if p == "binance":
            return bool(self.settings.binance_configured)
        return bool(getattr(self.settings, f"{p}_configured", False))

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

        # Execution-mode resolution. Only INTERNAL_PAPER is diverted here; exchange testnet / live / rejected
        # requests continue through the existing, risk-gated path below. Live is never simulated.
        mode = paper_mode.resolve_mode(
            provider, environment,
            creds_configured=self._creds_configured(provider),
            live_enabled=bool(self.settings.live_trading_enabled),
        )
        if mode.mode == paper_mode.INTERNAL_PAPER:
            from app.paper.runtime import place_via_trading_service
            ot = order_type.lower()
            if ot not in ("market", "limit"):
                return {"status": "rejected", "client_order_id": client_order_id, "execution_mode": "INTERNAL_PAPER",
                        "mode_resolution": mode.to_dict(),
                        "risk": {"decision": "REJECTED", "reasons": [f"order_type '{order_type}' is not supported here; use /api/paper/orders for stop and take_profit"],
                                 "notes": "", "officer": "INTERNAL_PAPER_ENGINE"}, "provider_response": None}
            return await place_via_trading_service(
                symbol=symbol, side=side, qty=qty, order_type=ot, limit_price=limit_price, thesis=thesis,
                client_order_id=client_order_id, mode_info=mode.to_dict(),
            )

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
            result = {
                "status": "rejected",
                "client_order_id": client_order_id,
                "execution_mode": mode.mode,
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
                # Alpaca "paper"/"testnet" must hit the PAPER API only; never let live keys be used for a sandbox request.
                if environment.lower() in ("paper", "testnet") and not self.settings.alpaca_paper:
                    return {
                        "status": "rejected",
                        "client_order_id": client_order_id,
                        "risk": {
                            "decision": "REJECTED",
                            "reasons": ["Alpaca live credentials configured but paper/testnet environment requested"],
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
                client = BinanceClient(self.settings, use_testnet=use_testnet)
                resp = await client.submit_order(
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    order_type=order_type.upper(),
                    client_order_id=client_order_id,
                )
                fill_price = fill_price_hint
            elif provider.lower() == "oanda":
                # paper -> OANDA practice account; live host is reachable only for environment="live" (risk-gated)
                client = OandaClient(self.settings, use_practice=environment.lower() != "live")
                resp = await client.submit_order(
                    symbol=symbol, qty=qty, side=side, order_type=order_type,
                    limit_price=limit_price, client_order_id=client_order_id,
                )
                # Only a real fill price counts: a pending limit order must not be journaled as filled at the market price.
                fill_price = resp.get("fill_price")
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
                "execution_mode": mode.mode,
                "mode_label": mode.label,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                    "warnings": decision.warnings,
                    "officer": "Helena Frost",
                },
                "provider_response": resp,
                "submitted_at": datetime.now(timezone.utc).isoformat(),
            }

            if self.db is not None:
                # Exchange testnet fills are only journaled as filled when the provider reported a price.
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
                "execution_mode": mode.mode,
                "risk": {
                    "decision": decision.decision.value,
                    "reasons": decision.reasons,
                    "notes": decision.notes,
                    "officer": "Helena Frost",
                },
                "error": str(e),
                "provider_response": None,
            }

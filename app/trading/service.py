"""
Trading service — single entry point for paper and live orders.
Paper orders (and testnet orders without exchange credentials) are executed by ETI's INTERNAL PAPER engine
(app.paper) and never touch an exchange. Exchange testnet / live orders must pass RiskEngine before any
provider submission. Paper fills update portfolio + journal (Claire Bennett audit trail).
"""
from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.integrations.oanda import OandaClient, OandaError
from app.paper import mode as paper_modes
from app.risk.engine import RiskEngine, OrderProposal, RiskDecision
from app.risk.protection import AccountSnapshot, OpenPosition, OrderIntent
from app.risk.protection_service import CapitalProtectionService
from app.trading.executions import normalize_execution
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

    def _creds_configured(self, provider: str) -> bool:
        p = provider.lower()
        if p == "alpaca":
            return bool(self.settings.alpaca_configured)
        if p == "binance":
            return bool(self.settings.binance_configured)
        return bool(getattr(self.settings, f"{p}_configured", False))

    def _paper_resolution(self, provider: str, environment: str):
        """INTERNAL_PAPER resolution, or None when the request must continue down the exchange path.
        Live is never simulated here: live, testnet-with-credentials and unknown environments fall through to the risk-gated path."""
        res = paper_modes.resolve_mode(provider.lower(), environment, creds_configured=self._creds_configured(provider),
                                       live_enabled=bool(getattr(self.settings, "live_trading_enabled", False)))
        return res if res.mode == paper_modes.INTERNAL_PAPER else None

    async def _place_internal_paper(self, *, res, client_order_id: str, symbol: str, side: str, qty: float,
                                    order_type: str, limit_price: Optional[float], thesis: Optional[str] = None) -> dict[str, Any]:
        from app.paper.runtime import place_via_trading_service

        return await place_via_trading_service(symbol=symbol.upper(), side=side.lower(), qty=qty, order_type=order_type.lower(),
                                               limit_price=limit_price, thesis=thesis, client_order_id=client_order_id,
                                               mode_info=res.to_dict())

    async def _paper_snapshot(self, protection: CapitalProtectionService, environment: str, provider: str) -> AccountSnapshot:
        """Account state of the internal paper exchange (its own equity/positions), with drawdown, halt and loss-streak
        state from the protection store. Daily/weekly P&L are not tracked by the simulator and are reported as 0."""
        try:
            from app.paper.runtime import get_exchange

            acct = await get_exchange().account(tick=False)
        except Exception:
            return AccountSnapshot(equity=0.0, peak_equity=0.0, source="unavailable")
        positions = tuple(
            OpenPosition(provider=provider.lower(), symbol=p["symbol"], side="long", qty=float(p["qty"]),
                         price=float(p["mark_price"] or p["avg_cost"] or 0.0), avg_entry=float(p["avg_cost"] or 0.0))
            for p in acct.get("positions", []) if p.get("open")
        )
        return protection.external_snapshot(
            "paper_internal", equity=float(acct["equity"]), start_equity=float(acct["starting_cash"]),
            positions=positions, source="database", halt_environment=environment.lower(),
        )

    async def internal_paper_verdict(self, protection: CapitalProtectionService, intent: OrderIntent):
        """Capital-protection verdict for an order bound for the internal paper engine (also used by /api/paper/orders)."""
        return protection.check_with_account(intent, await self._paper_snapshot(protection, intent.environment, intent.provider))

    async def _place_internal_paper_protected(self, *, res, protection: CapitalProtectionService, intent: OrderIntent,
                                              client_order_id: str, symbol: str, side: str, qty: float, order_type: str,
                                              limit_price: Optional[float], thesis: Optional[str], strategy_id: Optional[str],
                                              stop_loss: Optional[float], price_for_risk: Optional[float]) -> dict[str, Any]:
        verdict = await self.internal_paper_verdict(protection, intent)
        if not verdict.approved:
            reasons = [f"[Capital Protection] {r}" for r in verdict.reasons]
            protection.log_attempt(
                strategy_id=strategy_id, environment=intent.environment, provider=intent.provider, symbol=symbol,
                side=side.lower(), qty=qty, reference_price=price_for_risk, fill_price=None,
                outcome="risk_refused", client_order_id=client_order_id,
            )
            return {
                "status": "rejected", "accepted": False, "client_order_id": client_order_id,
                "execution_mode": "INTERNAL_PAPER", "mode_resolution": res.to_dict(), "reasons": reasons,
                "risk": {"decision": "REJECTED", "reasons": reasons, "notes": "; ".join(reasons), "officer": PROTECTION_OFFICER},
                "capital_protection": {"officer": PROTECTION_OFFICER, **verdict.to_dict()},
                "provider_response": None,
            }
        if verdict.reduces_exposure:
            # An exit must not be blocked by this system's own protective stop reserving the held quantity.
            try:
                from app.paper.runtime import get_exchange

                await get_exchange().cancel_all(symbol.upper())
            except Exception:
                pass
        out = await self._place_internal_paper(res=res, client_order_id=client_order_id, symbol=symbol, side=side,
                                               qty=qty, order_type=order_type, limit_price=limit_price, thesis=thesis)
        out["capital_protection"] = {"officer": PROTECTION_OFFICER, **verdict.to_dict()}
        protection.log_attempt(
            strategy_id=strategy_id, environment=intent.environment, provider=intent.provider, symbol=symbol,
            side=side.lower(), qty=qty, reference_price=price_for_risk,
            fill_price=((out.get("fills") or [{}])[-1].get("price") if out.get("fills") else None),
            outcome="filled" if out.get("accepted") else "risk_refused", client_order_id=client_order_id,
        )
        # Stop-loss enforcement: a long entry that filled gets a resting protective stop in the paper engine.
        if out.get("accepted") and not verdict.reduces_exposure and side.lower() == "buy" and stop_loss and out.get("fills"):
            try:
                from app.paper.runtime import get_exchange

                filled = sum(float(f.get("qty", 0.0)) for f in out["fills"])
                if filled > 0:
                    sl = await get_exchange().submit(symbol=symbol.upper(), side="sell", qty=filled, order_type="stop",
                                                     trigger_price=float(stop_loss), client_order_id=f"{client_order_id}-sl",
                                                     thesis="capital protection: protective stop")
                    out["protective_stop"] = {"accepted": bool(sl.get("accepted")), "trigger_price": float(stop_loss),
                                              "reasons": sl.get("reasons", [])}
            except Exception:
                out["protective_stop"] = {"accepted": False, "reasons": ["protective_stop_failed"]}
        return out

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
        strategy_id: Optional[str] = None,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
        atr_pct: Optional[float] = None,
        system_exit: bool = False,
    ) -> dict[str, Any]:
        """Every order passes BOTH the ETI Capital Protection System and the RiskEngine.

        Neither gate can be skipped, and nothing in the arguments can relax them: strategy_id, stop_loss,
        take_profit and atr_pct are inputs the protection system validates, not overrides.
        ``system_exit`` is only honoured when the protection system itself verifies (from server-side
        positions) that the order strictly reduces an existing position.
        """
        provider, environment = provider.strip().lower(), environment.strip().lower()
        side, order_type, symbol = side.strip().lower(), order_type.strip().lower(), symbol.strip().upper()
        client_order_id = self._client_order_id()
        protection = CapitalProtectionService(self.db, self.settings)
        price_for_risk = limit_price or reference_price or fill_price_hint
        intent = OrderIntent(
            provider=provider.lower(), environment=environment.lower(), symbol=symbol.upper(), side=side.lower(),
            qty=qty, price=price_for_risk, stop_loss=stop_loss, take_profit=take_profit, strategy_id=strategy_id,
            atr_pct=atr_pct, order_type=order_type.lower(), source="system_exit" if system_exit else "api",
        )

        # ETI's internal paper engine is a separate simulator, but it is NOT exempt from capital protection:
        # the protection verdict is computed against that engine's own account before anything is submitted.
        paper_res = self._paper_resolution(provider, environment)
        if paper_res is not None:
            return await self._place_internal_paper_protected(
                res=paper_res, protection=protection, intent=intent, client_order_id=client_order_id, symbol=symbol,
                side=side, qty=qty, order_type=order_type, limit_price=limit_price, thesis=thesis,
                strategy_id=strategy_id, stop_loss=stop_loss, price_for_risk=price_for_risk,
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
            stop_loss=stop_loss,
            take_profit=take_profit,
            client_order_id=client_order_id,
            reference_price=reference_price if reference_price is not None else (fill_price_hint if environment in ("paper", "testnet") else None),
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
                    risk_notes="; ".join(reasons),
                    thesis=thesis,
                    council_action=council_action,
                )
            return result

        # Persist intent BEFORE a remote side effect. Timeouts and malformed responses remain
        # discoverable by client_order_id during reconciliation.
        if self.db is not None:
            PortfolioService(self.db).record_order_event(
                client_order_id=client_order_id, provider=provider, environment=environment,
                symbol=symbol, side=side, qty=qty, status="pending", risk_approved=True,
                risk_notes=decision.notes, thesis=thesis, council_action=council_action,
            )
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
                execution = normalize_execution("alpaca", resp)
            elif provider.lower() == "binance":
                use_testnet = environment.lower() in ("paper", "testnet")
                # Paper without keys: simulate the fill from the server price for journal/positions.
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
            elif provider.lower() == "oanda":
                # paper -> OANDA practice account; live host is reachable only for environment="live" (risk-gated)
                client = OandaClient(self.settings, use_practice=environment.lower() != "live")
                resp = await client.submit_order(
                    symbol=symbol, qty=qty, side=side, order_type=order_type,
                    limit_price=limit_price, client_order_id=client_order_id,
                )
                # Only a real fill price counts: a pending limit order must not be journaled as filled at the market price.
                oanda_fill = resp.get("fill_price")
                execution = {"status": "filled" if oanda_fill is not None else "submitted",
                             "filled_qty": qty if oanda_fill is not None else 0.0, "fill_price": oanda_fill,
                             "provider_order_id": str(resp.get("id") or "") or None}
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
                # OANDA answers with a submission acknowledgement; the journal still records the confirmed fill.
                "status": "submitted" if provider == "oanda" and execution["status"] == "filled" else execution["status"],
                "client_order_id": client_order_id,
                "environment": environment,
                "execution_mode": "exchange_testnet" if environment.lower() != "live" else "live",
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
                # Only confirmed cumulative executions are journaled as fills; never a quote hint.
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
                    position_meta=(
                        None if verdict.reduces_exposure else
                        {"stop_loss": stop_loss, "take_profit": take_profit, "strategy_id": strategy_id}
                    ),
                )

            protection.log_attempt(
                strategy_id=strategy_id, environment=environment.lower(), provider=provider.lower(), symbol=symbol,
                side=side.lower(), qty=qty, reference_price=price_for_risk, fill_price=execution.get("fill_price"),
                outcome="filled" if execution.get("fill_price") is not None else "submitted", client_order_id=client_order_id,
            )
            return result
        except Exception as e:
            if self.db is not None:
                self.db.rollback()
            # A definite broker refusal (OandaError) is an error; anything else (timeout, malformed
            # response) may have reached the broker, so the order stays discoverable for reconciliation.
            definite = isinstance(e, OandaError)
            if definite and self.db is not None:
                try:
                    PortfolioService(self.db).record_order_event(
                        client_order_id=client_order_id, provider=provider, environment=environment,
                        symbol=symbol, side=side, qty=qty, status="rejected", risk_approved=False,
                        risk_notes=str(e)[:500], thesis=thesis, council_action=council_action,
                    )
                except Exception:
                    self.db.rollback()
            protection.log_attempt(
                strategy_id=strategy_id, environment=environment.lower(), provider=provider.lower(), symbol=symbol,
                side=side.lower(), qty=qty, reference_price=price_for_risk, fill_price=None,
                outcome="provider_error", client_order_id=client_order_id,
            )
            return {
                "status": "error" if definite else "submission_unknown",
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

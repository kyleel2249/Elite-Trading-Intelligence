"""Risk-gated execution of validated alpha opportunities.

Order of authority: Decision-layer validation -> fresh re-validation at order time ->
server-side RiskEngine inside TradingService -> broker. Paper/testnet only unless
live trading is enabled by two operator flags AND the request carries the exact
confirmation phrase. ETI never requests withdrawal or transfer permissions, and
nothing here can change its own permissions.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional, Sequence

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaAuditLog, AlphaCandidate, AlphaTradePlan
from app.alpha.context import gather_context
from app.alpha.fusion import validate
from app.alpha.strategy_lab import record_live_outcome
from app.config import Settings, get_settings
from app.market.service import MarketService
from app.trading.risk_context import build_risk_context
from app.trading.service import TradingService

logger = logging.getLogger("eti.alpha")
LIVE_PHRASE = "I AUTHORIZE LIVE ORDER"
EXECUTABLE = ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")
PROVIDER_FOR = {"crypto": "binance", "equity": "alpaca", "etf": "alpaca"}

BarsFn = Callable[[AlphaCandidate], Awaitable[Sequence[dict[str, Any]]]]
PriceFn = Callable[[str, str], Awaitable[Optional[dict[str, Any]]]]


def audit(db: Session, actor: str, action: str, detail: dict[str, Any]) -> None:
    db.add(AlphaAuditLog(actor=actor, action=action, detail=detail))
    db.commit()


def _reject(db: Session, cand_id: str, reasons: list[str], extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    audit(db, "executor", "order_rejected", {"candidate_id": cand_id, "reasons": reasons})
    return {"status": "rejected", "reasons": reasons, **(extra or {})}


class AlphaExecutor:
    def __init__(self, db: Session, settings: Optional[Settings] = None, trading: Optional[TradingService] = None,
                 price_fn: Optional[PriceFn] = None):
        self.db = db
        self.settings = settings or get_settings()
        self.trading = trading or TradingService(self.settings, db=db)
        self._price_fn = price_fn or self._default_price

    async def _default_price(self, provider: str, symbol: str) -> Optional[dict[str, Any]]:
        return await MarketService(self.settings).get_snapshot(provider, symbol)

    # ----------------------------------------------------------------- entry
    async def execute(self, candidate_id: str, environment: str, bars_fn: BarsFn, confirm_live: Optional[str] = None) -> dict[str, Any]:
        s = self.settings
        env = environment.lower()
        cand = self.db.query(AlphaCandidate).filter_by(candidate_id=candidate_id).one_or_none()
        if cand is None:
            return _reject(self.db, candidate_id, ["unknown candidate"])
        if env not in ("paper", "testnet", "live"):
            return _reject(self.db, candidate_id, ["environment must be paper, testnet or live"])
        if env == "live":
            missing = []
            if not s.live_trading_enabled:
                missing.append("LIVE_TRADING_ENABLED is false")
            if not s.alpha_live_execution_authorized:
                missing.append("ALPHA_LIVE_EXECUTION_AUTHORIZED is false")
            if not s.api_key:
                missing.append("API_KEY is not configured")
            if confirm_live != LIVE_PHRASE:
                missing.append("live confirmation phrase missing or wrong")
            if missing:
                return _reject(self.db, candidate_id, ["live execution not authorized: " + "; ".join(missing)])
        provider = PROVIDER_FOR.get(cand.asset_class)
        if provider is None:
            return _reject(self.db, candidate_id, [f"no authorized execution venue for asset class '{cand.asset_class}' (research only)"])
        if cand.status not in EXECUTABLE:
            return _reject(self.db, candidate_id, [f"status {cand.status} is not executable; Decision-layer approval required"])
        max_age = timedelta(hours=s.alpha_validation_max_age_hours)
        if not cand.validated_at or datetime.now(timezone.utc).replace(tzinfo=None) - cand.validated_at > max_age:
            return _reject(self.db, candidate_id, ["validation is stale; run validation again"])
        if self.db.query(AlphaTradePlan).filter(AlphaTradePlan.candidate_id == candidate_id, AlphaTradePlan.status == "OPEN",
                                                AlphaTradePlan.environment == env).first():
            return _reject(self.db, candidate_id, ["an open plan already exists for this candidate"])

        snapshot = None
        try:
            snapshot = await self._price_fn(provider, cand.symbol)
        except Exception:  # noqa: BLE001
            logger.warning("snapshot failed for %s", cand.symbol, exc_info=True)
        ctx = build_risk_context(self.db, s, environment=env, snapshot=snapshot)
        # Never act on stale information: re-run the independent validation on fresh bars now.
        bars = await bars_fn(cand)
        extra = await gather_context(self.db, s, cand, bars)
        val = validate(self.db, cand, bars, settings=s, equity=ctx.equity, open_positions=ctx.current_open_positions, record=False, **extra)
        if not val["executable"]:
            return _reject(self.db, candidate_id, ["re-validation at order time failed: " + ", ".join(val["hard_failures"] or [val["decision"]])], {"validation": val})
        plan = val["plan"]
        price = (snapshot or {}).get("price")
        if price is None:
            return _reject(self.db, candidate_id, ["no live quote available to confirm entry"])
        if abs(price / plan["entry"] - 1) > 0.01:
            return _reject(self.db, candidate_id, [f"price {price} drifted >1% from validated entry {plan['entry']}; revalidate"])
        qty = plan["qty"]
        if provider == "alpaca":
            qty = float(int(qty))
        if ctx.equity <= 0:
            return _reject(self.db, candidate_id, ["account equity unavailable (set LIVE_ACCOUNT_EQUITY for live); refusing to size an order"])
        if qty <= 0:
            return _reject(self.db, candidate_id, ["position size rounds to zero under risk limits"])
        risk_amount = qty * (plan["entry"] - plan["stop"])
        thesis = f"alpha:{candidate_id} stage={val['stage']} validation={val['validation_score']}"
        res = await self.trading.place_order(
            provider=provider, environment=env, symbol=cand.symbol, side="buy", qty=qty, order_type="limit" if env == "live" else "market",
            limit_price=price if env == "live" else None, equity=ctx.equity,
            current_open_positions=ctx.current_open_positions, daily_realized_pnl_pct=ctx.daily_realized_pnl_pct,
            current_drawdown_pct=ctx.current_drawdown_pct, data_age_seconds=ctx.data_age_seconds, data_status=ctx.data_status,
            estimated_risk_amount=risk_amount, fill_price_hint=price, thesis=thesis, council_action=val["decision"])
        row = AlphaTradePlan(plan_id=f"plan_{uuid.uuid4().hex[:14]}", candidate_id=candidate_id, symbol=cand.symbol, provider=provider,
                             environment=env, side="buy", entry=price, stop=plan["stop"], tp1=plan["tp1"], tp2=plan["tp2"], tp3=plan["tp3"],
                             qty=qty, remaining_qty=qty, stop_current=plan["stop"], status="REJECTED", client_order_id=res.get("client_order_id"),
                             decision={"validation": {k: val[k] for k in ("decision", "validation_score", "hard_failures", "stage")}, "risk": res.get("risk")},
                             attribution=val["attribution"], strategy_ids=val["champion_strategies_long"] or [a["id"] for a in val["attribution"]["strategies_agreeing"]])
        if res["status"] == "rejected":
            row.close_reason = "RISK_REJECTED"
            self.db.add(row)
            self.db.commit()
            return _reject(self.db, candidate_id, res["risk"]["reasons"], {"plan_id": row.plan_id})
        if res["status"] == "error":
            row.status, row.close_reason = "ERROR", "BROKER_ERROR"
            self.db.add(row)
            self.db.commit()
            return _reject(self.db, candidate_id, ["broker error; order not confirmed"], {"plan_id": row.plan_id})
        confirmed = self._confirmed(provider, res)
        row.status = "OPEN" if confirmed else "UNCONFIRMED"
        self.db.add(row)
        self.db.commit()
        audit(self.db, "executor", "order_submitted", {"plan_id": row.plan_id, "environment": env, "confirmed": confirmed, "client_order_id": row.client_order_id})
        return {"status": "open" if confirmed else "unconfirmed", "plan_id": row.plan_id, "client_order_id": row.client_order_id, "environment": env,
                "plan": {"entry": price, "stop": plan["stop"], "tp1": plan["tp1"], "tp2": plan["tp2"], "tp3": plan["tp3"], "qty": qty},
                "protective_orders": "ETI-managed: stop and take-profits are enforced by the position monitor, not resting broker orders",
                "risk": res["risk"], "confirmation": "exchange acknowledgement verified" if confirmed else "no exchange confirmation; position not treated as open"}

    @staticmethod
    def _confirmed(provider: str, res: dict[str, Any]) -> bool:
        pr = res.get("provider_response") or {}
        if provider == "binance":
            return str(pr.get("status", "")).upper() in ("FILLED", "PARTIALLY_FILLED", "NEW") and bool(pr.get("simulated") or pr.get("orderId"))
        return bool(pr.get("id") or pr.get("simulated"))

    # ----------------------------------------------------------------- monitoring / exits
    async def _exit(self, plan: AlphaTradePlan, qty: float, price: float, reason: str) -> bool:
        s = self.settings
        snapshot = {"price": price, "ts_utc": datetime.now(timezone.utc).isoformat(), "data_status": "fresh"}
        ctx = build_risk_context(self.db, s, environment=plan.environment, snapshot=snapshot)
        # Reduce-only exit: entry exposure limits must not trap an open position. Equity, data
        # and environment gates still apply inside RiskEngine.
        res = await self.trading.place_order(
            provider=plan.provider, environment=plan.environment, symbol=plan.symbol, side="sell", qty=qty, order_type="market",
            equity=ctx.equity, current_open_positions=0, daily_realized_pnl_pct=0.0, current_drawdown_pct=0.0,
            data_age_seconds=ctx.data_age_seconds, data_status=ctx.data_status, fill_price_hint=price, thesis=f"alpha-exit:{reason}:{plan.plan_id}",
            council_action=reason)
        if res["status"] not in ("submitted",):
            audit(self.db, "monitor", "exit_failed", {"plan_id": plan.plan_id, "reason": reason, "result": res.get("risk")})
            return False
        plan.realized_pnl = (plan.realized_pnl or 0.0) + (price - plan.entry) * qty
        plan.remaining_qty = max(0.0, (plan.remaining_qty or 0.0) - qty)
        return True

    async def monitor(self) -> dict[str, Any]:
        acted, errors = [], 0
        for plan in self.db.query(AlphaTradePlan).filter(AlphaTradePlan.status == "OPEN").all():
            try:
                snap = await self._price_fn(plan.provider, plan.symbol)
                price = (snap or {}).get("price")
                if price is None:
                    continue
                stop = plan.stop_current or plan.stop
                if price <= stop:
                    if await self._exit(plan, plan.remaining_qty, price, "STOP" if stop < plan.entry else "BREAKEVEN_STOP"):
                        self._close(plan, price, "STOP" if stop < plan.entry else "BREAKEVEN_STOP")
                        acted.append({"plan_id": plan.plan_id, "event": "stopped", "price": price})
                    continue
                third = plan.qty / 3.0
                if plan.provider == "alpaca":
                    third = float(int(third))  # equities trade in whole shares here; tiny positions skip scale-outs
                if plan.tp_hits < 1 and price >= plan.tp1:
                    if third <= 0 or await self._exit(plan, min(third, plan.remaining_qty), price, "TP1"):
                        plan.tp_hits, plan.stop_current = 1, plan.entry
                        acted.append({"plan_id": plan.plan_id, "event": "tp1" if third > 0 else "tp1_stop_to_breakeven", "price": price})
                if plan.tp_hits < 2 and price >= plan.tp2 and plan.remaining_qty > 0:
                    if third <= 0 or await self._exit(plan, min(third, plan.remaining_qty), price, "TP2"):
                        plan.tp_hits = 2
                        acted.append({"plan_id": plan.plan_id, "event": "tp2" if third > 0 else "tp2_no_scale", "price": price})
                if price >= plan.tp3 and plan.remaining_qty > 0:
                    if await self._exit(plan, plan.remaining_qty, price, "TP3"):
                        self._close(plan, price, "TP3")
                        acted.append({"plan_id": plan.plan_id, "event": "tp3_closed", "price": price})
                self.db.commit()
            except Exception:  # noqa: BLE001
                errors += 1
                logger.warning("monitor failed for %s", plan.plan_id, exc_info=True)
        return {"actions": acted, "errors": errors}

    def _close(self, plan: AlphaTradePlan, price: float, reason: str) -> None:
        plan.status, plan.close_reason, plan.close_price = "CLOSED", reason, price
        plan.closed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        plan.pnl = plan.realized_pnl
        ids = plan.strategy_ids or []
        ac = "crypto" if plan.provider == "binance" else "equity"
        for sid in ids:
            record_live_outcome(self.db, sid, ac, plan.pnl / max(1, len(ids)))
        self.db.commit()
        audit(self.db, "monitor", "plan_closed", {"plan_id": plan.plan_id, "reason": reason, "pnl": plan.pnl})

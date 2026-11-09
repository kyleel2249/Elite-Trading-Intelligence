"""
Wire strategy modules to paper/live execution via TradingService.
Every order passes RiskEngine (Helena Frost). Live requires LIVE_TRADING_ENABLED + keys.
Risk inputs (equity, positions, PnL, data freshness) are derived server-side.

Memory integration: every generated signal is recorded (before any order is sent, so the
resulting fill can be linked to the exact analysis), and execution is blocked for strategies the
adaptive-edge governance has suspended.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.backtest.engine import BacktestParams, run_backtest, walk_forward
from app.backtest.signals import vcp_signals, wyckoff_signals, breakout_signals, sma_trend_signals
from app.config import Settings
from app.market.service import MarketService
from app.trading.risk_context import build_risk_context
from app.trading.service import TradingService
from app.knowledge.strategies import STRATEGY_MODULES

logger = logging.getLogger("eti.runner")


class StrategyRunner:
    def __init__(self, settings: Settings, db: Optional[Session] = None):
        self.settings = settings
        self.db = db
        self.market = MarketService(settings)
        self.trading = TradingService(settings, db=db)

    async def backtest_module(
        self,
        module_id: str,
        symbol: str = "BTCUSDT",
        provider: str = "binance",
        lookback: int = 20,
        limit: int = 200,
        walk_forward_mode: bool = False,
    ) -> dict[str, Any]:
        if module_id not in STRATEGY_MODULES:
            return {"error": f"Unknown module {module_id}"}
        klines = await self.market.get_history(provider, symbol, interval="1h", limit=limit)
        params = BacktestParams(module_id=module_id, symbol=symbol, lookback=lookback)
        if walk_forward_mode:
            return walk_forward(klines, params).to_dict()
        return run_backtest(klines, params).to_dict()

    def _latest_signal(self, module_id: str, closes: list[float], volumes: list[float] | None) -> str:
        if len(closes) < 25:
            return "flat"
        if module_id == "minervini_vcp":
            sigs = vcp_signals(closes, lookback=30)
        elif module_id == "wyckoff_supply_demand":
            sigs = wyckoff_signals(closes, volumes, lookback=40)
        elif module_id in ("turtle_trend", "darvas_box", "oneil_canslim"):
            sigs = breakout_signals(closes, 20)
        else:
            sigs = sma_trend_signals(closes, 20)
        last = sigs[-1] if sigs else 0
        if last == 1:
            return "long"
        if last == -1:
            return "exit_long"
        return "flat"

    def _record_signal(self, module_id: str, symbol: str, provider: str, signal: str, closes: list[float], signal_model: str) -> Optional[str]:
        """Persist the signal in ETI memory (best effort - never blocks signal generation)."""
        if self.db is None:
            return None
        try:
            from app.memory.signals import SignalMemoryService
            from app.memory.versions import StrategyVersionService

            version = StrategyVersionService(self.db, self.settings).ensure_baseline(module_id)
            sig = SignalMemoryService(self.db, self.settings).record(
                source="strategy_runner",
                symbol=symbol,
                provider=provider,
                direction={"long": "long", "exit_long": "exit", "flat": "flat"}.get(signal, "unknown"),
                reference_price=closes[-1] if closes else None,
                strategy_id=module_id,
                strategy_version=version.version if version else None,
                analysis={"signal": signal, "signal_model": signal_model, "reference": "last_1h_close", "bars": len(closes)},
            )
            return sig.signal_id
        except Exception:
            self.db.rollback()
            logger.warning("memory signal record failed for %s", module_id, exc_info=True)
            return None

    async def signal_and_maybe_trade(
        self,
        *,
        module_id: str,
        symbol: str,
        provider: str,
        environment: str,
        qty: float,
        equity: float = 10000.0,  # deprecated and ignored: equity is derived server-side
        execute: bool = False,
    ) -> dict[str, Any]:
        if module_id not in STRATEGY_MODULES:
            return {"error": "Unknown module"}
        mod = STRATEGY_MODULES[module_id]
        env = environment.lower()

        # Live path hard checks before any order
        live_block: list[str] = []
        if env == "live":
            if not self.settings.live_trading_enabled:
                live_block.append("LIVE_TRADING_ENABLED is false")
            if provider == "alpaca" and not self.settings.alpaca_configured:
                live_block.append("Alpaca credentials missing")
            if provider == "binance" and not self.settings.binance_configured:
                live_block.append("Binance credentials missing")
            if provider == "binance" and not self.settings.binance_live_trading_enabled:
                live_block.append("BINANCE_LIVE_TRADING_ENABLED is false")

        klines = await self.market.get_history(provider, symbol, interval="1h", limit=120)
        closes = [float(k["close"]) for k in klines if k.get("close") is not None]
        volumes = None
        if klines and klines[0].get("volume") is not None:
            volumes = [float(k.get("volume") or 0) for k in klines]
        signal = self._latest_signal(module_id, closes, volumes)
        bt = run_backtest(klines, BacktestParams(module_id=module_id, symbol=symbol, lookback=20))
        memory_signal_id = self._record_signal(module_id, symbol, provider, signal, closes, bt.signal_model)

        result: dict[str, Any] = {
            "module_id": module_id,
            "module_name": mod.name,
            "inspired_by": mod.inspired_by,
            "signal": signal,
            "symbol": symbol,
            "environment": env,
            "live_blocks": live_block,
            "memory_signal_id": memory_signal_id,
            "backtest_snapshot": {
                "trades": bt.trades,
                "total_return_pct": bt.total_return_pct,
                "max_drawdown_pct": bt.max_drawdown_pct,
                "signal_model": bt.signal_model,
            },
            "eti_desk": {
                "strategist": "Adrian Cole",
                "risk_officer": "Helena Frost",
                "execution_analyst": "Omar Diallo",
                "auditor": "Claire Bennett",
                "technical": "Elena Varga",
                "quant": "Kenji Mori",
            },
            "executed": False,
            "order": None,
        }

        if not execute:
            return result

        if live_block:
            result["message"] = "Live execution blocked"
            result["order"] = {"status": "rejected", "reasons": live_block, "officer": "Helena Frost"}
            return result

        if self.db is not None:
            from app.memory.registry import is_suspended

            if is_suspended(self.db, module_id):
                result["message"] = "Strategy is suspended by adaptive-edge governance; resume it before executing"
                result["order"] = {"status": "rejected", "reasons": ["strategy_suspended"], "officer": "Helena Frost"}
                return result

        side = "buy" if signal == "long" else ("sell" if signal == "exit_long" else None)
        if side is None:
            result["message"] = "No actionable signal"
            return result

        # Real quote for freshness + paper fill price (previously hard-coded "fresh"/5s).
        snapshot: Optional[dict[str, Any]] = None
        try:
            snapshot = await self.market.get_snapshot(provider, symbol)
        except Exception:
            logger.warning("snapshot failed for %s %s", provider, symbol, exc_info=True)

        ctx = build_risk_context(self.db, self.settings, environment=env, snapshot=snapshot)
        fill_hint = None
        if env in ("paper", "testnet") and snapshot and snapshot.get("price") is not None:
            fill_hint = float(snapshot["price"])

        order = await self.trading.place_order(
            provider=provider,
            environment=env,
            symbol=symbol,
            side=side,
            qty=qty,
            equity=ctx.equity,
            current_open_positions=ctx.current_open_positions,
            daily_realized_pnl_pct=ctx.daily_realized_pnl_pct,
            current_drawdown_pct=ctx.current_drawdown_pct,
            data_status=ctx.data_status,
            data_age_seconds=ctx.data_age_seconds,
            fill_price_hint=fill_hint,
            thesis=f"StrategyRunner:{module_id}:{signal}:{bt.signal_model}",
            council_action=signal.upper(),
        )
        result["executed"] = order.get("status") in ("submitted", "filled")
        result["order"] = order
        result["risk_inputs"] = {"source": "server", **ctx.to_dict()}
        return result

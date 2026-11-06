"""
Wire strategy modules to paper/live execution via TradingService.
Every order passes RiskEngine (Helena Frost). Live requires LIVE_TRADING_ENABLED + keys.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy.orm import Session

from app.backtest.engine import BacktestParams, run_backtest, walk_forward
from app.backtest.signals import vcp_signals, wyckoff_signals, breakout_signals, sma_trend_signals
from app.config import Settings
from app.market.service import MarketService
from app.trading.service import TradingService
from app.knowledge.strategies import STRATEGY_MODULES


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

    async def signal_and_maybe_trade(
        self,
        *,
        module_id: str,
        symbol: str,
        provider: str,
        environment: str,
        qty: float,
        equity: float = 10000.0,
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

        result: dict[str, Any] = {
            "module_id": module_id,
            "module_name": mod.name,
            "inspired_by": mod.inspired_by,
            "signal": signal,
            "symbol": symbol,
            "environment": env,
            "live_blocks": live_block,
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

        side = "buy" if signal == "long" else ("sell" if signal == "exit_long" else None)
        if side is None:
            result["message"] = "No actionable signal"
            return result

        order = await self.trading.place_order(
            provider=provider,
            environment=env,
            symbol=symbol,
            side=side,
            qty=qty,
            equity=equity,
            data_status="fresh",
            data_age_seconds=5.0,
            thesis=f"StrategyRunner:{module_id}:{signal}:{bt.signal_model}",
            council_action=signal.upper(),
        )
        result["executed"] = order.get("status") in ("submitted", "filled")
        result["order"] = order
        return result

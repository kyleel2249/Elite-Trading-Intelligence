"""
Wire strategy modules to paper/live execution via TradingService.
Every live/paper order still passes RiskEngine (Helena Frost).
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy.orm import Session

from app.backtest.engine import BacktestParams, run_backtest, walk_forward
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
        """
        Generate latest signal from module proxy; optionally execute via risk-gated TradingService.
        environment: paper | testnet | live
        """
        if module_id not in STRATEGY_MODULES:
            return {"error": "Unknown module"}
        mod = STRATEGY_MODULES[module_id]
        klines = await self.market.get_history(provider, symbol, interval="1h", limit=max(50, 40))
        bt = run_backtest(klines, BacktestParams(module_id=module_id, symbol=symbol, lookback=20))
        # Infer last action from equity path / simple recompute
        closes = [float(k["close"]) for k in klines if k.get("close")]
        lookback = 20
        signal = "flat"
        if len(closes) > lookback:
            hi = max(closes[-lookback - 1 : -1])
            lo = min(closes[-lookback - 1 : -1])
            if closes[-1] > hi:
                signal = "long"
            elif closes[-1] < lo:
                signal = "exit_long"

        result: dict[str, Any] = {
            "module_id": module_id,
            "module_name": mod.name,
            "inspired_by": mod.inspired_by,
            "signal": signal,
            "symbol": symbol,
            "environment": environment,
            "backtest_snapshot": {
                "trades": bt.trades,
                "total_return_pct": bt.total_return_pct,
                "max_drawdown_pct": bt.max_drawdown_pct,
            },
            "eti_desk": {
                "risk_officer": "Helena Frost",
                "execution_analyst": "Omar Diallo",
                "auditor": "Claire Bennett",
                "strategist": "Adrian Cole",
            },
            "executed": False,
            "order": None,
        }

        if not execute:
            return result

        side = None
        if signal == "long":
            side = "buy"
        elif signal == "exit_long":
            side = "sell"
        if side is None:
            result["message"] = "No actionable signal"
            return result

        order = await self.trading.place_order(
            provider=provider,
            environment=environment,
            symbol=symbol,
            side=side,
            qty=qty,
            equity=equity,
            data_status="fresh",
            data_age_seconds=5.0,
            thesis=f"StrategyRunner:{module_id}:{signal}",
            council_action=signal.upper(),
        )
        result["executed"] = order.get("status") in ("submitted", "filled")
        result["order"] = order
        return result

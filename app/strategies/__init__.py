"""ETI Elite Strategy Intelligence: 23 independent, configurable strategy modules with a shared cost-aware
backtester and an out-of-sample / walk-forward validation layer. Signals are research outputs only."""
from app.strategies.registry import STRATEGY_CLASSES, get_strategy, list_specs
from app.strategies.types import Bars, CostModel, MissingData, Plan, RiskModel, StrategySpec
from app.strategies.validation import CRITERIA, latest_signal, run_backtest, validate

__all__ = ["STRATEGY_CLASSES", "get_strategy", "list_specs", "Bars", "CostModel", "MissingData", "Plan", "RiskModel",
           "StrategySpec", "CRITERIA", "latest_signal", "run_backtest", "validate"]

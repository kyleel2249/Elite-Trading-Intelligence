"""Ordered registry of the 23 strategy modules (order follows the product specification)."""
from __future__ import annotations

from typing import Any

from app.strategies.base import Strategy
from app.strategies.modules.fundamental import CanSlim, EventDriven, GrowthInvesting, ValueInvesting
from app.strategies.modules.horizon import PositionTrading, SwingTrading
from app.strategies.modules.quant import MacroTrading, QuantitativeTrading, VolatilityTrading
from app.strategies.modules.reversion import Contrarian, MeanReversion, PairsTrading, Scalping, StatisticalArbitrage
from app.strategies.modules.structure import PriceAction, Wyckoff
from app.strategies.modules.trend import (Breakout, DarvasBox, Momentum, Pullback, TrendFollowing, Turtle,
                                          VolatilityContractionPattern)

_ORDER: list[type[Strategy]] = [
    TrendFollowing, Breakout, Pullback, Momentum, MeanReversion, SwingTrading, Scalping, PositionTrading,
    StatisticalArbitrage, PairsTrading, QuantitativeTrading, VolatilityTrading, MacroTrading, ValueInvesting,
    GrowthInvesting, Contrarian, Wyckoff, DarvasBox, CanSlim, VolatilityContractionPattern, Turtle, PriceAction, EventDriven,
]

STRATEGY_CLASSES: dict[str, type[Strategy]] = {cls.spec.id: cls for cls in _ORDER}
assert len(STRATEGY_CLASSES) == 23, "strategy library must contain exactly 23 modules"


def get_strategy(strategy_id: str, **params: Any) -> Strategy:
    cls = STRATEGY_CLASSES.get(strategy_id)
    if cls is None:
        raise KeyError(strategy_id)
    return cls(**params)


def list_specs() -> list[dict[str, Any]]:
    return [cls.spec.to_dict() for cls in STRATEGY_CLASSES.values()]

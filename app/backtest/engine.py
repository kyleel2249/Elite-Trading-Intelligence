"""Parameterized backtest + walk-forward hooks for strategy modules."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
import math
from typing import Any, Optional

from app.knowledge.strategies import STRATEGY_MODULES
from app.backtest.signals import (
    sma_trend_signals,
    breakout_signals,
    vcp_signals,
    wyckoff_signals,
)


@dataclass
class BacktestParams:
    module_id: str
    symbol: str = "BTCUSDT"
    lookback: int = 20
    risk_per_trade_pct: float = 1.0
    fee_bps: float = 5.0


@dataclass
class BacktestResult:
    module_id: str
    module_name: str
    inspired_by: list[str]
    symbol: str
    bars: int
    trades: int
    win_rate: Optional[float]
    total_return_pct: float
    max_drawdown_pct: float
    equity_curve: list[float]
    signal_model: str
    notes: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class WalkForwardResult:
    module_id: str
    folds: list[dict[str, Any]]
    aggregate_return_pct: float
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _positive_integer(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")


def _validate_params(params: BacktestParams) -> None:
    _positive_integer(params.lookback, "lookback")
    for name, value, upper in (
        ("risk_per_trade_pct", params.risk_per_trade_pct, 100),
        ("fee_bps", params.fee_bps, 10000),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
        if (name == "risk_per_trade_pct" and not 0 < value <= upper) or (
            name == "fee_bps" and not 0 <= value < upper
        ):
            raise ValueError(f"Invalid {name}")


def _closes(klines: list[dict[str, Any]]) -> list[float]:
    closes = []
    for bar in klines:
        try:
            value = float(bar["close"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Every bar must have a finite positive close") from exc
        if not math.isfinite(value) or value <= 0:
            raise ValueError("Every bar must have a finite positive close")
        closes.append(value)
    return closes


def _volumes(klines: list[dict[str, Any]]) -> list[float] | None:
    if all(bar.get("volume") is None for bar in klines):
        return None
    volumes = []
    for bar in klines:
        try:
            value = float(bar["volume"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Volume must be supplied for every bar or omitted entirely") from exc
        if not math.isfinite(value) or value < 0:
            raise ValueError("Volume must be finite and nonnegative")
        volumes.append(value)
    return volumes


def _signals_for_module(module_id: str, closes: list[float], volumes: list[float] | None, lookback: int) -> tuple[list[int], str, list[str]]:
    notes: list[str] = []
    if module_id == "minervini_vcp":
        return vcp_signals(closes, lookback=max(lookback, 30), volumes=volumes), "vcp_contraction_breakout", [
            "VCP proxy: contracting ranges then pivot break — educational, not full SEPA"
        ]
    if module_id == "wyckoff_supply_demand":
        return wyckoff_signals(closes, volumes, lookback=max(lookback, 40)), "wyckoff_spring_markup", [
            "Wyckoff proxy: spring/range break heuristics — phase labeling is simplified"
        ]
    if module_id in ("turtle_trend", "darvas_box", "oneil_canslim"):
        return breakout_signals(closes, lookback), "channel_breakout", []
    if module_id in ("seykota_mechanical", "ptj_structure_preservation"):
        return sma_trend_signals(closes, lookback), "sma_trend", []
    notes.append("Generic SMA trend proxy for this module")
    return sma_trend_signals(closes, lookback), "sma_trend_generic", notes


def run_backtest(
    klines: list[dict[str, Any]], params: BacktestParams, *, scoring_start_index: int = 0,
) -> BacktestResult:
    """Signals use closes through t; fills occur at t+1 close, never at t.

    Bars before scoring_start_index only warm up signals; the scored portfolio
    starts flat with 10,000 cash. The legacy risk parameter is capital allocation,
    not stop-loss risk sizing (this simulator does not model stops).
    """
    _validate_params(params)
    mod = STRATEGY_MODULES.get(params.module_id)
    if not mod:
        raise ValueError(f"Unknown module {params.module_id}")
    closes = _closes(klines)
    volumes = _volumes(klines)
    if not closes:
        raise ValueError("At least one bar is required")
    if (isinstance(scoring_start_index, bool) or not isinstance(scoring_start_index, int)
            or not 0 <= scoring_start_index < len(closes)):
        raise ValueError("scoring_start_index must identify a supplied bar")
    notes = [
        "Educational simulation on provided bars only",
        "Not a guarantee of live performance",
        f"Inspired by: {', '.join(mod.inspired_by)}",
        "Live/paper deployment must pass Helena Frost RiskEngine",
        "Omar Diallo executes; Claire Bennett journals",
        "Signals execute at the following bar close; final positions are liquidated with fees",
        "risk_per_trade_pct is percent capital allocation including entry fees, not stop-risk sizing",
        "Training bars warm up signals only; scoring starts flat",
    ]
    signals, signal_model, extra = _signals_for_module(params.module_id, closes, volumes, params.lookback)
    notes.extend(extra)
    cash = 10000.0
    equity = cash
    peak = equity
    max_dd = 0.0
    units = 0.0
    entry_cost = 0.0
    trades = wins = 0
    curve = [equity]
    fee = params.fee_bps / 10000.0
    allocation = params.risk_per_trade_pct / 100.0

    for i in range(scoring_start_index, len(closes)):
        px = closes[i]
        signal = signals[i - 1] if i > 0 else 0
        if units == 0 and signal == 1:
            entry_cost = cash * allocation
            units = entry_cost / (px * (1 + fee))
            cash -= entry_cost
        elif units > 0 and signal == -1:
            proceeds = units * px * (1 - fee)
            cash += proceeds
            trades += 1
            wins += proceeds > entry_cost
            units = 0.0
        if i == len(closes) - 1 and units > 0:
            proceeds = units * px * (1 - fee)
            cash += proceeds
            trades += 1
            wins += proceeds > entry_cost
            units = 0.0
        equity = cash + units * px
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / peak)
        curve.append(equity)

    total_ret = (equity / 10000.0 - 1) * 100
    win_rate = (wins / trades) if trades else None
    # Preserve the final liquidation point even for long sampled curves.
    stride = max(1, len(curve) // 50)
    sampled_curve = curve[::stride]
    if (len(curve) - 1) % stride:
        sampled_curve.append(curve[-1])

    return BacktestResult(
        module_id=params.module_id,
        module_name=mod.name,
        inspired_by=mod.inspired_by,
        symbol=params.symbol,
        bars=len(closes) - scoring_start_index,
        trades=trades,
        win_rate=win_rate,
        total_return_pct=round(total_ret, 4),
        max_drawdown_pct=round(max_dd * 100, 4),
        equity_curve=sampled_curve,
        signal_model=signal_model,
        notes=notes,
        params=asdict(params),
    )


def walk_forward(
    klines: list[dict[str, Any]],
    params: BacktestParams,
    train_bars: int = 80,
    test_bars: int = 20,
) -> WalkForwardResult:
    _validate_params(params)
    _positive_integer(train_bars, "train_bars")
    _positive_integer(test_bars, "test_bars")
    if params.module_id not in STRATEGY_MODULES:
        raise ValueError(f"Unknown module {params.module_id}")
    closes_n = len(_closes(klines))
    _volumes(klines)
    folds = []
    i = 0
    growth = 1.0
    while i + train_bars + test_bars <= closes_n:
        segment = klines[i : i + train_bars + test_bars]
        res = run_backtest(segment, params, scoring_start_index=train_bars)
        fold_return = res.equity_curve[-1] / 10000.0
        growth *= fold_return
        folds.append(
            {
                "start_index": i + train_bars,
                "end_index": i + train_bars + test_bars,
                "trades": res.trades,
                "return_pct": res.total_return_pct,
                "max_drawdown_pct": res.max_drawdown_pct,
                "signal_model": res.signal_model,
            }
        )
        i += test_bars
    return WalkForwardResult(
        module_id=params.module_id,
        folds=folds,
        aggregate_return_pct=round((growth - 1) * 100, 4),
        notes=[
            "Walk-forward sequential nonoverlapping test folds; training bars only warm up signals",
            "Each test fold starts flat and liquidates at its end; fold returns are compounded",
            "Not proof of future alpha",
            "Claire Bennett: journal live results separately",
            "Helena Frost: risk gates live path",
        ],
    )

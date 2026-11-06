"""Parameterized backtest + walk-forward hooks for strategy modules."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
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


def _closes(klines: list[dict[str, Any]]) -> list[float]:
    return [float(k["close"]) for k in klines if k.get("close") is not None]


def _volumes(klines: list[dict[str, Any]]) -> list[float] | None:
    if not klines or klines[0].get("volume") is None:
        return None
    try:
        return [float(k.get("volume") or 0) for k in klines]
    except Exception:
        return None


def _signals_for_module(module_id: str, closes: list[float], volumes: list[float] | None, lookback: int) -> tuple[list[int], str, list[str]]:
    notes: list[str] = []
    if module_id == "minervini_vcp":
        return vcp_signals(closes, lookback=max(lookback, 30)), "vcp_contraction_breakout", [
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


def run_backtest(klines: list[dict[str, Any]], params: BacktestParams) -> BacktestResult:
    mod = STRATEGY_MODULES.get(params.module_id)
    if not mod:
        raise ValueError(f"Unknown module {params.module_id}")

    closes = _closes(klines)
    volumes = _volumes(klines)
    notes = [
        "Educational simulation on provided bars only",
        "Not a guarantee of live performance",
        f"Inspired by: {', '.join(mod.inspired_by)}",
        "Live/paper deployment must pass Helena Frost RiskEngine",
        "Omar Diallo executes; Claire Bennett journals",
    ]

    signals, signal_model, extra = _signals_for_module(params.module_id, closes, volumes, params.lookback)
    notes.extend(extra)

    equity = 10000.0
    peak = equity
    max_dd = 0.0
    position = 0
    entry = 0.0
    trades = 0
    wins = 0
    curve = [equity]
    fee = params.fee_bps / 10000.0
    scale = min(max(params.risk_per_trade_pct, 0.1), 5.0) / 100.0  # fraction of equity moved per trade

    for i in range(1, len(closes)):
        px = closes[i]
        if position == 0 and signals[i] == 1:
            position = 1
            entry = px * (1 + fee)
            trades += 1
        elif position == 1 and signals[i] == -1:
            ret = (px * (1 - fee) - entry) / entry
            equity *= 1 + ret * (scale * 10)  # scale impact
            equity = max(equity, 1.0)
            if ret > 0:
                wins += 1
            position = 0
        peak = max(peak, equity)
        dd = (peak - equity) / peak if peak else 0
        max_dd = max(max_dd, dd)
        curve.append(equity)

    total_ret = (equity / 10000.0 - 1) * 100
    win_rate = (wins / trades) if trades else None

    return BacktestResult(
        module_id=params.module_id,
        module_name=mod.name,
        inspired_by=mod.inspired_by,
        symbol=params.symbol,
        bars=len(closes),
        trades=trades,
        win_rate=win_rate,
        total_return_pct=round(total_ret, 4),
        max_drawdown_pct=round(max_dd * 100, 4),
        equity_curve=curve[:: max(1, len(curve) // 50)],
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
    closes_n = len(_closes(klines))
    folds = []
    i = 0
    while i + train_bars + test_bars <= closes_n:
        segment = klines[i : i + train_bars + test_bars]
        window = segment[train_bars - params.lookback :] if train_bars > params.lookback else segment[train_bars:]
        res = run_backtest(window, params)
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
    agg = sum(f["return_pct"] for f in folds) if folds else 0.0
    return WalkForwardResult(
        module_id=params.module_id,
        folds=folds,
        aggregate_return_pct=round(agg, 4),
        notes=[
            "Walk-forward sequential folds",
            "Not proof of future alpha",
            "Claire Bennett: journal live results separately",
            "Helena Frost: risk gates live path",
        ],
    )

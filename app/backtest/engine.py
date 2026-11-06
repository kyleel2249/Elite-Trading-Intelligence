"""
Parameterized backtest + walk-forward hooks for strategy modules.
Paper-first; live path only via TradingService + RiskEngine (Helena Frost).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from app.knowledge.strategies import STRATEGY_MODULES, get_strategy_module


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


def _breakout_signals(closes: list[float], lookback: int) -> list[int]:
    """+1 long entry, -1 exit/flat signal stream (simple)."""
    sig = [0] * len(closes)
    for i in range(lookback, len(closes)):
        window = closes[i - lookback : i]
        hi, lo = max(window), min(window)
        if closes[i] > hi:
            sig[i] = 1
        elif closes[i] < lo:
            sig[i] = -1
    return sig


def _sma_trend_signals(closes: list[float], lookback: int) -> list[int]:
    sig = [0] * len(closes)
    for i in range(lookback, len(closes)):
        sma = sum(closes[i - lookback : i]) / lookback
        if closes[i] > sma:
            sig[i] = 1
        elif closes[i] < sma:
            sig[i] = -1
    return sig


def run_backtest(klines: list[dict[str, Any]], params: BacktestParams) -> BacktestResult:
    mod = STRATEGY_MODULES.get(params.module_id)
    if not mod:
        raise ValueError(f"Unknown module {params.module_id}")

    closes = _closes(klines)
    notes = [
        "Educational simulation on provided bars only",
        "Not a guarantee of live performance",
        f"Inspired by: {', '.join(mod.inspired_by)}",
        "Live/paper deployment must pass Helena Frost RiskEngine",
    ]

    # Route module family → signal style
    if params.module_id in ("turtle_trend", "darvas_box", "minervini_vcp", "oneil_canslim"):
        signals = _breakout_signals(closes, params.lookback)
    elif params.module_id in ("seykota_mechanical", "ptj_structure_preservation"):
        signals = _sma_trend_signals(closes, params.lookback)
    else:
        # Default: conservative SMA trend proxy
        signals = _sma_trend_signals(closes, params.lookback)
        notes.append("Module uses generic trend proxy — refine with module-specific features later")

    equity = 10000.0
    peak = equity
    max_dd = 0.0
    position = 0  # 0 flat, 1 long
    entry = 0.0
    trades = 0
    wins = 0
    curve = [equity]
    fee = params.fee_bps / 10000.0

    for i in range(1, len(closes)):
        px = closes[i]
        if position == 0 and signals[i] == 1:
            position = 1
            entry = px * (1 + fee)
            trades += 1
        elif position == 1 and signals[i] == -1:
            ret = (px * (1 - fee) - entry) / entry
            equity *= 1 + ret * (params.risk_per_trade_pct / 1.0)  # simplified
            # interpret risk_per_trade as scale — clamp impact
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
        equity_curve=curve[:: max(1, len(curve) // 50)],  # downsample
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
        # test on last test_bars only by slicing klines window
        test_slice = segment[train_bars:]
        # include a bit of history for lookback
        window = segment[train_bars - params.lookback :] if train_bars > params.lookback else test_slice
        res = run_backtest(window, params)
        folds.append(
            {
                "start_index": i + train_bars,
                "end_index": i + train_bars + test_bars,
                "trades": res.trades,
                "return_pct": res.total_return_pct,
                "max_drawdown_pct": res.max_drawdown_pct,
            }
        )
        i += test_bars
    agg = sum(f["return_pct"] for f in folds) if folds else 0.0
    return WalkForwardResult(
        module_id=params.module_id,
        folds=folds,
        aggregate_return_pct=round(agg, 4),
        notes=[
            "Walk-forward is sequential test folds on provided data",
            "Not proof of future alpha",
            "Claire Bennett: journal live results separately from backtests",
        ],
    )

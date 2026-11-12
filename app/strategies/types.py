"""Core types for the ETI strategy library."""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

NaN = float("nan")


class MissingData(Exception):
    """Raised when a strategy cannot be evaluated because required data is absent or invalid.
    The library never substitutes invented data: callers receive status 'blocked_missing_data'."""

    def __init__(self, strategy_id: str, missing: list[str], detail: str = ""):
        self.strategy_id = strategy_id
        self.missing = missing
        self.detail = detail
        super().__init__(f"{strategy_id}: missing {missing} {detail}".strip())


@dataclass
class Bars:
    """Columnar OHLCV series. `v` may be None when volume is unavailable."""
    c: list[float]
    o: list[float]
    h: list[float]
    l: list[float]
    v: Optional[list[float]] = None
    t: Optional[list[Any]] = None
    ohlc_complete: bool = True
    symbol: str = ""
    interval: str = ""

    def __len__(self) -> int:
        return len(self.c)

    @classmethod
    def from_closes(cls, closes: list[float], volumes: Optional[list[float]] = None, **kw) -> "Bars":
        """Close-only data: OHLC is NOT complete; strategies needing true OHLC will refuse."""
        return cls(c=list(closes), o=list(closes), h=list(closes), l=list(closes), v=volumes, ohlc_complete=False, **kw)

    @classmethod
    def from_klines(cls, klines: list[dict[str, Any]], symbol: str = "", interval: str = "",
                    drop_unfinished: bool = True, now_ms: Optional[float] = None) -> "Bars":
        """Build from ETI normalised klines. Invalid candles are dropped, never repaired; the
        still-forming last candle is dropped so signals cannot repaint."""
        now_ms = now_ms if now_ms is not None else time.time() * 1000
        rows = []
        for k in klines:
            try:
                if k.get("quality_issues"):
                    continue
                o, h, l, c = (float(k[x]) for x in ("open", "high", "low", "close"))
                if min(o, h, l, c) <= 0 or any(math.isnan(x) for x in (o, h, l, c)):
                    continue
                ct = k.get("close_time")
                if drop_unfinished and ct is not None and float(ct) > now_ms:
                    continue
                vol = k.get("volume")
                rows.append((k.get("open_time", ct), o, h, l, c, None if vol is None else float(vol)))
            except (KeyError, TypeError, ValueError):
                continue
        has_vol = bool(rows) and all(r[5] is not None for r in rows)
        return cls(c=[r[4] for r in rows], o=[r[1] for r in rows], h=[r[2] for r in rows], l=[r[3] for r in rows],
                   v=[r[5] for r in rows] if has_vol else None, t=[r[0] for r in rows], ohlc_complete=True,
                   symbol=symbol, interval=interval)

    def subset(self, idx: list[int]) -> "Bars":
        pick = lambda xs: None if xs is None else [xs[i] for i in idx]
        return Bars(c=pick(self.c), o=pick(self.o), h=pick(self.h), l=pick(self.l), v=pick(self.v), t=pick(self.t),
                    ohlc_complete=self.ohlc_complete, symbol=self.symbol, interval=self.interval)

    def window_ts(self) -> tuple[Any, Any]:
        if not self.t:
            return None, None
        return self.t[0], self.t[-1]


@dataclass
class CostModel:
    """All values are per side, in basis points of traded notional."""
    fee_bps: float = 5.0
    slippage_bps: float = 2.0
    half_spread_bps: float = 1.0
    short_carry_bps_per_bar: float = 0.0
    long_carry_bps_per_bar: float = 0.0

    @property
    def per_side_bps(self) -> float:
        return self.fee_bps + self.slippage_bps + self.half_spread_bps

    def scaled(self, k: float) -> "CostModel":
        return CostModel(self.fee_bps * k, self.slippage_bps * k, self.half_spread_bps * k,
                         self.short_carry_bps_per_bar * k, self.long_carry_bps_per_bar * k)


@dataclass
class RiskModel:
    initial_equity: float = 10_000.0
    risk_pct: float = 1.0          # % of equity risked between entry and initial stop
    max_leverage: float = 1.0      # notional cap as a multiple of equity (no leverage by default)


@dataclass
class Plan:
    """What a strategy wants to do, computed causally. Index i refers to the CLOSE of bar i;
    the engine acts on the OPEN of bar i+1 (no look-ahead)."""
    mode: str = "trade"                                   # "trade" | "exposure"
    # trade mode
    signal: list[int] = field(default_factory=list)       # +1 enter long, -1 enter short, 0 none
    exit_signal: list[bool] = field(default_factory=list) # close any open position
    stop_dist: list[float] = field(default_factory=list)  # price distance from entry to initial stop
    take_profit_r: Optional[float] = None
    trail: bool = False
    max_hold: Optional[int] = None
    reverse: bool = False
    # exposure mode
    exposure: list[float] = field(default_factory=list)   # target exposure in [-1, 1] set at close i
    asset_returns: Optional[list[float]] = None           # return series the exposure earns (default: close returns)
    cost_multiplier: float = 1.0                          # e.g. 2 for two-leg pairs trades
    notes: list[str] = field(default_factory=list)


@dataclass
class StrategySpec:
    id: str
    name: str
    family: str
    summary: str
    timeframe: str
    required_data: list[str]
    entry_rules: list[str]
    exit_rules: list[str]
    stop_loss: str
    position_sizing: str
    expected_costs: dict[str, Any]
    known_weaknesses: list[str]
    params_default: dict[str, Any]
    param_grid: dict[str, list[Any]]
    mode: str = "trade"
    supports_short: bool = False
    fidelity: str = "full"            # full | proxy | partial  (how faithfully the named method is implemented)
    fidelity_note: str = ""
    required_aux: list[str] = field(default_factory=list)
    legacy_modules: list[str] = field(default_factory=list)  # related ids in app.knowledge.strategies
    default_interval: str = "1h"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

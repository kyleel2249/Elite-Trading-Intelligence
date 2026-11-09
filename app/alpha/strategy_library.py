"""Executable strategy modules extracted from publicly documented principles.

Honesty rules:
- Modules are 'inspired by' documented, public principles. They are NOT the
  private systems of the named investors and are never presented as such.
- A module that cannot be tested from price/volume alone is registered with
  executable=False and the data it needs; it is never given a fake backtest.
- Signals use only data up to bar i (the simulator fills on the next bar's open).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Sequence

from app.alpha.features import ema_series

Bars = Sequence[dict[str, Any]]
SignalFn = Callable[[Bars, dict[str, Any]], list[int]]
ALL_CLASSES = ("equity", "etf", "crypto", "forex", "commodity")


def _col(bars: Bars, k: str) -> list[float]:
    return [float(b.get(k) or 0.0) for b in bars]


def _sma(v: Sequence[float], n: int, i: int) -> Optional[float]:
    return sum(v[i - n + 1:i + 1]) / n if i >= n - 1 else None


def _hold(entry: list[bool], exit_: list[bool]) -> list[int]:
    pos, out = 0, []
    for e, x in zip(entry, exit_):
        if pos == 0 and e:
            pos = 1
        elif pos == 1 and x:
            pos = 0
        out.append(pos)
    return out


def sig_donchian(bars: Bars, p: dict[str, Any]) -> list[int]:
    n_in, n_out = p.get("entry", 20), p.get("exit", 10)
    h, l, c = _col(bars, "high"), _col(bars, "low"), _col(bars, "close")
    e = [i > n_in and c[i] > max(h[i - n_in:i]) for i in range(len(c))]
    x = [i > n_out and c[i] < min(l[i - n_out:i]) for i in range(len(c))]
    return _hold(e, x)


def sig_ema_trend(bars: Bars, p: dict[str, Any]) -> list[int]:
    fast, slow = p.get("fast", 20), p.get("slow", 50)
    c = _col(bars, "close")
    ef, es = ema_series(c, fast), ema_series(c, slow)
    e = [i >= slow and ef[i] > es[i] and c[i] > ef[i] for i in range(len(c))]
    x = [i >= slow and ef[i] < es[i] for i in range(len(c))]
    return _hold(e, x)


def sig_trend_template(bars: Bars, p: dict[str, Any]) -> list[int]:
    c = _col(bars, "close")
    n = len(c)
    e, x = [False] * n, [False] * n
    for i in range(251, n):
        s50, s150, s200 = _sma(c, 50, i), _sma(c, 150, i), _sma(c, 200, i)
        s200_prev = _sma(c, 200, i - 20)
        lo, hi = min(c[i - 251:i + 1]), max(c[i - 251:i + 1])
        e[i] = bool(c[i] > s150 and c[i] > s200 and s150 > s200 and s200 > s200_prev and s50 > s150
                    and c[i] > s50 and c[i] >= 1.25 * lo and c[i] >= 0.75 * hi)
        x[i] = c[i] < s50
    return _hold(e, x)


def sig_vcp(bars: Bars, p: dict[str, Any]) -> list[int]:
    lb = p.get("lookback", 30)
    c, l, v = _col(bars, "close"), _col(bars, "low"), _col(bars, "volume")
    n = len(c)
    e, x = [False] * n, [False] * n
    t = lb // 3
    for i in range(lb + 1, n):
        seg = c[i - lb:i]
        r1, r2, r3 = (max(seg[:t]) - min(seg[:t]), max(seg[t:2 * t]) - min(seg[t:2 * t]), max(seg[2 * t:]) - min(seg[2 * t:]))
        contracted = r1 > 0 and r3 < r2 < r1 * 0.85
        avg_v = sum(v[i - lb:i]) / lb
        e[i] = contracted and c[i] > max(seg) and v[i] > 1.1 * avg_v
        x[i] = i > 10 and c[i] < min(l[i - 10:i])
    return _hold(e, x)


def sig_darvas(bars: Bars, p: dict[str, Any]) -> list[int]:
    look = p.get("lookback", 40)
    h, l, c = _col(bars, "high"), _col(bars, "low"), _col(bars, "close")
    n = len(c)
    pos, bottom, out = 0, 0.0, []
    for i in range(n):
        if pos == 0 and i > look + 3:
            top = max(h[i - look:i - 3])
            confirmed = max(h[i - 3:i]) <= top  # three days failed to exceed the top: box is set
            box_bottom = min(l[i - 3:i])
            if confirmed and c[i] > top:
                pos, bottom = 1, box_bottom
        elif pos == 1 and c[i] < bottom:
            pos = 0
        out.append(pos)
    return out


def sig_wyckoff_spring(bars: Bars, p: dict[str, Any]) -> list[int]:
    lb = p.get("lookback", 40)
    c, v, l = _col(bars, "close"), _col(bars, "volume"), _col(bars, "low")
    n = len(c)
    e, x = [False] * n, [False] * n
    for i in range(lb + 5, n):
        rng_lo = min(l[i - lb:i - 5])
        spring = min(l[i - 5:i]) < rng_lo and c[i] > rng_lo  # undercut then recovered
        avg_v = sum(v[i - lb:i]) / lb
        e[i] = spring and v[i] >= avg_v * 0.8
        x[i] = c[i] < rng_lo * 0.98
    return _hold(e, x)


def sig_pivotal_breakout(bars: Bars, p: dict[str, Any]) -> list[int]:
    nb, vm = p.get("lookback", 40), p.get("vol_mult", 1.5)
    c, h, v = _col(bars, "close"), _col(bars, "high"), _col(bars, "volume")
    n = len(c)
    e, x = [False] * n, [False] * n
    for i in range(nb + 1, n):
        e[i] = c[i] > max(h[i - nb:i]) and v[i] >= vm * (sum(v[i - 20:i]) / 20)
        s20 = _sma(c, 20, i)
        x[i] = s20 is not None and c[i] < s20
    return _hold(e, x)


def sig_base_breakout(bars: Bars, p: dict[str, Any]) -> list[int]:
    """Technical leg only: base breakout on volume >= 1.4x average. No fundamentals."""
    base = p.get("base", 30)
    c, h, v = _col(bars, "close"), _col(bars, "high"), _col(bars, "volume")
    n = len(c)
    e, x = [False] * n, [False] * n
    for i in range(base + 1, n):
        pivot = max(h[i - base:i])
        e[i] = c[i] > pivot and c[i] <= pivot * 1.05 and v[i] >= 1.4 * (sum(v[i - 50:i]) / 50 if i >= 50 else sum(v[:i]) / i)
        x[i] = c[i] < pivot * 0.92 or (i > 0 and _sma(c, 50, i) is not None and c[i] < _sma(c, 50, i))
    return _hold(e, x)


def sig_vol_expansion(bars: Bars, p: dict[str, Any]) -> list[int]:
    k, hold_n = p.get("k", 0.6), p.get("hold", 3)
    o, h, l, c = _col(bars, "open"), _col(bars, "high"), _col(bars, "low"), _col(bars, "close")
    out, held = [], 0
    for i in range(len(c)):
        if held > 0:
            held -= 1
            out.append(1 if held > 0 and c[i] >= l[i - 1] else 0)
            if out[-1] == 0:
                held = 0
            continue
        trig = i > 0 and c[i] > o[i] + k * (h[i - 1] - l[i - 1])
        if trig:
            held = hold_n
            out.append(1)
        else:
            out.append(0)
    return out


def _adx(bars: Bars, n: int = 14) -> tuple[list[float], list[float], list[float]]:
    h, l, c = _col(bars, "high"), _col(bars, "low"), _col(bars, "close")
    L = len(c)
    pdm, mdm, tr = [0.0] * L, [0.0] * L, [0.0] * L
    for i in range(1, L):
        up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
        pdm[i] = up if up > dn and up > 0 else 0.0
        mdm[i] = dn if dn > up and dn > 0 else 0.0
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    adx, pdi, mdi = [0.0] * L, [0.0] * L, [0.0] * L
    if L <= 2 * n:
        return adx, pdi, mdi
    atr_s, p_s, m_s = sum(tr[1:n + 1]), sum(pdm[1:n + 1]), sum(mdm[1:n + 1])
    dx = [0.0] * L
    for i in range(n, L):
        if i > n:
            atr_s = atr_s - atr_s / n + tr[i]
            p_s = p_s - p_s / n + pdm[i]
            m_s = m_s - m_s / n + mdm[i]
        pdi[i] = 100 * p_s / atr_s if atr_s else 0.0
        mdi[i] = 100 * m_s / atr_s if atr_s else 0.0
        s = pdi[i] + mdi[i]
        dx[i] = 100 * abs(pdi[i] - mdi[i]) / s if s else 0.0
    adx[2 * n - 1] = sum(dx[n:2 * n]) / n
    for i in range(2 * n, L):
        adx[i] = (adx[i - 1] * (n - 1) + dx[i]) / n
    return adx, pdi, mdi


def sig_trend_pullback(bars: Bars, p: dict[str, Any]) -> list[int]:
    """Strong-trend pullback to the 20 EMA (ADX>thr, +DI>-DI), exit on swing high or EMA failure."""
    thr = p.get("adx", 30)
    c, l, h = _col(bars, "close"), _col(bars, "low"), _col(bars, "high")
    adx, pdi, mdi = _adx(bars)
    e20 = ema_series(c, 20)
    n = len(c)
    e, x = [False] * n, [False] * n
    for i in range(30, n):
        e[i] = adx[i] > thr and pdi[i] > mdi[i] and l[i] <= e20[i] and c[i] > e20[i]
        x[i] = c[i] > max(h[i - 10:i]) or c[i] < e20[i] * 0.97
    return _hold(e, x)


def sig_ma200(bars: Bars, p: dict[str, Any]) -> list[int]:
    n_ma = p.get("ma", 200)
    c = _col(bars, "close")
    out = []
    for i in range(len(c)):
        s = _sma(c, n_ma, i)
        out.append(1 if s is not None and c[i] > s else 0)
    return out


def sig_zscore_reversion(bars: Bars, p: dict[str, Any]) -> list[int]:
    lb, z_in = p.get("lookback", 20), p.get("z_in", -2.0)
    c = _col(bars, "close")
    n = len(c)
    e, x = [False] * n, [False] * n
    for i in range(max(lb, 100), n):
        w = c[i - lb + 1:i + 1]
        mu = sum(w) / lb
        sd = (sum((a - mu) ** 2 for a in w) / lb) ** 0.5
        z = (c[i] - mu) / sd if sd else 0.0
        e[i] = z < z_in and c[i] > _sma(c, 100, i) * 0.9
        x[i] = z > 0
    return _hold(e, x)


@dataclass
class Strategy:
    id: str
    name: str
    inspired_by: list[str]
    family: str
    source_basis: str  # what public principle this encodes
    asset_classes: tuple[str, ...] = ALL_CLASSES
    timeframes: tuple[str, ...] = ("1d",)
    regimes: tuple[str, ...] = ("trend_up",)
    min_bars: int = 120
    executable: bool = True
    fidelity: str = "price_rules_only"
    signal: Optional[SignalFn] = None
    param_grid: list[dict[str, Any]] = field(default_factory=lambda: [{}])
    requires_data: list[str] = field(default_factory=list)
    evaluator: Optional[str] = None  # live (non-backtested) evaluator implemented in ETI, if any
    caveats: list[str] = field(default_factory=list)
    unsuited: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "inspired_by": self.inspired_by, "family": self.family,
                "source_basis": self.source_basis, "asset_classes": list(self.asset_classes),
                "timeframes": list(self.timeframes), "preferred_regimes": list(self.regimes),
                "min_bars": self.min_bars, "executable": self.executable, "fidelity": self.fidelity, "evaluator": self.evaluator,
                "param_grid": self.param_grid, "requires_data": self.requires_data,
                "caveats": self.caveats, "unsuited_for": self.unsuited}


_GENERIC = "Inspired by publicly documented principles; not the investor's private system."
LIBRARY: dict[str, Strategy] = {}


def _reg(s: Strategy) -> None:
    LIBRARY[s.id] = s


_reg(Strategy("turtle_donchian", "Donchian Channel Trend Breakout", ["Richard Dennis", "William Eckhardt", "John W. Henry"], "trend",
              "Published Turtle-style channel breakout: enter on N-bar high, exit on shorter-N low", regimes=("trend_up",),
              signal=sig_donchian, param_grid=[{"entry": 20, "exit": 10}, {"entry": 55, "exit": 20}],
              caveats=[_GENERIC, "Long-only spot variant; no futures shorting or portfolio-level unit sizing"],
              unsuited=["range-bound markets (whipsaw)"]))
_reg(Strategy("seykota_ema", "EMA Trend Follower", ["Ed Seykota", "Tom Basso"], "trend",
              "Mechanical moving-average trend following with fixed exits", regimes=("trend_up",), signal=sig_ema_trend,
              param_grid=[{"fast": 20, "slow": 50}, {"fast": 10, "slow": 30}], caveats=[_GENERIC, "Seykota's exact parameters are not public; EMAs here are ETI's choice"]))
_reg(Strategy("minervini_trend_template", "Stage-2 Trend Template", ["Mark Minervini"], "momentum",
              "Published trend-template criteria: price above rising 150/200 SMA, 50>150>200, 25% off low, within 25% of high",
              asset_classes=("equity", "etf", "crypto"), regimes=("trend_up",), min_bars=260, signal=sig_trend_template,
              caveats=[_GENERIC, "Technical leg only; SEPA also uses earnings/growth fundamentals not tested here"], fidelity="technical_leg_only"))
_reg(Strategy("minervini_vcp", "Volatility Contraction Breakout", ["Mark Minervini"], "momentum",
              "Successively tighter ranges then a pivot breakout on expanding volume", asset_classes=("equity", "etf", "crypto"),
              signal=sig_vcp, param_grid=[{"lookback": 30}, {"lookback": 45}], fidelity="technical_leg_only",
              caveats=[_GENERIC, "Contraction detection is a simplified proxy"]))
_reg(Strategy("darvas_box", "Darvas Box Breakout", ["Nicolas Darvas"], "momentum",
              "Buy when price closes above a confirmed consolidation-box top; exit below box bottom", signal=sig_darvas,
              param_grid=[{"lookback": 40}, {"lookback": 60}], caveats=[_GENERIC, "Box confirmation is a 3-bar simplification"]))
_reg(Strategy("wyckoff_spring", "Wyckoff Spring / Accumulation", ["Richard Wyckoff"], "structure",
              "Undercut of a trading-range low that quickly recovers (spring) with supportive volume",
              regimes=("range", "trend_up"), signal=sig_wyckoff_spring, param_grid=[{"lookback": 40}, {"lookback": 60}],
              caveats=[_GENERIC, "Phase labelling is simplified; discretionary tape reading is not encoded"]))
_reg(Strategy("livermore_pivot", "Pivotal-Point Breakout on Volume", ["Jesse Livermore"], "momentum",
              "Enter on a break of a prior N-bar extreme confirmed by volume; exit on loss of the 20-bar mean", signal=sig_pivotal_breakout,
              param_grid=[{"lookback": 40, "vol_mult": 1.5}, {"lookback": 60, "vol_mult": 1.5}],
              caveats=[_GENERIC, "Livermore's discretionary tape reading is not mechanically specified"]))
_reg(Strategy("oneil_base_breakout", "Base Breakout on Volume (technical leg of CAN SLIM)", ["William O'Neil"], "momentum",
              "Buy base breakouts within 5% of pivot on volume >= ~40% above average; 7-8% loss discipline",
              asset_classes=("equity", "etf"), min_bars=150, signal=sig_base_breakout, param_grid=[{"base": 30}, {"base": 45}],
              fidelity="technical_leg_only", requires_data=["quarterly earnings growth", "annual EPS growth", "institutional sponsorship"],
              caveats=[_GENERIC, "Without earnings data this is NOT CAN SLIM; it tests only the breakout leg"]))
_reg(Strategy("williams_vol_expansion", "Volatility-Expansion Close", ["Larry Williams"], "short_term",
              "Strong close beyond a fraction of the prior range signals short-term expansion; short fixed hold",
              regimes=("trend_up", "high_vol"), signal=sig_vol_expansion, param_grid=[{"k": 0.6, "hold": 3}, {"k": 0.8, "hold": 3}],
              caveats=[_GENERIC, "Williams' original uses intraday open-plus-range entries; this daily-close variant is an approximation"]))
_reg(Strategy("raschke_trend_pullback", "ADX Trend Pullback (Holy Grail-style)", ["Linda Bradford Raschke"], "short_term",
              "Pullback to the 20 EMA inside a strong ADX trend, exit on swing high or EMA failure", signal=sig_trend_pullback,
              param_grid=[{"adx": 30}, {"adx": 25}], regimes=("trend_up",), min_bars=80,
              caveats=[_GENERIC, "Long side only"]))
_reg(Strategy("ptj_200dma", "200-Period Moving Average Risk Rule", ["Paul Tudor Jones"], "risk_rule",
              "Publicly cited rule: be defensive when price is below its 200-day average", signal=sig_ma200, min_bars=220,
              param_grid=[{"ma": 200}, {"ma": 150}], regimes=("trend_up",),
              caveats=[_GENERIC, "Jones' broader discretionary process is not encoded"]))
_reg(Strategy("stat_zscore_reversion", "Statistical Mean-Reversion Baseline", ["generic quantitative baseline"], "quant",
              "Generic z-score reversion with a trend-health filter. Medallion/D.E. Shaw/Thorp methods are not public and are NOT replicated",
              regimes=("range",), signal=sig_zscore_reversion, param_grid=[{"lookback": 20, "z_in": -2.0}, {"lookback": 30, "z_in": -2.0}],
              min_bars=140, unsuited=["strong breakouts and trending-down markets"],
              caveats=["Named quant investors have no public executable rules; this is a baseline, not attribution"]))

_NEEDS: list[tuple[str, str, list[str], str, list[str], str]] = [
    ("soros_reflexivity_macro", "Reflexivity / Macro Imbalance", ["George Soros"], "macro",
     ["macro series (rates, FX, credit)", "positioning data", "price trend"], "Boom-bust feedback between prices and fundamentals"),
    ("druck_liquidity_regime", "Liquidity Regime & Concentration", ["Stanley Druckenmiller"], "macro",
     ["central-bank balance sheet / policy rate", "liquidity proxy (M2, financial conditions)", "earnings trend"], "Liquidity direction drives asset prices"),
    ("dalio_cycle_balance", "Debt-Cycle & Risk-Balance Framework", ["Ray Dalio"], "macro",
     ["debt/GDP", "policy rates", "inflation and growth data"], "Economic and debt cycles; diversification across uncorrelated streams"),
    ("kovner_macro_catalyst", "Global Macro with Catalyst Discipline", ["Bruce Kovner"], "macro",
     ["rates, FX, commodity fundamentals", "event calendar"], "Macro catalysts with strict risk limits"),
    ("lien_fx_rates", "FX Rate-Differential & Central-Bank Framework", ["Kathy Lien"], "macro",
     ["policy-rate paths", "FX prices", "economic calendar"], "Interest-rate and central-bank policy drive currencies"),
    ("buffett_quality_value", "Quality at a Reasonable Price", ["Warren Buffett", "Charlie Munger"], "value",
     ["audited financial statements", "multi-year ROIC/ROE", "debt", "free cash flow", "valuation multiples"], "Durable advantage, capital allocation, margin of safety"),
    ("lynch_garp", "Growth at a Reasonable Price", ["Peter Lynch"], "value",
     ["earnings growth", "P/E and PEG", "balance sheet"], "Understandable growth businesses; PEG discipline"),
    ("templeton_global_contrarian", "Global Contrarian Value", ["John Templeton"], "value",
     ["valuation across markets", "sentiment extremes"], "Maximum pessimism and global value dispersion"),
    ("burry_deep_value", "Contrarian Statement Analysis", ["Michael Burry"], "value",
     ["financial statements", "short interest", "credit data"], "Fundamental mispricing found by statement research"),
    ("special_situations", "Special Situations & Distressed Credit", ["John Paulson", "David Tepper", "Howard Marks"], "event",
     ["credit spreads", "restructuring/event filings", "capital-structure data"], "Event-driven and credit-cycle opportunities"),
    ("activist_concentration", "Activist / Concentrated Fundamentals", ["Chris Hohn", "David Einhorn", "Julian Robertson", "Michael Steinhardt"], "value",
     ["13D/13F filings", "financial statements", "catalyst timeline"], "Concentrated fundamental research with identifiable catalysts"),
]
for sid, nm, who, fam, data, basis in _NEEDS:
    _reg(Strategy(sid, nm, who, fam, basis, executable=False, fidelity="requires_external_data", requires_data=data,
                  timeframes=("1d", "1w"), regimes=("any",), asset_classes=("equity", "etf", "forex", "commodity", "crypto") if fam == "macro" else ("equity", "etf"),
                  caveats=[_GENERIC, "Not backtestable from OHLCV; no simulated performance is reported"]))


LIVE_EVALUATORS = {
    "buffett_quality_value": ("app.alpha.fundamentals.quality_screen", "live screen on SEC XBRL (needs no external key); NOT a backtest"),
    "lynch_garp": ("app.alpha.fundamentals.garp_screen", "live PEG screen on SEC XBRL EPS and current price; NOT a backtest"),
    "druck_liquidity_regime": ("app.alpha.macro.liquidity_regime", "live liquidity regime from FRED (needs FRED_API_KEY); NOT a backtest"),
    "dalio_cycle_balance": ("app.alpha.macro.growth_inflation_quadrant", "live growth x inflation proxy from FRED; NOT a backtest"),
    "special_situations": ("app.alpha.macro.credit_cycle", "credit-cycle leg only (HY spread percentile); event/distressed legs remain unimplemented"),
}
for _sid, (_fn, _note) in LIVE_EVALUATORS.items():
    LIBRARY[_sid].evaluator = _fn
    LIBRARY[_sid].caveats.append(_note)


def kelly_fraction(win_rate: float, avg_win: float, avg_loss: float, cap: float = 0.25, fraction: float = 0.5) -> float:
    """Fractional Kelly (Thorp-style sizing). Returns 0 when the edge is non-positive."""
    if avg_loss <= 0 or avg_win <= 0 or not 0 < win_rate < 1:
        return 0.0
    b = avg_win / avg_loss
    k = win_rate - (1 - win_rate) / b
    return max(0.0, min(cap, k * fraction))


def executable_ids() -> list[str]:
    return [k for k, v in LIBRARY.items() if v.executable]

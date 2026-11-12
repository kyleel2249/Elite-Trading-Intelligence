"""Fundamental / event modules. They NEVER run without caller-supplied, point-in-time data."""
from __future__ import annotations

import math
from typing import Any

from app.strategies import indicators as ind
from app.strategies.base import Strategy, ok, vol_ratio
from app.strategies.types import Bars, MissingData, Plan, StrategySpec

NaN = float("nan")
_COST = {"fee_bps_per_side": 5.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 2.0,
         "note": "Equity-like defaults (commission-free broker, wider spread). Override CostModel for your market."}
_PIT = ("Fundamental series must be POINT-IN-TIME: each value is the figure as first reported and only from the bar on which it became public, "
        "aligned one value per bar (None before the first release). Restated/latest values leak the future and invalidate results.")


def _fund(strategy: Strategy, aux, n: int, need: list[str]) -> dict[str, list]:
    a = strategy.require_aux(aux, ["fundamentals"], n); f = a["fundamentals"]
    if not isinstance(f, dict): raise MissingData(strategy.spec.id, ["fundamentals"], "must be {name: aligned list}")
    miss = [k for k in need if k not in f]
    if miss: raise MissingData(strategy.spec.id, [f"fundamentals.{k}" for k in miss], _PIT)
    return f


class ValueInvesting(Strategy):
    spec = StrategySpec(
        id="fundamental_value", name="Fundamental Value Investing", family="fundamental",
        summary="Own quality businesses when their earnings yield sits in the top of its own history and leverage is modest; exit when the valuation normalises or quality breaks.",
        timeframe="1d-1w; holds months to years", required_data=["close", "point-in-time earnings_yield, roe, net_debt_to_ebitda aligned to bars", _PIT],
        entry_rules=["earnings_yield percent-rank over pct_win bars >= pct_entry", "roe >= roe_min", "net_debt_to_ebitda <= max_leverage"],
        exit_rules=["earnings_yield percent-rank < pct_exit (valuation normalised)", "roe < roe_min or leverage breach", "Catastrophic stop"],
        stop_loss="Catastrophic stop at stop_pct below entry (a value thesis needs room; the stop caps thesis-wrong losses)",
        position_sizing="risk_pct / (stop_pct x price): at 1% risk and a 25% stop a position is ~4% of equity", expected_costs=_COST,
        known_weaknesses=["Value traps: cheap for a reason", "Can underperform for many years (value drawdowns are long)", "Accounting data are noisy, lagged and restated", "Single-asset testing says little about a diversified value portfolio", "Needs many years of data: the 1000-bar API limit is too short for meaningful validation"],
        params_default={"pct_win": 500, "pct_entry": 0.8, "pct_exit": 0.5, "roe_min": 0.12, "max_leverage": 3.0, "stop_pct": 0.25},
        param_grid={"pct_entry": [0.7, 0.8, 0.9], "stop_pct": [0.2, 0.3]}, required_aux=["fundamentals"], legacy_modules=["buffett_munger_value", "lynch_fundamental"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        n = len(bars); p = self.params; f = _fund(self, aux, n, ["earnings_yield", "roe", "net_debt_to_ebitda"])
        ey = [x if x is not None else NaN for x in f["earnings_yield"]]; pr = ind.percent_rank(ey, p["pct_win"])
        pl = self.empty_trade_plan(n)
        for i in range(n):
            roe, lev = f["roe"][i], f["net_debt_to_ebitda"][i]
            if not ok(pr[i], roe, lev): continue
            if pr[i] >= p["pct_entry"] and roe >= p["roe_min"] and lev <= p["max_leverage"]: pl.signal[i] = 1
            pl.stop_dist[i] = p["stop_pct"] * bars.c[i]
            pl.exit_signal[i] = pr[i] < p["pct_exit"] or roe < p["roe_min"] or lev > p["max_leverage"]
        return pl


class GrowthInvesting(Strategy):
    spec = StrategySpec(
        id="growth_investing", name="Growth Investing (accelerating growth + trend)", family="fundamental",
        summary="Own companies with high and accelerating revenue/earnings growth while the price trend confirms (avoid growth traps).",
        timeframe="1d-1w; holds months", required_data=["close", "point-in-time revenue_growth_yoy, eps_growth_yoy (fractions) aligned to bars", _PIT],
        entry_rules=["revenue_growth_yoy >= rev_min and eps_growth_yoy >= eps_min", "eps_growth_yoy now > eps_growth_yoy `accel_lag` bars ago (acceleration)", "close > SMA(200)"],
        exit_rules=["revenue_growth_yoy < rev_exit", "close < SMA(200)", "Stop"], stop_loss="stop_pct below entry", position_sizing="risk_pct / (stop_pct x price)", expected_costs=_COST,
        known_weaknesses=["Valuation-insensitive: growth stocks can fall 50%+ on multiple compression", "Growth estimates/reports are revised and gamed", "Concentrated in factor/sector cycles", "Single-asset sample is tiny"],
        params_default={"rev_min": 0.20, "eps_min": 0.15, "accel_lag": 63, "rev_exit": 0.10, "stop_pct": 0.20}, param_grid={"rev_min": [0.15, 0.25], "stop_pct": [0.15, 0.25]},
        required_aux=["fundamentals"], legacy_modules=["lynch_fundamental", "oneil_canslim"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        n = len(bars); p = self.params; f = _fund(self, aux, n, ["revenue_growth_yoy", "eps_growth_yoy"]); t = ind.sma(bars.c, 200); pl = self.empty_trade_plan(n)
        rg, eg = f["revenue_growth_yoy"], f["eps_growth_yoy"]
        for i in range(p["accel_lag"], n):
            if not ok(rg[i], eg[i], eg[i - p["accel_lag"]], t[i]): continue
            if rg[i] >= p["rev_min"] and eg[i] >= p["eps_min"] and eg[i] > eg[i - p["accel_lag"]] and bars.c[i] > t[i]: pl.signal[i] = 1
            pl.stop_dist[i] = p["stop_pct"] * bars.c[i]
            pl.exit_signal[i] = rg[i] < p["rev_exit"] or bars.c[i] < t[i]
        return pl


class CanSlim(Strategy):
    spec = StrategySpec(
        id="can_slim", name="CAN SLIM (testable components)", family="fundamental",
        summary="Buy leaders breaking out of a base on heavy volume in a healthy market, with strong quarterly earnings growth when supplied.",
        timeframe="1d", required_data=["OHLC", "volume", "aligned benchmark_close (market direction + relative strength)", "optional point-in-time fundamentals: eps_growth_yoy (C), annual_eps_growth (A)", _PIT],
        entry_rules=["C: eps_growth_yoy >= eps_min (if fundamentals supplied)", "A: annual_eps_growth >= eps_min (if supplied)", "N: close > prior 60-bar high (new base high)", "L: asset 126-bar ROC > benchmark ROC and > 0", "M: benchmark close > its SMA(50)", "Volume >= 1.4 x 50-bar average on the breakout"],
        exit_rules=["Close < SMA(50)", "Profit target tp_r x R (stop 8% -> 2.5R = ~20%)", "8% stop"], stop_loss="stop_pct (8%) below entry", position_sizing="risk_pct / (stop_pct x price): ~12.5% of equity at 1% risk and an 8% stop", expected_costs=_COST,
        known_weaknesses=["S (supply), I (institutional sponsorship) and the newness criterion are not tested here", "Without fundamentals only N, L, M are tested: it is a technical breakout system", "Works in bull markets; false breakouts in corrections", "Survivorship bias if run on current winners"],
        params_default={"base_len": 60, "stop_pct": 0.08, "tp_r": 2.5, "eps_min": 0.25, "vol_mult": 1.4}, param_grid={"base_len": [40, 60, 100], "tp_r": [2.0, 3.0]},
        required_aux=["benchmark_close"], fidelity="partial", fidelity_note="Only N, L, M are mechanical; C and A apply only if fundamentals are supplied; S and I are not implemented.", legacy_modules=["oneil_canslim"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); self.require_volume(bars); n = len(bars); p = self.params
        a = self.require_aux(aux, ["benchmark_close"], n); bm = [float(x) for x in a["benchmark_close"]]
        f = (aux or {}).get("fundamentals"); use_f = isinstance(f, dict) and "eps_growth_yoy" in f
        if use_f and len(f["eps_growth_yoy"]) != n: raise MissingData(self.spec.id, ["fundamentals.eps_growth_yoy"], "length mismatch")
        hh = ind.highest(bars.h, p["base_len"], 1); s50 = ind.sma(bars.c, 50); bm50 = ind.sma(bm, 50); ra, rb = ind.roc(bars.c, 126), ind.roc(bm, 126); v50 = ind.sma(bars.v, 50)
        pl = self.empty_trade_plan(n); pl.take_profit_r = p["tp_r"]
        pl.notes.append("C/A applied" if use_f else "technical N/L/M only (no fundamentals supplied)")
        for i in range(1, n):
            if not ok(hh[i], s50[i], bm50[i], ra[i], rb[i], v50[i - 1] if i else NaN): continue
            c_ok = (not use_f) or (ok(f["eps_growth_yoy"][i]) and f["eps_growth_yoy"][i] >= p["eps_min"])
            if c_ok and bars.c[i] > hh[i] and ra[i] > rb[i] and ra[i] > 0 and bm[i] > bm50[i] and bars.v[i] >= p["vol_mult"] * v50[i - 1] and bars.c[i - 1] <= hh[i]:
                pl.signal[i] = 1
            pl.stop_dist[i] = p["stop_pct"] * bars.c[i]
            pl.exit_signal[i] = bars.c[i] < s50[i]
        return pl


class EventDriven(Strategy):
    spec = StrategySpec(
        id="event_driven", name="Event-Driven (post-event drift)", family="event",
        summary="After a positive information event (earnings, guidance, macro release) whose price reaction confirms the surprise, hold for the drift window.",
        timeframe="1h-1d; holds hold_bars bars", required_data=["OHLC", "events: [{index, surprise, kind}] where index is the bar on whose CLOSE the information was public", "surprise as a signed, pre-computed standardised number from a point-in-time source (e.g. consensus-based)"],
        entry_rules=["surprise >= s_min AND the event bar closed above its open (reaction confirms) -> long at next open", "If allow_short: surprise <= -s_min and close < open -> short"],
        exit_rules=["Time exit after hold_bars", "Stop"], stop_loss="atr_mult x ATR(14)", position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Event timestamps must be exact: a one-bar error leaks the future", "Surprise definitions need consensus data that is rarely free or point-in-time", "Post-event drift has shrunk in liquid, well-covered names", "Few events per instrument: tiny sample", "Gaps over events violate stop assumptions (engine fills at the gap open)"],
        params_default={"s_min": 0.05, "hold_bars": 20, "atr_mult": 2.0, "allow_short": False}, param_grid={"hold_bars": [10, 20, 40], "atr_mult": [1.5, 2.5], "s_min": [0.03, 0.05]},
        supports_short=True, required_aux=["events"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); n = len(bars); p = self.params
        ev = (aux or {}).get("events")
        if not isinstance(ev, list) or not ev: raise MissingData(self.spec.id, ["events"], "supply [{index, surprise, kind}] with point-in-time timestamps")
        a = ind.atr(bars.h, bars.l, bars.c, 14); pl = self.empty_trade_plan(n); pl.max_hold = p["hold_bars"]; sh = self.short_ok(); pl.reverse = False
        for i in range(n):
            if ok(a[i]): pl.stop_dist[i] = p["atr_mult"] * a[i]
        for e in ev:
            try: i, s = int(e["index"]), float(e["surprise"])
            except (KeyError, TypeError, ValueError): raise MissingData(self.spec.id, ["events"], "each event needs integer index and numeric surprise")
            if not (0 <= i < n) or math.isnan(s): raise MissingData(self.spec.id, ["events"], f"event index {i} outside bars")
            if s >= p["s_min"] and bars.c[i] > bars.o[i]: pl.signal[i] = 1
            elif sh and s <= -p["s_min"] and bars.c[i] < bars.o[i]: pl.signal[i] = -1
        return pl

"""Price-structure modules: Wyckoff and price action."""
from __future__ import annotations

from app.strategies import indicators as ind
from app.strategies.base import Strategy, ok, last_confirmed, swing_pivots, vol_ratio
from app.strategies.types import Bars, Plan, StrategySpec

NaN = float("nan")
_COST = {"fee_bps_per_side": 10.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 1.5,
         "note": "Defaults model a liquid spot crypto venue (0.10% taker fee). Override CostModel for your market."}


class Wyckoff(Strategy):
    spec = StrategySpec(
        id="wyckoff_method", name="Wyckoff Spring / Upthrust (rule-based)", family="structure",
        summary="Detect a quiet trading range, then trade a spring (false break below support that closes back inside on contained volume) confirmed by a sign of strength.",
        timeframe="4h-1d", required_data=["OHLC", "volume"],
        entry_rules=["Prior range (ending 4 bars ago, range_len bars) is tight: width <= max_width_atr x ATR and ADX(14) <= 25", "A low in the last 4 bars pierced range low by >= 0.1 ATR", "Close is back above range low, above the range midpoint, and the bar is bullish (sign of strength)",
                     "Volume on the spring bar (lowest low of the window) <= vol_max x the pre-spring 20-bar average (supply exhausted)", "If allow_short: mirrored upthrust at range high"],
        exit_rules=["Target tp_r x R (toward range top)", "Stop under the spring low"], stop_loss="Spring low minus 0.25 ATR", position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Phase labelling (PS, SC, AR, ST, LPS...) is discretionary; this encodes only the spring/upthrust test", "Few signals; results rest on very small samples", "Range detection thresholds are arbitrary and sensitive", "A failed spring is a breakdown: gap risk"],
        params_default={"range_len": 60, "max_width_atr": 14.0, "vol_max": 1.0, "tp_r": 2.0, "allow_short": False}, param_grid={"range_len": [40, 60, 100], "max_width_atr": [10.0, 14.0]},
        supports_short=True, fidelity="proxy", fidelity_note="Operational definition of the spring/upthrust test only - not the full Wyckoff schematic or composite-operator reading.", legacy_modules=["wyckoff_supply_demand"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); self.require_volume(bars); p = self.params; n = len(bars)
        rh, rl = ind.highest(bars.h, p["range_len"], 4), ind.lowest(bars.l, p["range_len"], 4); a = ind.atr(bars.h, bars.l, bars.c, 14); x = ind.adx(bars.h, bars.l, bars.c, 14)
        v = ind.sma(bars.v, 20); pl = self.empty_trade_plan(n); pl.take_profit_r = p["tp_r"]; sh = self.short_ok(); pl.reverse = False
        for i in range(4, n):
            if not ok(rh[i], rl[i], a[i], x[i], v[i - 4]) or a[i] <= 0: continue
            if (rh[i] - rl[i]) > p["max_width_atr"] * a[i] or x[i] > 25: continue
            mid = (rh[i] + rl[i]) / 2; wl = slice(i - 3, i + 1)
            jmin = min(range(i - 3, i + 1), key=lambda j: bars.l[j])
            if (bars.l[jmin] < rl[i] - 0.1 * a[i] and bars.c[i] > rl[i] and bars.c[i] > mid and bars.c[i] > bars.o[i]
                    and bars.v[jmin] <= p["vol_max"] * v[i - 4]):
                pl.signal[i] = 1; pl.stop_dist[i] = max(bars.c[i] - (bars.l[jmin] - 0.25 * a[i]), 0.5 * a[i])
            elif sh and max(bars.h[wl]) > rh[i] + 0.1 * a[i] and bars.c[i] < rh[i] and bars.c[i] < mid and bars.c[i] < bars.o[i]:
                pl.signal[i] = -1; pl.stop_dist[i] = max((max(bars.h[wl]) + 0.25 * a[i]) - bars.c[i], 0.5 * a[i])
            if pl.stop_dist[i] != pl.stop_dist[i]: pl.stop_dist[i] = 2 * a[i]
        return pl


class PriceAction(Strategy):
    spec = StrategySpec(
        id="price_action", name="Price Action (pin bar / engulfing at structure)", family="structure",
        summary="Trade rejection candles (pin bars, engulfing) that form at confirmed support/resistance or the EMA(50), in the direction of the EMA(50) trend.",
        timeframe="1h-1d", required_data=["Complete OHLC"],
        entry_rules=["Bullish: close > EMA(50) and (bullish pin bar OR bullish engulfing) and low within 0.5 ATR of last confirmed swing low or EMA(50)", "Pin bar: lower wick >= 2 x body, upper wick <= 30% of range, close in upper third", "If allow_short: mirrored bearish setups below EMA(50)"],
        exit_rules=["Target tp_r x R", "Time stop max_hold", "Stop"], stop_loss="Pattern extreme (low for longs) minus 0.25 ATR", position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Candlestick patterns have weak standalone evidence; most edge disappears after costs in many studies", "Subjective in practice: this is one mechanical reading", "Setup frequency is high so multiple-testing risk is high"],
        params_default={"pivot_k": 3, "tp_r": 2.0, "max_hold": 10, "allow_short": False}, param_grid={"tp_r": [1.5, 2.0, 3.0], "pivot_k": [3, 5]}, supports_short=True)

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        e50 = ind.ema(bars.c, 50); a = ind.atr(bars.h, bars.l, bars.c, 14); sh_p, sl_p = swing_pivots(bars.h, bars.l, p["pivot_k"])
        sup, res = last_confirmed(sl_p, n), last_confirmed(sh_p, n)
        pl = self.empty_trade_plan(n); pl.take_profit_r = p["tp_r"]; pl.max_hold = p["max_hold"]; sh = self.short_ok()
        for i in range(1, n):
            if not ok(e50[i], a[i]): continue
            o, h, l, c = bars.o[i], bars.h[i], bars.l[i], bars.c[i]; rng = h - l
            if rng <= 0: continue
            body = max(abs(c - o), 0.1 * rng)
            bull_pin = (min(o, c) - l) >= 2 * body and (h - max(o, c)) <= 0.3 * rng and c >= l + 2 * rng / 3
            bear_pin = (h - max(o, c)) >= 2 * body and (min(o, c) - l) <= 0.3 * rng and c <= l + rng / 3
            bull_eng = c > o and bars.c[i - 1] < bars.o[i - 1] and c >= bars.o[i - 1] and o <= bars.c[i - 1]
            bear_eng = c < o and bars.c[i - 1] > bars.o[i - 1] and c <= bars.o[i - 1] and o >= bars.c[i - 1]
            at_sup = (ok(sup[i]) and abs(l - sup[i]) <= 0.5 * a[i]) or abs(l - e50[i]) <= 0.5 * a[i]
            at_res = (ok(res[i]) and abs(h - res[i]) <= 0.5 * a[i]) or abs(h - e50[i]) <= 0.5 * a[i]
            if c > e50[i] and (bull_pin or bull_eng) and at_sup:
                pl.signal[i] = 1; pl.stop_dist[i] = max(c - (l - 0.25 * a[i]), 0.5 * a[i])
            elif sh and c < e50[i] and (bear_pin or bear_eng) and at_res:
                pl.signal[i] = -1; pl.stop_dist[i] = max((h + 0.25 * a[i]) - c, 0.5 * a[i])
            else:
                pl.stop_dist[i] = 1.5 * a[i]
        return pl

"""Holding-period modules: swing trading and position trading."""
from __future__ import annotations

from app.strategies import indicators as ind
from app.strategies.base import Strategy, ok, last_confirmed, swing_pivots
from app.strategies.types import Bars, Plan, StrategySpec

NaN = float("nan")
_COST = {"fee_bps_per_side": 10.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 1.5,
         "note": "Defaults model a liquid spot crypto venue (0.10% taker fee). Override CostModel for your market."}


class SwingTrading(Strategy):
    spec = StrategySpec(
        id="swing_trading", name="Swing Trading (market structure)", family="swing",
        summary="Buy a break of the last confirmed swing high when swing lows are rising (higher-low structure) above the EMA(50).",
        timeframe="4h-1d; holds days to weeks", required_data=["OHLC"],
        entry_rules=["Last confirmed swing low > the swing low before it (higher low)", "Close > last confirmed swing high", "Close > EMA(50)"],
        exit_rules=["Close < last confirmed swing low", "Target at tp_r x R", "Stop"], stop_loss="Last swing low minus 0.5 ATR (floored at 0.5 ATR, capped at 4 ATR)",
        position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Swing points are confirmed late (pivot_k bars), so entries lag", "Choppy markets produce many failed breaks", "Overnight/weekend gap risk on equities/FX"],
        params_default={"pivot_k": 3, "tp_r": 3.0, "ema_len": 50}, param_grid={"pivot_k": [3, 5], "tp_r": [2.0, 3.0]}, default_interval="4h")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        sh, sl = swing_pivots(bars.h, bars.l, p["pivot_k"])
        hi, lo1, lo2 = last_confirmed(sh, n), last_confirmed(sl, n), last_confirmed(sl, n, 2)
        e = ind.ema(bars.c, p["ema_len"]); a = ind.atr(bars.h, bars.l, bars.c, 14)
        pl = self.empty_trade_plan(n); pl.take_profit_r = p["tp_r"]
        for i in range(n):
            if not ok(hi[i], lo1[i], lo2[i], e[i], a[i]): continue
            if lo1[i] > lo2[i] and bars.c[i] > hi[i] and bars.c[i] > e[i] and (i == 0 or bars.c[i - 1] <= hi[i]):
                pl.signal[i] = 1
            d = bars.c[i] - (lo1[i] - 0.5 * a[i])
            pl.stop_dist[i] = min(max(d, 0.5 * a[i]), 4 * a[i])
            pl.exit_signal[i] = bars.c[i] < lo1[i]
        return pl


class PositionTrading(Strategy):
    spec = StrategySpec(
        id="position_trading", name="Position Trading (long-term trend with hysteresis)", family="position",
        summary="Hold the primary trend for months: be long while price is above a rising long-term SMA, with a hysteresis band to avoid churn.",
        timeframe="1d-1w; holds weeks to months", required_data=["OHLC"],
        entry_rules=["Close > SMA(len) x (1 + band) and SMA(len) slope over 20 bars > 0"], exit_rules=["Close < SMA(len) x (1 - band)", "Trailing stop"],
        stop_loss="atr_mult x ATR(20), trailed on closes", position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Very few independent trades: statistical confidence is low", "Large give-back at major tops", "Opportunity cost during long sideways periods", "Needs years of data to evaluate; default 1000-bar windows are too short on 1d to validate"],
        params_default={"len": 200, "band": 0.02, "atr_mult": 4.0}, param_grid={"len": [100, 200], "band": [0.0, 0.02, 0.05]}, default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        m = ind.sma(bars.c, p["len"]); a = ind.atr(bars.h, bars.l, bars.c, 20)
        pl = self.empty_trade_plan(n); pl.trail = True
        for i in range(20, n):
            if not ok(m[i], m[i - 20], a[i]): continue
            if bars.c[i] > m[i] * (1 + p["band"]) and m[i] > m[i - 20]: pl.signal[i] = 1
            pl.stop_dist[i] = p["atr_mult"] * a[i]
            pl.exit_signal[i] = bars.c[i] < m[i] * (1 - p["band"])
        return pl

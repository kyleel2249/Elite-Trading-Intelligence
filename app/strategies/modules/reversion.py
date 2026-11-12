"""Mean-reversion family: mean reversion, contrarian, scalping, pairs trading, statistical arbitrage."""
from __future__ import annotations

import math
from typing import Any, Optional

from app.strategies import indicators as ind
from app.strategies.base import Strategy, ok, vol_ratio
from app.strategies.types import Bars, MissingData, Plan, StrategySpec

NaN = float("nan")
_COST = {"fee_bps_per_side": 10.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 1.5,
         "note": "Defaults model a liquid spot crypto venue (0.10% taker fee). Override CostModel for your market."}
_PAIR_COST = {"fee_bps_per_side": 10.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 1.5, "short_carry_bps_per_bar": 0.5,
              "note": "Two legs: costs are scaled by (1 + |hedge ratio|). Short carry/borrow is a flat placeholder - use your real borrow/funding rate."}


class MeanReversion(Strategy):
    spec = StrategySpec(
        id="mean_reversion", name="Mean Reversion (z-score)", family="reversion",
        summary="Fade short-term statistical extremes relative to a rolling mean and exit as price normalises.",
        timeframe="15m-1d", required_data=["OHLC"],
        entry_rules=["z = (close - SMA(n)) / stdev(n) <= -z_entry -> long at next open", "If allow_short: z >= +z_entry -> short"],
        exit_rules=["z >= -z_exit (long) after reverting", "Time stop after max_hold bars", "ATR stop"],
        stop_loss="atr_mult x ATR(14) from entry (not trailed)", position_sizing="risk_pct / stop distance, leverage-capped",
        expected_costs=_COST, known_weaknesses=["Loses heavily when an extreme is the start of a trend (negative skew)", "High win rate masks rare large losses",
                                                "Transaction costs erode small edges", "Stationarity is assumed, not guaranteed"],
        params_default={"n": 20, "z_entry": 2.0, "z_exit": 0.25, "atr_mult": 3.0, "max_hold": 24, "allow_short": False},
        param_grid={"n": [20, 50], "z_entry": [1.5, 2.0, 2.5]}, supports_short=True, legacy_modules=[])

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        z = ind.zscore(bars.c, p["n"]); a = ind.atr(bars.h, bars.l, bars.c, 14)
        pl = self.empty_trade_plan(n); pl.max_hold = p["max_hold"]; sh = self.short_ok(); pl.reverse = False
        for i in range(n):
            if not ok(z[i], a[i]): continue
            if z[i] <= -p["z_entry"]: pl.signal[i] = 1
            elif sh and z[i] >= p["z_entry"]: pl.signal[i] = -1
            pl.stop_dist[i] = p["atr_mult"] * a[i]
            # direction-blind exit is safe here: both directions exit when |z| has collapsed toward the mean
            pl.exit_signal[i] = abs(z[i]) <= p["z_exit"]
        return pl


class Contrarian(Strategy):
    spec = StrategySpec(
        id="contrarian", name="Contrarian Capitulation Reversal", family="reversion",
        summary="Buy after panic-like selloffs, but only once price confirms by closing above the prior bar's high.",
        timeframe="4h-1d", required_data=["OHLC", "volume", "optional: aligned sentiment series (0-100; low = fear)"],
        entry_rules=["Drawdown from highest close of `dd_len` bars >= dd_pct", "RSI(14) <= rsi_max within the last 3 bars", "Volume spike >= vol_spike x average within last 3 bars",
                     "Confirmation: close > prior bar high", "If a sentiment series is supplied: sentiment <= sentiment_max"],
        exit_rules=["RSI(14) >= 55", "Take profit at 3R", "Time stop max_hold", "Stop"], stop_loss="Lowest low of last 5 bars minus 1 ATR",
        position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Catching falling knives: signals cluster in prolonged crashes", "Very few signals; statistics are thin", "Without a sentiment series this is a price/volume panic proxy, not true crowd-positioning contrarianism"],
        params_default={"dd_len": 60, "dd_pct": 0.25, "rsi_max": 25, "vol_spike": 2.0, "sentiment_max": 25, "max_hold": 48},
        param_grid={"dd_pct": [0.15, 0.25], "rsi_max": [25, 30]}, fidelity="proxy",
        fidelity_note="Without a point-in-time sentiment/positioning series the method reduces to a capitulation proxy.", legacy_modules=["burry_contrarian"], default_interval="4h")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); self.require_volume(bars); p = self.params; n = len(bars)
        sent = (aux or {}).get("sentiment")
        if sent is not None and len(sent) != n: raise MissingData(self.spec.id, ["sentiment"], "length mismatch")
        hc = ind.highest(bars.c, p["dd_len"]); r = ind.rsi(bars.c, 14); a = ind.atr(bars.h, bars.l, bars.c, 14); vr = vol_ratio(bars.v, 20); ll5 = ind.lowest(bars.l, 5)
        pl = self.empty_trade_plan(n); pl.take_profit_r = 3.0; pl.max_hold = p["max_hold"]
        pl.notes.append("sentiment series used" if sent is not None else "price/volume capitulation proxy (no sentiment series)")
        for i in range(3, n):
            if not ok(hc[i], r[i], a[i], ll5[i]): continue
            dd = 1 - bars.c[i] / hc[i]
            panic = any(ok(r[j]) and r[j] <= p["rsi_max"] for j in range(i - 2, i + 1)) and any(ok(vr[j]) and vr[j] >= p["vol_spike"] for j in range(i - 2, i + 1))
            sent_ok = True if sent is None else (sent[i] is not None and sent[i] <= p["sentiment_max"])
            if dd >= p["dd_pct"] and panic and sent_ok and bars.c[i] > bars.h[i - 1]:
                pl.signal[i] = 1
            pl.stop_dist[i] = max(bars.c[i] - (ll5[i] - a[i]), 0.5 * a[i])
            pl.exit_signal[i] = r[i] >= 55
        return pl


class Scalping(Strategy):
    spec = StrategySpec(
        id="scalping", name="Scalping (micro-trend pullback)", family="short_term",
        summary="Very short holding periods: trade a one-bar pullback to a fast EMA inside a micro-trend on a volume pulse, with tight stop and 1R target.",
        timeframe="1m-5m", required_data=["OHLC (1m-5m)", "volume", "production use also needs order-book/tick data and latency measurements"],
        entry_rules=["EMA(9) > EMA(21)", "Prior bar low <= EMA(9) and current close > EMA(9) and close > open", "Volume >= vol_mult x 20-bar average"],
        exit_rules=["1R target", "Stop", "Time stop max_hold bars"], stop_loss="stop_atr x ATR(14) (tight)", position_sizing="risk_pct / stop distance, leverage-capped (use a smaller risk_pct)",
        expected_costs={"fee_bps_per_side": 10.0, "slippage_bps_per_side": 5.0, "half_spread_bps": 3.0, "note": "Costs dominate scalping: with a 0.8 ATR stop and these costs the strategy needs a gross edge well above ~20 bps round trip."},
        known_weaknesses=["Transaction costs and slippage are usually larger than the edge", "Bar data hides queue position, partial fills and latency",
                          "Backtests are optimistic: real fills on 1m bars are worse", "Requires many trades; results are fragile to cost assumptions"],
        params_default={"vol_mult": 1.5, "stop_atr": 0.8, "max_hold": 12, "tp_r": 1.0}, param_grid={"stop_atr": [0.8, 1.2], "tp_r": [1.0, 1.5]},
        fidelity="partial", fidelity_note="Bar-level approximation of tick-level scalping; no spread/queue model beyond flat bps.", default_interval="5m")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); self.require_volume(bars); p = self.params; n = len(bars)
        e9, e21, a = ind.ema(bars.c, 9), ind.ema(bars.c, 21), ind.atr(bars.h, bars.l, bars.c, 14); vr = vol_ratio(bars.v, 20)
        pl = self.empty_trade_plan(n); pl.take_profit_r = p["tp_r"]; pl.max_hold = p["max_hold"]
        for i in range(1, n):
            if not ok(e9[i], e21[i], a[i], e9[i - 1]): continue
            if e9[i] > e21[i] and bars.l[i - 1] <= e9[i - 1] and bars.c[i] > e9[i] and bars.c[i] > bars.o[i] and ok(vr[i]) and vr[i] >= p["vol_mult"]:
                pl.signal[i] = 1
            pl.stop_dist[i] = p["stop_atr"] * a[i]
        return pl


def _spread_plan(strategy: Strategy, y_close: list[float], x_ret: list[float], window: int, z_in: float, z_out: float, z_stop: float,
                 adf_gate: bool, adf_crit: float, allow_short_leg: bool = True, cooldown: int = 24) -> Plan:
    """Rolling-OLS residual reversion. Everything at bar i uses data <= i. Exposure decided at close i earns the
    spread return of bar i+1: r_y - beta_i * r_x. +1 = long y / short hedge; -1 = the reverse."""
    n = len(y_close)
    ly = [math.log(c) for c in y_close]
    lx = [0.0]
    for i in range(1, n): lx.append(lx[-1] + math.log(1 + x_ret[i]))
    ry = [NaN] + [y_close[i] / y_close[i - 1] - 1 for i in range(1, n)]
    beta = [NaN] * n; z = [NaN] * n; adf = [NaN] * n
    for i in range(window - 1, n):
        yy, xx = ly[i - window + 1 : i + 1], lx[i - window + 1 : i + 1]
        al, be = ind.ols(yy, xx); res = [a - al - be * b for a, b in zip(yy, xx)]
        sd = math.sqrt(sum(r * r for r in res) / (window - 2))
        beta[i] = be; z[i] = res[-1] / sd if sd > 0 else NaN
        if adf_gate: adf[i] = ind.adf_stat(res)
    pl = Plan(mode="exposure", exposure=[0.0] * n)
    asset = [NaN] * n
    for i in range(1, n):
        if ok(beta[i - 1]) and ok(x_ret[i], ry[i]): asset[i] = ry[i] - beta[i - 1] * x_ret[i]
    pl.asset_returns = asset
    e = 0.0; cool = 0
    for i in range(window, n):
        if not ok(z[i]): continue
        if cool > 0: cool -= 1; e = 0.0; pl.exposure[i] = 0.0; continue
        gate = (not adf_gate) or (ok(adf[i]) and adf[i] <= adf_crit)
        if abs(z[i]) >= z_stop: e = 0.0; cool = cooldown   # relationship may have broken: stand aside
        elif e == 0.0 and gate:
            if z[i] <= -z_in: e = 1.0
            elif z[i] >= z_in and allow_short_leg: e = -1.0
        elif e != 0.0 and (abs(z[i]) <= z_out or not gate): e = 0.0
        pl.exposure[i] = e
    bb = [abs(b) for b in beta if ok(b)]
    pl.cost_multiplier = 1.0 + (sum(bb) / len(bb) if bb else 1.0)
    return pl


class PairsTrading(Strategy):
    spec = StrategySpec(
        id="pairs_trading", name="Pairs Trading (rolling hedge ratio + cointegration gate)", family="market_neutral",
        summary="Trade the log-price spread between two related assets with a rolling OLS hedge ratio; trade only while a Dickey-Fuller screen indicates mean reversion.",
        timeframe="1h-1d", required_data=["close of both legs (aligned)", "borrow/funding rates for the short leg", "optional: fundamentals to justify the pair economically"],
        entry_rules=["Rolling z-score of the spread residual <= -z_in -> long A / short beta x B (>= z_in -> reverse)", "Only while DF t-stat of the residual <= adf_crit (not a full Engle-Granger test)"],
        exit_rules=["|z| <= z_out", "|z| >= z_stop -> stand aside for `cooldown` bars (relationship may have broken)", "Gate failure"],
        stop_loss="Statistical: |z| >= z_stop; no price stop on individual legs", position_sizing="Exposure scaled to 1.0 of equity on the spread (gross leverage 1 + |beta|); costs scaled by 1 + |beta|",
        expected_costs=_PAIR_COST, known_weaknesses=["Cointegration breaks (structural change) cause large losses", "Pair selection on the same history that is tested overstates results - pass a pair chosen ex-ante",
                                                    "Short borrow availability/costs vary", "DF screen on a rolling window is crude and has low power"],
        params_default={"window": 120, "z_in": 2.0, "z_out": 0.5, "z_stop": 4.0, "adf_crit": -2.5, "cooldown": 24},
        param_grid={"window": [60, 120], "z_in": [1.5, 2.0, 2.5]}, mode="exposure", supports_short=True, required_aux=["pair_close"], fidelity="partial",
        fidelity_note="Hedge ratio and gate are rolling approximations; no Engle-Granger critical values, no Kalman filter.", legacy_modules=["simons_quant"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        a = self.require_aux(aux, ["pair_close"], len(bars)); pc = [float(x) for x in a["pair_close"]]
        if any(x <= 0 or math.isnan(x) for x in pc): raise MissingData(self.spec.id, ["pair_close"], "non-positive/NaN values")
        p = self.params; xr = [NaN] + [pc[i] / pc[i - 1] - 1 for i in range(1, len(pc))]
        return _spread_plan(self, bars.c, xr, p["window"], p["z_in"], p["z_out"], p["z_stop"], True, p["adf_crit"], cooldown=p["cooldown"])


class StatisticalArbitrage(Strategy):
    spec = StrategySpec(
        id="statistical_arbitrage", name="Statistical Arbitrage (asset vs equal-weight basket)", family="market_neutral",
        summary="Trade the residual of one asset against an equal-weight basket of peers using rolling regression; fade extreme residuals, hedged by the basket.",
        timeframe="1h-1d", required_data=["close of target and >= 3 peer assets (aligned)", "borrow/funding costs", "point-in-time universe membership"],
        entry_rules=["Rolling z-score of the residual vs basket <= -z_in -> long target / short beta x basket (>= z_in -> reverse)"],
        exit_rules=["|z| <= z_out", "|z| >= z_stop -> stand aside for `cooldown` bars"], stop_loss="Statistical (|z| >= z_stop); no leg-level price stop",
        position_sizing="Exposure 1.0 on the hedged residual; costs scaled by 1 + |beta|", expected_costs=_PAIR_COST,
        known_weaknesses=["Single-name residual strategy, not a diversified book of hundreds of residuals", "Crowded; edge decays quickly and is cost-sensitive",
                          "Peer set chosen with hindsight biases results", "Residual reversion can stop during regime shifts"],
        params_default={"window": 60, "z_in": 2.0, "z_out": 0.5, "z_stop": 4.0, "cooldown": 24}, param_grid={"window": [40, 60, 120], "z_in": [1.5, 2.0, 2.5]},
        mode="exposure", supports_short=True, required_aux=["basket_closes"], fidelity="partial",
        fidelity_note="One residual at a time; a real stat-arb book trades many residuals with factor/sector neutrality and capacity limits.", legacy_modules=["simons_quant"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        a = self.require_aux(aux, ["basket_closes"], len(bars)); bk = a["basket_closes"]
        if not isinstance(bk, dict) or len(bk) < 3: raise MissingData(self.spec.id, ["basket_closes"], "need >= 3 peer series")
        n = len(bars); rets = []
        for name, s in bk.items():
            if any((x is None) or x <= 0 or math.isnan(float(x)) for x in s): raise MissingData(self.spec.id, [f"basket_closes.{name}"], "non-positive/NaN values")
            rets.append([NaN] + [s[i] / s[i - 1] - 1 for i in range(1, n)])
        xr = [NaN] + [sum(r[i] for r in rets) / len(rets) for i in range(1, n)]
        p = self.params
        return _spread_plan(self, bars.c, xr, p["window"], p["z_in"], p["z_out"], p["z_stop"], False, -2.5, cooldown=p["cooldown"])

"""Trend-family modules: trend following, breakout, pullback, momentum, Turtle, Darvas box, volatility contraction pattern."""
from __future__ import annotations

import math
from typing import Any, Optional

from app.strategies import indicators as ind
from app.strategies.base import Strategy, ok, last_confirmed, swing_pivots, vol_ratio
from app.strategies.types import Bars, Plan, StrategySpec

NaN = float("nan")
_COST = {"fee_bps_per_side": 10.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 1.5,
         "note": "Defaults model a liquid spot crypto venue (0.10% taker fee). Override CostModel for your market."}


class TrendFollowing(Strategy):
    spec = StrategySpec(
        id="trend_following", name="Trend Following (EMA regime + ADX)", family="trend",
        summary="Hold with the dominant trend defined by a slow/fast EMA relationship, filtered by trend strength.",
        timeframe="4h-1d (default evaluated on 1h bars; widen for lower turnover)",
        required_data=["OHLC", "volume (not used)"],
        entry_rules=["EMA(fast) > EMA(slow) AND ADX(14) >= adx_min -> long at next open",
                     "If allow_short: EMA(fast) < EMA(slow) AND ADX >= adx_min -> short"],
        exit_rules=["EMA cross back against position", "Trailing chandelier stop (atr_mult x ATR) hit"],
        stop_loss="atr_mult x ATR(14) from entry, trailed on closes",
        position_sizing="Fixed fractional: risk_pct of equity / stop distance, capped at max_leverage x equity",
        expected_costs=_COST,
        known_weaknesses=["Whipsaws and repeated small losses in ranges", "Gives back open profit at reversals",
                          "Low win rate (often <45%) requires the payoff ratio to be real", "Parameters are regime-dependent"],
        params_default={"fast": 50, "slow": 200, "adx_min": 20, "atr_mult": 3.0, "allow_short": False},
        param_grid={"fast": [20, 50], "slow": [100, 200], "atr_mult": [2.5, 3.5]}, supports_short=True,
        legacy_modules=["seykota_mechanical", "turtle_trend", "ptj_structure_preservation"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        f, s = ind.ema(bars.c, p["fast"]), ind.ema(bars.c, p["slow"]); a = ind.atr(bars.h, bars.l, bars.c, 14); x = ind.adx(bars.h, bars.l, bars.c, 14)
        pl = self.empty_trade_plan(n); pl.trail = True
        shorts = self.short_ok()
        for i in range(n):
            if not ok(f[i], s[i], a[i], x[i]): continue
            up, dn = f[i] > s[i], f[i] < s[i]
            if x[i] >= p["adx_min"]:
                if up: pl.signal[i] = 1
                elif dn and shorts: pl.signal[i] = -1
            pl.stop_dist[i] = p["atr_mult"] * a[i]
            # Long-only: leave when the fast EMA loses the slow EMA. With shorts enabled the position is
            # flipped by `reverse` (opposite signal) or stopped out, because exit_signal is direction-blind.
            pl.exit_signal[i] = (not shorts) and f[i] <= s[i]
        pl.reverse = shorts
        return pl


class Breakout(Strategy):
    spec = StrategySpec(
        id="breakout", name="Range / Channel Breakout", family="trend",
        summary="Enter when price closes beyond the prior N-bar high with volume confirmation; exit on a shorter opposite channel.",
        timeframe="1h-1d", required_data=["OHLC", "volume (confirmation; skipped if unavailable and require_volume=False)"],
        entry_rules=["Close > highest high of prior `lookback` bars (excluding current)", "Volume >= vol_mult x 20-bar average volume (if require_volume)"],
        exit_rules=["Close < lowest low of prior `exit_lookback` bars", "Initial/trailing ATR stop"],
        stop_loss="atr_mult x ATR(14) below entry, trailed", position_sizing="risk_pct of equity / stop distance, leverage-capped",
        expected_costs=_COST, known_weaknesses=["False breakouts dominate in low-volatility ranges", "Slippage on breakout bars is higher than average",
                                                "Entries are late by construction; edge depends on fat right tail"],
        params_default={"lookback": 55, "exit_lookback": 20, "vol_mult": 1.2, "atr_mult": 2.0, "require_volume": True},
        param_grid={"lookback": [20, 55], "exit_lookback": [10, 20], "atr_mult": [2.0, 3.0]}, legacy_modules=["turtle_trend", "darvas_box"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        if p["require_volume"]: self.require_volume(bars)
        hh = ind.highest(bars.h, p["lookback"], 1); ll = ind.lowest(bars.l, p["exit_lookback"], 1); a = ind.atr(bars.h, bars.l, bars.c, 14)
        vr = vol_ratio(bars.v, 20) if bars.v is not None else []
        pl = self.empty_trade_plan(n); pl.trail = True
        for i in range(n):
            if not ok(hh[i], ll[i], a[i]): continue
            vol_ok = (not p["require_volume"]) or (ok(vr[i]) and vr[i] >= p["vol_mult"])
            if bars.c[i] > hh[i] and vol_ok: pl.signal[i] = 1
            pl.stop_dist[i] = p["atr_mult"] * a[i]
            pl.exit_signal[i] = bars.c[i] < ll[i]
        return pl


class Pullback(Strategy):
    spec = StrategySpec(
        id="pullback", name="Trend Pullback (RSI re-entry)", family="trend",
        summary="Buy short-term weakness inside an established uptrend after momentum turns back up.",
        timeframe="1h-1d", required_data=["OHLC"],
        entry_rules=["Close > SMA(trend_len) and SMA(50) > SMA(trend_len)", "RSI(14) was below rsi_buy on the prior bar and crosses back above it"],
        exit_rules=["RSI(14) >= rsi_exit", "Close < SMA(trend_len) (trend broken)"],
        stop_loss="Lowest low of last 5 bars minus 0.25 x ATR, capped at atr_cap x ATR", position_sizing="risk_pct / stop distance, leverage-capped",
        expected_costs=_COST, known_weaknesses=["A pullback can be the start of a reversal: losses are frequent when trends end",
                                                "Few signals in weak or choppy markets", "Sensitive to the RSI threshold"],
        params_default={"trend_len": 200, "rsi_buy": 40, "rsi_exit": 70, "atr_cap": 3.0},
        param_grid={"rsi_buy": [35, 40, 45], "rsi_exit": [65, 75]}, legacy_modules=["ptj_structure_preservation"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        t, m50, r, a = ind.sma(bars.c, p["trend_len"]), ind.sma(bars.c, 50), ind.rsi(bars.c, 14), ind.atr(bars.h, bars.l, bars.c, 14)
        ll5 = ind.lowest(bars.l, 5)
        pl = self.empty_trade_plan(n)
        for i in range(1, n):
            if not ok(t[i], m50[i], r[i], r[i - 1], a[i], ll5[i]): continue
            if bars.c[i] > t[i] and m50[i] > t[i] and r[i - 1] < p["rsi_buy"] <= r[i]:
                pl.signal[i] = 1
            d = bars.c[i] - (ll5[i] - 0.25 * a[i])
            pl.stop_dist[i] = min(max(d, 0.5 * a[i]), p["atr_cap"] * a[i])
            pl.exit_signal[i] = r[i] >= p["rsi_exit"] or bars.c[i] < t[i]
        return pl


class Momentum(Strategy):
    spec = StrategySpec(
        id="momentum", name="Time-Series Momentum (vol-targeted)", family="momentum",
        summary="Hold long when the asset's own trailing return (skipping the latest bars) is positive; scale exposure inversely to realised volatility.",
        timeframe="1d (rebalance every `rebalance` bars)", required_data=["close"],
        entry_rules=["ROC(lookback) measured up to `skip` bars ago > 0 -> target exposure = min(1, vol_target / realised vol)"],
        exit_rules=["ROC <= 0 -> flat (or short if allow_short)"], stop_loss="No price stop; risk is controlled by volatility scaling and the exposure cap",
        position_sizing="Exposure = vol_target (per-bar stdev) / realised vol over 20 bars, clipped to [0, 1] (or [-1, 1])",
        expected_costs=_COST, known_weaknesses=["Momentum crashes at sharp reversals", "Vol-targeting lags volatility spikes",
                                                "Time-series momentum differs from the cross-sectional factor in the academic literature (no universe here)"],
        params_default={"lookback": 90, "skip": 5, "vol_target": 0.01, "rebalance": 12, "allow_short": False},
        param_grid={"lookback": [60, 120, 240], "skip": [0, 5], "rebalance": [6, 24]}, mode="exposure", supports_short=True,
        legacy_modules=["druck_liquidity_macro", "simons_quant"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        p = self.params; n = len(bars)
        rv = ind.realized_vol(bars.c, 20); pl = Plan(mode="exposure", exposure=[0.0] * n)
        cur = 0.0
        for i in range(p["lookback"] + p["skip"], n):
            if (i % p["rebalance"]) == 0 and ok(rv[i]) and rv[i] > 0:
                j = i - p["skip"]
                mom = bars.c[j] / bars.c[j - p["lookback"]] - 1
                scale = min(1.0, p["vol_target"] / rv[i])
                cur = scale if mom > 0 else (-scale if (mom < 0 and self.short_ok()) else 0.0)
            pl.exposure[i] = cur
        return pl


class Turtle(Strategy):
    spec = StrategySpec(
        id="turtle_trading", name="Turtle Trading (System 1 / System 2)", family="trend",
        summary="Donchian breakout system with ATR('N')-based stops and sizing, including the System 1 skip-after-winner rule.",
        timeframe="1d", required_data=["OHLC"],
        entry_rules=["System 1: close > prior 20-bar high; System 2: close > prior 55-bar high", "System 1 entries are skipped if the previous virtual System 1 breakout would have been a winner"],
        exit_rules=["System 1: close < prior 10-bar low; System 2: close < prior 20-bar low", "2N stop"],
        stop_loss="2 x N where N = ATR(20)", position_sizing="1% of equity risked per 2N stop (the original sized 1 unit = 1% of equity per N; this port uses a single unit, no pyramiding)",
        expected_costs=_COST, known_weaknesses=["Original used intraday breakouts; this uses closes", "Pyramiding to 4 units not implemented",
                                                "Long drawdowns and low win rate are normal", "Original markets/leverage differ (diversified futures)", "Edge has decayed in some markets since the 1980s"],
        params_default={"system": 1, "skip_rule": True, "allow_short": False},
        param_grid={"system": [1, 2]}, supports_short=False, fidelity="partial",
        fidelity_note="Single unit, close-based breakouts, long-only; no pyramiding or portfolio-level unit limits.",
        legacy_modules=["turtle_trend"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        en, ex = (20, 10) if p["system"] == 1 else (55, 20)
        hh, ll = ind.highest(bars.h, en, 1), ind.lowest(bars.l, ex, 1); N = ind.atr(bars.h, bars.l, bars.c, 20)
        pl = self.empty_trade_plan(n)
        v_in = False; v_entry = 0.0; v_stop = 0.0; last_win = False
        for i in range(n):
            if not ok(hh[i], ll[i], N[i]): continue
            if v_in:  # track virtual System-1 trade to know if the *previous* breakout was a winner
                if bars.l[i] <= v_stop or bars.c[i] < ll[i]:
                    px = min(v_stop, bars.c[i]) if bars.l[i] <= v_stop else bars.c[i]
                    last_win = px > v_entry; v_in = False
            brk = bars.c[i] > hh[i]
            if brk and not v_in:
                v_in, v_entry, v_stop = True, bars.c[i], bars.c[i] - 2 * N[i]
                if p["system"] == 1 and p["skip_rule"] and last_win:
                    pass  # real entry skipped below
                else:
                    pl.signal[i] = 1
            elif brk and p["system"] == 2:
                pl.signal[i] = 1
            pl.stop_dist[i] = 2 * N[i]
            pl.exit_signal[i] = bars.c[i] < ll[i]
        return pl


class DarvasBox(Strategy):
    spec = StrategySpec(
        id="darvas_box", name="Darvas Box Breakout", family="breakout",
        summary="Define a box from a confirmed new high and the lowest low after it; buy a close above the box top on volume; exit below the box bottom.",
        timeframe="1d (also 4h)", required_data=["OHLC", "volume"],
        entry_rules=["A box top is confirmed when no higher high prints for `confirm` bars; box bottom = lowest low since the top", "Close > box top AND volume >= vol_mult x 20-bar average"],
        exit_rules=["Close < active box bottom"], stop_loss="Box bottom (distance from entry close, floored at 0.5 ATR)",
        position_sizing="risk_pct / (entry - box bottom), leverage-capped", expected_costs=_COST,
        known_weaknesses=["Boxes are ambiguous in noisy data; confirm length changes results", "Designed for 1950s trending equities; edge in modern markets is untested here",
                          "Gap-ups can make the stop distance very large (position becomes small)"],
        params_default={"confirm": 3, "vol_mult": 1.2, "lookback": 60}, param_grid={"confirm": [3, 5], "vol_mult": [1.0, 1.5]},
        fidelity="partial", fidelity_note="Box confirmation uses a fixed bar count; Darvas's fundamental screens are not included.", legacy_modules=["darvas_box"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); self.require_volume(bars); p = self.params; n = len(bars)
        a = ind.atr(bars.h, bars.l, bars.c, 14); vr = vol_ratio(bars.v, 20); pl = self.empty_trade_plan(n)
        top = bot = NaN; cand_i = None; cand = NaN
        for i in range(n):
            # causal state machine
            if cand_i is None or bars.h[i] > cand:
                cand, cand_i = bars.h[i], i
            elif i - cand_i == p["confirm"]:
                top = cand; bot = min(bars.l[cand_i : i + 1])
            elif i - cand_i > p["confirm"] and ok(top):
                bot = min(bot, bars.l[i]) if bars.c[i] >= bot else bot
            if not ok(top, bot, a[i]) or i == 0: continue
            if bars.c[i] > top and ok(vr[i]) and vr[i] >= p["vol_mult"] and bars.c[i - 1] <= top:
                pl.signal[i] = 1
                pl.stop_dist[i] = max(bars.c[i] - bot, 0.5 * a[i])
            else:
                pl.stop_dist[i] = max(bars.c[i] - bot, 0.5 * a[i])
            pl.exit_signal[i] = bars.c[i] < bot
        return pl


class VolatilityContractionPattern(Strategy):
    spec = StrategySpec(
        id="volatility_contraction_pattern", name="Volatility Contraction Pattern (VCP)", family="breakout",
        summary="Stage-2 uptrend, successively shallower pullbacks with volume dry-up, then a high-volume pivot breakout.",
        timeframe="1d", required_data=["OHLC", "volume"],
        entry_rules=["Trend template: close > SMA150 > SMA200, SMA200 rising over 20 bars, close >= 1.25 x 252-bar low, within 25% of 252-bar high",
                     "Last 3 confirmed swing high->low pullbacks have strictly decreasing depth and the last depth <= max_last_depth",
                     "10-bar average volume <= dry_up x 50-bar average", "Close > last swing high (pivot) with volume >= 1.4 x 50-bar average"],
        exit_rules=["Close < SMA50 (momentum failure)", "Stop"], stop_loss="Greater of pivot x (1 - stop_pct) and the last contraction low",
        position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Pattern recognition is subjective; this is one rule-based interpretation", "Designed for individual growth stocks in bull markets: weak/untested elsewhere",
                          "Few signals; results can hinge on a handful of trades", "Survivorship bias if run on today's winners only"],
        params_default={"max_last_depth": 0.10, "dry_up": 0.8, "stop_pct": 0.08, "pivot_k": 3}, param_grid={"max_last_depth": [0.08, 0.12], "dry_up": [0.7, 0.9]},
        fidelity="partial", fidelity_note="Fundamental criteria (SEPA earnings) and relative-strength ranking across a universe are not included.", legacy_modules=["minervini_vcp"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); self.require_volume(bars); p = self.params; n = len(bars)
        s150, s200, s50 = ind.sma(bars.c, 150), ind.sma(bars.c, 200), ind.sma(bars.c, 50)
        hi252, lo252 = ind.highest(bars.h, 252), ind.lowest(bars.l, 252)
        v10, v50 = ind.sma(bars.v, 10), ind.sma(bars.v, 50)
        sh, sl = swing_pivots(bars.h, bars.l, p["pivot_k"])
        pl = self.empty_trade_plan(n)
        shp = 0
        for i in range(n):
            while shp < len(sh) and sh[shp][1] <= i: shp += 1
            if not ok(s150[i], s200[i], s50[i], hi252[i], lo252[i], v10[i], v50[i]) or i < 20 + 1: continue
            if not ok(s200[i - 20]): continue
            hs = sh[:shp][-3:]
            depths, last_low = [], NaN
            for hp in hs:  # lowest confirmed swing low between this high and the next pivot/now
                nxt = [x for x in sl if hp[0] < x[0] and x[1] <= i]
                if not nxt: depths.append(NaN); continue
                lowp = nxt[0][2]; depths.append((hp[2] - lowp) / hp[2]); last_low = lowp
            template = (bars.c[i] > s150[i] > s200[i] and s200[i] > s200[i - 20] and bars.c[i] >= 1.25 * lo252[i] and bars.c[i] >= 0.75 * hi252[i])
            contr = len(depths) == 3 and all(ok(d) for d in depths) and depths[0] > depths[1] > depths[2] and depths[2] <= p["max_last_depth"]
            dry = v10[i] <= p["dry_up"] * v50[i]
            pivot = hs[-1][2] if hs else NaN
            if template and contr and dry and ok(pivot, last_low) and bars.c[i] > pivot and bars.v[i] >= 1.4 * v50[i] and bars.c[i - 1] <= pivot:
                pl.signal[i] = 1
            if ok(pivot, last_low):
                stop_px = max(pivot * (1 - p["stop_pct"]), last_low)
                pl.stop_dist[i] = max(bars.c[i] - stop_px, 0.5 * (bars.h[i] - bars.l[i]) + 1e-9)
            pl.exit_signal[i] = bars.c[i] < s50[i]
        return pl

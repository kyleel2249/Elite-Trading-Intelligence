"""Quantitative, volatility and macro modules."""
from __future__ import annotations

import math

from app.strategies import indicators as ind
from app.strategies.base import Strategy, ok
from app.strategies.types import Bars, MissingData, Plan, StrategySpec

NaN = float("nan")
_COST = {"fee_bps_per_side": 10.0, "slippage_bps_per_side": 3.0, "half_spread_bps": 1.5,
         "note": "Defaults model a liquid spot crypto venue (0.10% taker fee). Override CostModel for your market."}


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


class QuantitativeTrading(Strategy):
    spec = StrategySpec(
        id="quantitative_trading", name="Quantitative Multi-Factor (time-series)", family="quant",
        summary="Blend standardised momentum, short-term reversal and low-volatility factors into one score; exposure is proportional to the score and volatility-scaled.",
        timeframe="1h-1d (rebalance every `rebalance` bars)", required_data=["close"],
        entry_rules=["Each factor is z-scored against its own trailing 252 bars (causal)", "score = w_mom*mom + w_rev*rev + w_vol*lowvol; exposure = clip(score / z_cap) x vol scale; trades only if |change| >= deadband"],
        exit_rules=["Exposure decays to 0 as score -> 0 (long-only clips negatives)"], stop_loss="No price stop; exposure cap and vol scaling bound risk. Pair with an external drawdown kill-switch",
        position_sizing="Exposure in [0,1] (or [-1,1]) = clipped score x min(1, vol_target / realised vol)", expected_costs=_COST,
        known_weaknesses=["Factor weights are priors, not fitted; any tuning on the test window is data mining", "Single-asset time-series factors have far less breadth than cross-sectional quant books",
                          "Factor crowding and decay", "Many degrees of freedom: needs strict out-of-sample discipline"],
        params_default={"mom_len": 60, "mom_skip": 5, "w_mom": 1.0, "w_rev": 0.5, "w_vol": 0.5, "z_cap": 2.0, "vol_target": 0.01, "rebalance": 6, "deadband": 0.1, "allow_short": False},
        param_grid={"mom_len": [60, 120], "w_rev": [0.0, 0.5], "rebalance": [6, 24]}, mode="exposure", supports_short=True, legacy_modules=["simons_quant"])

    def plan(self, bars: Bars, aux=None) -> Plan:
        p = self.params; n = len(bars); c = bars.c
        mom = [NaN] * n; rev = ind.roc(c, 5); rv = ind.realized_vol(c, 20)
        for i in range(p["mom_len"] + p["mom_skip"], n):
            j = i - p["mom_skip"]
            mom[i] = c[j] / c[j - p["mom_len"]] - 1
        zm = self._z(mom); zr = self._z([-x if ok(x) else NaN for x in rev]); zv = self._z([-x if ok(x) else NaN for x in rv])
        pl = Plan(mode="exposure", exposure=[0.0] * n); cur = 0.0; wsum = p["w_mom"] + p["w_rev"] + p["w_vol"]
        for i in range(n):
            if i % p["rebalance"] == 0 and ok(zm[i], zr[i], zv[i], rv[i]) and rv[i] > 0 and wsum > 0:
                score = (p["w_mom"] * zm[i] + p["w_rev"] * zr[i] + p["w_vol"] * zv[i]) / wsum
                tgt = _clip(score / p["z_cap"], -1.0, 1.0) * min(1.0, p["vol_target"] / rv[i])
                if not self.short_ok(): tgt = max(tgt, 0.0)
                if abs(tgt - cur) >= p["deadband"] * min(1.0, p["vol_target"] / rv[i]) or tgt == 0.0: cur = tgt
            pl.exposure[i] = cur
        return pl

    @staticmethod
    def _z(series, win: int = 252):
        """Causal rolling z-score tolerant of NaN warm-up values."""
        out = [NaN] * len(series)
        for i in range(len(series)):
            w = [x for x in series[max(0, i - win + 1) : i + 1] if ok(x)]
            if len(w) >= 60 and ok(series[i]):
                m = sum(w) / len(w); sd = math.sqrt(sum((x - m) ** 2 for x in w) / (len(w) - 1))
                if sd > 0: out[i] = (series[i] - m) / sd
        return out


class VolatilityTrading(Strategy):
    spec = StrategySpec(
        id="volatility_trading", name="Volatility Compression -> Expansion (spot proxy)", family="volatility",
        summary="Trade the direction of the first range expansion after an unusually tight volatility squeeze.",
        timeframe="1h-1d", required_data=["OHLC", "full fidelity (variance risk premium, straddles, VIX/vol futures) would need options chains and implied volatility history"],
        entry_rules=["Bollinger bandwidth percent-rank over 100 bars <= squeeze_pr at any of the last 5 bars", "Close > prior 20-bar high -> long (close < prior 20-bar low -> short if allowed)"],
        exit_rules=["Close back below SMA(20) (long-only)", "Trailing stop"], stop_loss="atr_mult x ATR(14), trailed", position_sizing="risk_pct / stop distance, leverage-capped", expected_costs=_COST,
        known_weaknesses=["Does NOT trade volatility as an asset: no options, no VIX products, no variance risk premium", "Squeezes often resolve into false breaks", "Direction is a coin-flip unless trend persists"],
        params_default={"squeeze_pr": 0.2, "atr_mult": 2.0, "allow_short": False}, param_grid={"squeeze_pr": [0.1, 0.2, 0.3], "atr_mult": [1.5, 2.5]},
        supports_short=True, fidelity="proxy", fidelity_note="Spot-only squeeze/expansion proxy. True volatility trading (implied vs realised, term structure, options) is blocked pending implied-vol data.")

    def plan(self, bars: Bars, aux=None) -> Plan:
        self.require_ohlc(bars); p = self.params; n = len(bars)
        m, s = ind.sma(bars.c, 20), ind.stdev(bars.c, 20)
        bw = [(4 * s[i] / m[i]) if ok(s[i], m[i]) and m[i] > 0 else NaN for i in range(n)]
        pr = ind.percent_rank(bw, 100); hh, ll = ind.highest(bars.h, 20, 1), ind.lowest(bars.l, 20, 1); a = ind.atr(bars.h, bars.l, bars.c, 14)
        pl = self.empty_trade_plan(n); pl.trail = True; sh = self.short_ok(); pl.reverse = sh
        for i in range(5, n):
            if not ok(hh[i], ll[i], a[i], m[i]): continue
            squeezed = any(ok(pr[j]) and pr[j] <= p["squeeze_pr"] for j in range(i - 4, i + 1))
            if squeezed and bars.c[i] > hh[i]: pl.signal[i] = 1
            elif squeezed and sh and bars.c[i] < ll[i]: pl.signal[i] = -1
            pl.stop_dist[i] = p["atr_mult"] * a[i]
            pl.exit_signal[i] = (not sh) and bars.c[i] < m[i]
        return pl


class MacroTrading(Strategy):
    spec = StrategySpec(
        id="macro_trading", name="Macro Regime Tilt (ex-ante thesis signs + trend confirmation)", family="macro",
        summary="Tilt exposure by a composite of macro indicators (e.g. liquidity, real yields, dollar, credit spreads) whose direction of effect is declared before testing, and only while price trend agrees.",
        timeframe="1d-1w", required_data=["close", "point-in-time macro series aligned to bars (as first published, available at the bar)", "params.signs: {series: +1/-1} declared ex-ante"],
        entry_rules=["score = mean(sign_k x zscore_252(change over change_len of series k))", "exposure = clip(score / 2, 0, 1) while close > SMA(trend_len)"],
        exit_rules=["score <= 0 or trend filter fails -> flat (or short if allow_short)"], stop_loss="No price stop; trend filter and exposure cap. Add an external drawdown kill-switch",
        position_sizing="Exposure in [0,1] ([-1,1] with shorts) proportional to the macro score", expected_costs=_COST,
        known_weaknesses=["Macro data are revised: only first-release (point-in-time) series are valid", "Few independent macro regimes in history: tiny effective sample", "Causal direction is a hypothesis; correlations flip between regimes",
                          "Signs are a human prior - choosing them after seeing results is data mining"],
        params_default={"signs": {}, "change_len": 20, "trend_len": 100, "rebalance": 24, "allow_short": False}, param_grid={"change_len": [20, 60], "trend_len": [50, 100]},
        mode="exposure", supports_short=True, required_aux=["macro"], legacy_modules=["soros_reflexivity", "druck_liquidity_macro"], default_interval="1d")

    def plan(self, bars: Bars, aux=None) -> Plan:
        n = len(bars); p = self.params
        a = self.require_aux(aux, ["macro"], n); macro = a["macro"]
        signs = p["signs"]
        if not signs or any(s not in (-1, 1) for s in signs.values()): raise MissingData(self.spec.id, ["params.signs"], "declare +1/-1 per macro series before testing")
        absent = [k for k in signs if k not in macro]
        if absent: raise MissingData(self.spec.id, [f"macro.{k}" for k in absent])
        sma_t = ind.sma(bars.c, p["trend_len"]); L = p["change_len"]
        zs = {}
        for k in signs:
            s = macro[k]; ch = [NaN] * n
            for i in range(L, n):
                if ok(s[i], s[i - L]): ch[i] = s[i] - s[i - L]
            zs[k] = QuantitativeTrading._z(ch)
        pl = Plan(mode="exposure", exposure=[0.0] * n); cur = 0.0
        for i in range(n):
            if i % p["rebalance"] == 0 and ok(sma_t[i]) and all(ok(zs[k][i]) for k in signs):
                score = sum(signs[k] * zs[k][i] for k in signs) / len(signs)
                up = bars.c[i] > sma_t[i]
                if score > 0 and up: cur = _clip(score / 2, 0.0, 1.0)
                elif score < 0 and not up and self.short_ok(): cur = -_clip(-score / 2, 0.0, 1.0)
                else: cur = 0.0
            pl.exposure[i] = cur
        return pl

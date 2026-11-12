"""Continuous Market Regime Intelligence Engine."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
import math
import statistics


class RegimeLabel(str, Enum):
    STRONG_BULL = "strong_bull"
    WEAK_BULL = "weak_bull"
    STRONG_BEAR = "strong_bear"
    WEAK_BEAR = "weak_bear"
    SIDEWAYS = "sideways"
    HIGH_VOLATILITY = "high_volatility"
    LOW_VOLATILITY = "low_volatility"
    EXPANDING_VOLATILITY = "expanding_volatility"
    CONTRACTING_VOLATILITY = "contracting_volatility"
    RISK_ON = "risk_on"
    RISK_OFF = "risk_off"
    LIQUIDITY_EXPANSION = "liquidity_expansion"
    LIQUIDITY_CONTRACTION = "liquidity_contraction"
    ACCUMULATION = "accumulation"
    DISTRIBUTION = "distribution"
    BREAKOUT = "breakout"
    FAILED_BREAKOUT = "failed_breakout"
    MARKET_DISLOCATION = "market_dislocation"
    CRISIS = "crisis"
    TRANSITIONAL = "transitional"
    UNCERTAIN = "uncertain"


@dataclass
class RegimeSnapshot:
    symbol: str
    provider: str
    primary_regime: str
    coexisting: list[str]
    probabilities: dict[str, float]
    confidence: float
    evidence: list[str]
    strategy_suitability: dict[str, float]
    previous_regime: Optional[str]
    transition_ts: Optional[str]
    metrics: dict[str, float]
    assessed_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _returns(closes: list[float]) -> list[float]:
    out = []
    for i in range(1, len(closes)):
        if closes[i - 1] and closes[i - 1] != 0:
            out.append((closes[i] - closes[i - 1]) / closes[i - 1])
    return out


def _vol(returns: list[float]) -> float:
    if len(returns) < 2:
        return 0.0
    return statistics.stdev(returns) * math.sqrt(252) if len(returns) > 1 else 0.0


class MarketRegimeEngine:
    """Classify regime(s) from price/volume series without forcing a single label."""

    TREND_LOOKBACK = 20
    VOL_LOOKBACK = 20
    LONG_VOL_LOOKBACK = 60

    def assess(
        self,
        symbol: str,
        provider: str,
        closes: list[float],
        volumes: Optional[list[float]] = None,
        previous: Optional[RegimeSnapshot] = None,
        extra_metrics: Optional[dict[str, float]] = None,
    ) -> RegimeSnapshot:
        metrics: dict[str, float] = dict(extra_metrics or {})
        evidence: list[str] = []
        probs: dict[str, float] = {r.value: 0.0 for r in RegimeLabel}
        coexisting: list[str] = []

        n = len(closes)
        if n < 5:
            return RegimeSnapshot(
                symbol=symbol,
                provider=provider,
                primary_regime=RegimeLabel.UNCERTAIN.value,
                coexisting=[],
                probabilities={RegimeLabel.UNCERTAIN.value: 1.0},
                confidence=0.1,
                evidence=["insufficient_bars"],
                strategy_suitability={},
                previous_regime=previous.primary_regime if previous else None,
                transition_ts=None,
                metrics=metrics,
                assessed_at=datetime.now(timezone.utc).isoformat(),
            )

        rets = _returns(closes)
        short_rets = rets[-self.TREND_LOOKBACK :] if len(rets) >= self.TREND_LOOKBACK else rets
        trend = sum(short_rets) if short_rets else 0.0
        metrics["trend_return"] = round(trend, 6)
        vol = _vol(short_rets[-self.VOL_LOOKBACK :] if len(short_rets) >= 5 else short_rets)
        metrics["realized_vol_ann"] = round(vol, 6)
        long_vol = _vol(rets[-self.LONG_VOL_LOOKBACK :] if len(rets) >= 10 else rets)
        metrics["long_vol_ann"] = round(long_vol, 6)

        # Trend regimes
        if trend > 0.08:
            probs[RegimeLabel.STRONG_BULL.value] = 0.55
            evidence.append(f"strong_uptrend_{trend:.3f}")
        elif trend > 0.02:
            probs[RegimeLabel.WEAK_BULL.value] = 0.45
            evidence.append(f"weak_uptrend_{trend:.3f}")
        elif trend < -0.08:
            probs[RegimeLabel.STRONG_BEAR.value] = 0.55
            evidence.append(f"strong_downtrend_{trend:.3f}")
        elif trend < -0.02:
            probs[RegimeLabel.WEAK_BEAR.value] = 0.45
            evidence.append(f"weak_downtrend_{trend:.3f}")
        else:
            probs[RegimeLabel.SIDEWAYS.value] = 0.5
            evidence.append("range_bound")

        # Volatility regimes (can coexist)
        if vol > 0.6:
            probs[RegimeLabel.HIGH_VOLATILITY.value] = max(probs[RegimeLabel.HIGH_VOLATILITY.value], 0.5)
            coexisting.append(RegimeLabel.HIGH_VOLATILITY.value)
            evidence.append(f"high_vol_{vol:.3f}")
        elif vol < 0.15 and vol > 0:
            probs[RegimeLabel.LOW_VOLATILITY.value] = max(probs[RegimeLabel.LOW_VOLATILITY.value], 0.45)
            coexisting.append(RegimeLabel.LOW_VOLATILITY.value)
            evidence.append(f"low_vol_{vol:.3f}")

        if long_vol > 0 and vol > long_vol * 1.35:
            probs[RegimeLabel.EXPANDING_VOLATILITY.value] = 0.4
            coexisting.append(RegimeLabel.EXPANDING_VOLATILITY.value)
            evidence.append("vol_expansion")
        elif long_vol > 0 and vol < long_vol * 0.7:
            probs[RegimeLabel.CONTRACTING_VOLATILITY.value] = 0.4
            coexisting.append(RegimeLabel.CONTRACTING_VOLATILITY.value)
            evidence.append("vol_contraction")

        # Volume / liquidity proxies
        if volumes and len(volumes) >= 10:
            recent_v = statistics.mean(volumes[-5:])
            base_v = statistics.mean(volumes[-20:]) if len(volumes) >= 20 else statistics.mean(volumes)
            metrics["volume_ratio"] = round(recent_v / base_v, 4) if base_v else 1.0
            if metrics["volume_ratio"] > 1.5 and trend > 0:
                probs[RegimeLabel.ACCUMULATION.value] = 0.35
                coexisting.append(RegimeLabel.ACCUMULATION.value)
            elif metrics["volume_ratio"] > 1.5 and trend < 0:
                probs[RegimeLabel.DISTRIBUTION.value] = 0.35
                coexisting.append(RegimeLabel.DISTRIBUTION.value)
            if metrics["volume_ratio"] < 0.5:
                probs[RegimeLabel.LIQUIDITY_CONTRACTION.value] = 0.3
                coexisting.append(RegimeLabel.LIQUIDITY_CONTRACTION.value)

        # Crisis / dislocation heuristics
        if vol > 1.0 and abs(trend) > 0.12:
            probs[RegimeLabel.CRISIS.value] = 0.35
            coexisting.append(RegimeLabel.CRISIS.value)
            evidence.append("crisis_vol_trend")
        if abs(trend) > 0.15 and vol > 0.8:
            probs[RegimeLabel.MARKET_DISLOCATION.value] = 0.3
            coexisting.append(RegimeLabel.MARKET_DISLOCATION.value)

        # Breakout detection (simple range break)
        if n >= 30:
            window = closes[-30:-5]
            if window:
                hi, lo = max(window), min(window)
                last = closes[-1]
                rng = hi - lo if hi != lo else 1e-9
                if last > hi + 0.01 * rng:
                    probs[RegimeLabel.BREAKOUT.value] = 0.4
                    coexisting.append(RegimeLabel.BREAKOUT.value)
                    evidence.append("price_breakout_high")
                elif last < lo - 0.01 * rng:
                    probs[RegimeLabel.BREAKOUT.value] = 0.35
                    coexisting.append(RegimeLabel.BREAKOUT.value)
                    evidence.append("price_breakout_low")

        # Risk-on / risk-off from trend + vol
        if trend > 0.03 and vol < 0.4:
            probs[RegimeLabel.RISK_ON.value] = 0.35
            coexisting.append(RegimeLabel.RISK_ON.value)
        elif trend < -0.03 and vol > 0.4:
            probs[RegimeLabel.RISK_OFF.value] = 0.35
            coexisting.append(RegimeLabel.RISK_OFF.value)

        # Normalize probabilities
        total = sum(probs.values()) or 1.0
        probs = {k: round(v / total, 4) for k, v in probs.items() if v > 0}
        if not probs:
            probs = {RegimeLabel.UNCERTAIN.value: 1.0}

        primary = max(probs, key=probs.get)
        confidence = min(0.95, max(0.15, probs[primary] + 0.1 * len(evidence) / 10))

        prev = previous.primary_regime if previous else None
        transition_ts = None
        if prev and prev != primary:
            transition_ts = datetime.now(timezone.utc).isoformat()
            if confidence < 0.45:
                coexisting.append(RegimeLabel.TRANSITIONAL.value)
                probs[RegimeLabel.TRANSITIONAL.value] = probs.get(RegimeLabel.TRANSITIONAL.value, 0) + 0.2

        suitability = self._strategy_suitability(primary, coexisting, metrics)

        return RegimeSnapshot(
            symbol=symbol,
            provider=provider,
            primary_regime=primary,
            coexisting=list(dict.fromkeys(coexisting)),
            probabilities=probs,
            confidence=round(confidence, 4),
            evidence=evidence,
            strategy_suitability=suitability,
            previous_regime=prev,
            transition_ts=transition_ts,
            metrics=metrics,
            assessed_at=datetime.now(timezone.utc).isoformat(),
        )

    def _strategy_suitability(
        self, primary: str, coexisting: list[str], metrics: dict[str, float]
    ) -> dict[str, float]:
        """Heuristic compatibility scores for known strategy families."""
        scores = {
            "turtle_trend": 0.5,
            "soros_reflexivity": 0.4,
            "druck_liquidity_macro": 0.45,
            "ptj_structure_preservation": 0.5,
            "mean_reversion": 0.4,
            "breakout": 0.4,
            "vcp": 0.4,
            "statistical_arb": 0.35,
        }
        if primary in (RegimeLabel.STRONG_BULL.value, RegimeLabel.WEAK_BULL.value, RegimeLabel.STRONG_BEAR.value):
            scores["turtle_trend"] = 0.85
            scores["breakout"] = 0.75
            scores["mean_reversion"] = 0.25
        if primary == RegimeLabel.SIDEWAYS.value or RegimeLabel.LOW_VOLATILITY.value in coexisting:
            scores["mean_reversion"] = 0.8
            scores["vcp"] = 0.7
            scores["turtle_trend"] = 0.3
        if RegimeLabel.HIGH_VOLATILITY.value in coexisting or primary == RegimeLabel.CRISIS.value:
            scores["ptj_structure_preservation"] = 0.9
            scores["turtle_trend"] = 0.35
            scores["mean_reversion"] = 0.2
        if RegimeLabel.BREAKOUT.value in coexisting:
            scores["breakout"] = 0.85
            scores["turtle_trend"] = 0.7
        if RegimeLabel.EXPANDING_VOLATILITY.value in coexisting:
            scores["druck_liquidity_macro"] = 0.7
        return {k: round(v, 3) for k, v in scores.items()}

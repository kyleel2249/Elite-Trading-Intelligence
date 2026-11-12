"""
Predictive Intelligence scaffold — Lars Hagen.

All outputs are probabilistic. No exact future prices or guaranteed turning points.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from statistics import mean, pstdev
from math import isfinite
from typing import Any, Optional

from app.intelligence.traders import ELITE_TRADERS


@dataclass
class ScenarioForecast:
    symbol: str
    provider: str
    horizon: str
    last_price: float
    bull_price: float
    base_price: float
    bear_price: float
    expected_vol: float
    confidence: float
    entry_zone: tuple[float, float]
    stop_zone: tuple[float, float]
    take_profit_zone: tuple[float, float]
    assumptions: list[str]
    limitations: list[str]
    analyst: str = "Lars Hagen"
    model_version: str = "v0-scaffold"
    methodology: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "provider": self.provider,
            "horizon": self.horizon,
            "last_price": self.last_price,
            "scenarios": {
                "bull": self.bull_price,
                "base": self.base_price,
                "bear": self.bear_price,
            },
            "expected_vol": self.expected_vol,
            "confidence": self.confidence,
            "entry_zone": list(self.entry_zone),
            "stop_zone": list(self.stop_zone),
            "take_profit_zone": list(self.take_profit_zone),
            "assumptions": self.assumptions,
            "limitations": self.limitations,
            "analyst": self.analyst,
            "analyst_title": ELITE_TRADERS["predictive"].title,
            "methods": self.methodology or ELITE_TRADERS["predictive"].methods,
            "model_version": self.model_version,
            "disclaimer": "Probabilistic research output only — not a guarantee of future prices.",
            "timestamp": self.timestamp,
        }


class PredictiveEngine:
    """
    Lightweight probabilistic scaffold using recent returns volatility.
    Replaceable later with calibrated models; interface stays stable.
    """

    def forecast(
        self,
        *,
        symbol: str,
        provider: str,
        klines: list[dict[str, Any]],
        horizon: str = "intraday",
    ) -> Optional[ScenarioForecast]:
        # Refuse corrupt history rather than emitting NaN/Infinity or bridging bad bars.
        try:
            closes = [float(k["close"]) for k in klines]
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        if any(k.get("data_status") == "invalid" for k in klines):
            return None
        if any(not isfinite(px) or px <= 0 for px in closes):
            return None
        if len(closes) < 10:
            return None

        last = closes[-1]
        rets = []
        for i in range(1, len(closes)):
            if closes[i - 1] > 0:
                rets.append((closes[i] - closes[i - 1]) / closes[i - 1])
        if len(rets) < 5:
            return None

        vol = pstdev(rets) if len(rets) > 1 else abs(mean(rets))
        # Horizon scaling (very approximate scaffold)
        scale = {"scalp": 0.5, "intraday": 1.0, "swing": 2.0, "position": 3.5}.get(horizon, 1.0)
        move = last * vol * scale * 1.5

        bull = last + move
        bear = max(last - move, last * 0.01)
        base = last + (mean(rets) * last * scale)

        conf = max(0.15, min(0.55, 0.5 - vol * 2))  # higher vol → lower confidence

        profile = ELITE_TRADERS["predictive"]
        return ScenarioForecast(
            symbol=symbol.upper(),
            provider=provider,
            horizon=horizon,
            last_price=last,
            bull_price=round(bull, 8),
            base_price=round(base, 8),
            bear_price=round(bear, 8),
            expected_vol=round(vol, 6),
            confidence=round(conf, 3),
            entry_zone=(round(min(last, base), 8), round(max(last, base), 8)),
            stop_zone=(round(bear, 8), round(min(last, base), 8)),
            take_profit_zone=(round(max(last, base), 8), round(bull, 8)),
            assumptions=[
                "Recent return volatility is informative for near-term range",
                "No regime break mid-horizon",
                f"Horizon scale factor={scale}",
            ],
            limitations=[
                "Scaffold model — not walk-forward validated",
                "Does not incorporate order-book or macro shocks",
                "Confidence is heuristic, not calibrated probability",
            ]
            + profile.evidence_standards,
            methodology=profile.methods,
        )

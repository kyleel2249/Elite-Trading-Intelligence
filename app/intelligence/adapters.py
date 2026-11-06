"""
Fundamental / Macro / Sentiment adapters.
Unlock Marcus Okonkwo, Sofia Rahman, Priya Nair from pure neutral abstention
when minimal structured inputs are available.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from app.intelligence.traders import ELITE_TRADERS


@dataclass
class DeskSignal:
    bias: str  # bullish | bearish | neutral
    confidence: float
    evidence: list[str]
    methods_applied: list[str]
    limitations: list[str]


class FundamentalAdapter:
    """Marcus Okonkwo — relative simple proxies from market structure."""

    def analyse(
        self,
        *,
        symbol: str,
        price: Optional[float],
        klines: Optional[list[dict[str, Any]]],
        context: Optional[dict[str, Any]] = None,
    ) -> DeskSignal:
        profile = ELITE_TRADERS["fa"]
        context = context or {}
        if not klines or len(klines) < 20 or price is None:
            return DeskSignal(
                bias="neutral",
                confidence=0.2,
                evidence=[],
                methods_applied=profile.methods[:1],
                limitations=["Insufficient series for relative-value proxy"] + profile.evidence_standards,
            )
        closes = [float(k["close"]) for k in klines if k.get("close")]
        sma20 = sum(closes[-20:]) / 20
        prem = (price - sma20) / sma20 if sma20 else 0
        evidence = [f"Price vs 20-SMA premium={prem:.2%}", f"SMA20={sma20:.6g}"]
        # Crude proxy: extended premium → cautious; discount → constructive
        if prem < -0.03:
            return DeskSignal("bullish", 0.4, evidence + ["Discount to recent mean"], profile.methods[:2], ["Proxy only — not issuer fundamentals"])
        if prem > 0.05:
            return DeskSignal("bearish", 0.35, evidence + ["Extended premium to mean"], profile.methods[:2], ["Proxy only — not issuer fundamentals"])
        return DeskSignal("neutral", 0.3, evidence, profile.methods[:2], ["No strong relative dislocation"])


class MacroAdapter:
    """Sofia Rahman — session/vol regime proxy without external macro API."""

    def analyse(
        self,
        *,
        klines: Optional[list[dict[str, Any]]],
        order_book: Optional[dict[str, Any]] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> DeskSignal:
        profile = ELITE_TRADERS["macro"]
        if not klines or len(klines) < 15:
            return DeskSignal(
                bias="neutral",
                confidence=0.2,
                evidence=[],
                methods_applied=profile.methods[:1],
                limitations=["No macro feed; insufficient price history for regime proxy"]
                + profile.evidence_standards,
            )
        closes = [float(k["close"]) for k in klines if k.get("close")]
        rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes)) if closes[i - 1]]
        if len(rets) < 5:
            return DeskSignal("neutral", 0.2, [], profile.methods[:1], ["Insufficient returns"])
        import statistics

        vol = statistics.pstdev(rets)
        evidence = [f"Realized vol (proxy)={vol:.4f}"]
        spread_bps = (order_book or {}).get("spread_bps")
        if spread_bps is not None:
            evidence.append(f"Spread_bps={spread_bps}")
        # High vol → defensive neutral/bearish risk-off tilt
        if vol > 0.02:
            return DeskSignal(
                "bearish",
                0.4,
                evidence + ["Elevated vol regime — risk-off tilt"],
                ["Cross-asset correlation regimes", "Session and calendar risk windows"],
                ["Proxy from price vol only — no FRED/rates feed in this build"],
            )
        if vol < 0.005:
            return DeskSignal(
                "bullish",
                0.35,
                evidence + ["Compressed vol regime"],
                ["Global liquidity and USD strength framing"],
                ["Proxy only"],
            )
        return DeskSignal("neutral", 0.3, evidence, profile.methods[:2], ["Mid-vol regime"])


class SentimentAdapter:
    """Priya Nair — momentum crowding proxy until news feed is connected."""

    def analyse(
        self,
        *,
        klines: Optional[list[dict[str, Any]]],
        context: Optional[dict[str, Any]] = None,
    ) -> DeskSignal:
        profile = ELITE_TRADERS["sentiment"]
        context = context or {}
        # Optional external sentiment score in context: -1 .. +1
        if "sentiment_score" in context:
            score = float(context["sentiment_score"])
            bias = "bullish" if score > 0.15 else ("bearish" if score < -0.15 else "neutral")
            return DeskSignal(
                bias,
                min(0.7, abs(score)),
                [f"External sentiment_score={score}"],
                profile.methods[:2],
                [],
            )
        if not klines or len(klines) < 10:
            return DeskSignal(
                "neutral",
                0.2,
                [],
                profile.methods[:1],
                ["No news feed; insufficient price history for crowding proxy"]
                + profile.evidence_standards,
            )
        closes = [float(k["close"]) for k in klines if k.get("close")]
        chg = (closes[-1] - closes[-10]) / closes[-10] if closes[-10] else 0
        evidence = [f"10-bar momentum={chg:.2%}"]
        if chg > 0.04:
            return DeskSignal(
                "bullish",
                0.35,
                evidence + ["Positive momentum crowding proxy"],
                ["Sentiment polarity and crowding proxies"],
                ["Not news-derived — price momentum proxy only"],
            )
        if chg < -0.04:
            return DeskSignal(
                "bearish",
                0.35,
                evidence + ["Negative momentum crowding proxy"],
                ["Sentiment polarity and crowding proxies"],
                ["Not news-derived — price momentum proxy only"],
            )
        return DeskSignal("neutral", 0.25, evidence, profile.methods[:1], ["No extreme crowding proxy"])

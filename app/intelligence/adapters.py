"""
Fundamental / Macro / Sentiment adapters.
Marcus Okonkwo, Sofia Rahman, Priya Nair — use price proxies and optional external feeds.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from app.intelligence.traders import ELITE_TRADERS


@dataclass
class DeskSignal:
    bias: str
    confidence: float
    evidence: list[str]
    methods_applied: list[str]
    limitations: list[str]


class FundamentalAdapter:
    """Marcus Okonkwo."""

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
        if prem < -0.03:
            return DeskSignal(
                "bullish",
                0.4,
                evidence + ["Discount to recent mean"],
                profile.methods[:2],
                ["Proxy only — not issuer fundamentals"],
            )
        if prem > 0.05:
            return DeskSignal(
                "bearish",
                0.35,
                evidence + ["Extended premium to mean"],
                profile.methods[:2],
                ["Proxy only — not issuer fundamentals"],
            )
        return DeskSignal("neutral", 0.3, evidence, profile.methods[:2], ["No strong relative dislocation"])


class MacroAdapter:
    """Sofia Rahman — vol regime + optional FRED context."""

    def analyse(
        self,
        *,
        klines: Optional[list[dict[str, Any]]],
        order_book: Optional[dict[str, Any]] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> DeskSignal:
        profile = ELITE_TRADERS["macro"]
        context = context or {}
        evidence: list[str] = []
        methods = list(profile.methods[:2])
        limitations: list[str] = []

        fred = context.get("fred") or {}
        if fred.get("status") == "ok" and fred.get("latest"):
            latest = fred["latest"]
            evidence.append(f"FRED {fred.get('series_id')}={latest.get('value')} @ {latest.get('date')}")
            if fred.get("change") is not None:
                evidence.append(f"FRED change={fred['change']}")
            methods.append("Policy path and surprise sensitivity")
        elif fred.get("status") == "not_configured":
            limitations.append("FRED_API_KEY not configured")

        if not klines or len(klines) < 15:
            if evidence:
                # FRED-only thin signal
                chg = fred.get("change")
                if chg is not None and chg > 0.05:
                    return DeskSignal("bearish", 0.35, evidence + ["Rising policy rate proxy"], methods, limitations + ["Thin macro sample"])
                if chg is not None and chg < -0.05:
                    return DeskSignal("bullish", 0.35, evidence + ["Easing policy rate proxy"], methods, limitations + ["Thin macro sample"])
            return DeskSignal(
                "neutral",
                0.2,
                evidence,
                methods[:1],
                limitations + ["Insufficient price history for regime proxy"] + profile.evidence_standards,
            )

        closes = [float(k["close"]) for k in klines if k.get("close")]
        rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes)) if closes[i - 1]]
        if len(rets) < 5:
            return DeskSignal("neutral", 0.2, evidence, methods[:1], limitations + ["Insufficient returns"])

        import statistics

        vol = statistics.pstdev(rets)
        evidence.append(f"Realized vol (proxy)={vol:.4f}")
        spread_bps = (order_book or {}).get("spread_bps")
        if spread_bps is not None:
            evidence.append(f"Spread_bps={spread_bps}")

        if vol > 0.02:
            return DeskSignal(
                "bearish",
                0.4,
                evidence + ["Elevated vol regime — risk-off tilt"],
                methods + ["Cross-asset correlation regimes"],
                limitations + (["Vol proxy primary"] if fred.get("status") != "ok" else []),
            )
        if vol < 0.005:
            return DeskSignal(
                "bullish",
                0.35,
                evidence + ["Compressed vol regime"],
                methods,
                limitations,
            )
        return DeskSignal("neutral", 0.3, evidence, methods, limitations + ["Mid-vol regime"])


class SentimentAdapter:
    """Priya Nair — news feed when configured, else momentum crowding proxy."""

    def analyse(
        self,
        *,
        klines: Optional[list[dict[str, Any]]],
        context: Optional[dict[str, Any]] = None,
    ) -> DeskSignal:
        profile = ELITE_TRADERS["sentiment"]
        context = context or {}

        news = context.get("news") or {}
        if news.get("status") == "ok" and news.get("sentiment_score") is not None:
            score = float(news["sentiment_score"])
            bias = "bullish" if score > 0.15 else ("bearish" if score < -0.15 else "neutral")
            return DeskSignal(
                bias,
                min(0.65, 0.3 + abs(score)),
                [
                    f"News sentiment_score={score:.3f}",
                    f"Headlines={news.get('headline_count')}",
                    news.get("note") or "NewsAPI keyword polarity",
                ],
                profile.methods[:2] + ["Headline and event proximity"],
                ["Keyword polarity — not full NLP"],
            )

        if "sentiment_score" in context and not news:
            score = float(context["sentiment_score"])
            bias = "bullish" if score > 0.15 else ("bearish" if score < -0.15 else "neutral")
            return DeskSignal(
                bias,
                min(0.7, abs(score)),
                [f"External sentiment_score={score}"],
                profile.methods[:2],
                [],
            )

        if news.get("status") == "not_configured":
            extra_lim = ["NEWSAPI_KEY not configured"]
        else:
            extra_lim = []

        if not klines or len(klines) < 10:
            return DeskSignal(
                "neutral",
                0.2,
                [],
                profile.methods[:1],
                extra_lim + ["No news feed; insufficient price history"] + profile.evidence_standards,
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
                extra_lim + ["Not news-derived"],
            )
        if chg < -0.04:
            return DeskSignal(
                "bearish",
                0.35,
                evidence + ["Negative momentum crowding proxy"],
                ["Sentiment polarity and crowding proxies"],
                extra_lim + ["Not news-derived"],
            )
        return DeskSignal("neutral", 0.25, evidence, profile.methods[:1], extra_lim + ["No extreme crowding proxy"])

"""
AI Trading Council — evidence-based specialists + Risk Officer veto.
Does not generate recommendations from a single price tick.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional


class Action(str, Enum):
    STRONG_BUY = "STRONG_BUY"
    BUY = "BUY"
    STRONG_SELL = "STRONG_SELL"
    SELL = "SELL"
    WAIT = "WAIT"
    NO_TRADE = "NO_TRADE"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


@dataclass
class SpecialistReport:
    role: str
    analysis: str
    bias: str  # bullish | bearish | neutral
    confidence: float  # 0-1
    evidence: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class CouncilDecision:
    action: Action
    confidence: float
    summary: str
    specialist_reports: list[SpecialistReport]
    risk_veto: bool
    risk_notes: list[str]
    contradictory_signals: list[str]
    data_quality: str
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class TradingCouncil:
    """
    12-role council. Aggregation is evidence-weighted, not simple majority vote.
    Risk Management Officer has veto.
    """

    ROLES = [
        "Chief Investment Strategist",
        "Technical Analysis Specialist",
        "Fundamental Analysis Specialist",
        "Macroeconomic Analyst",
        "Quantitative Researcher",
        "Market Structure Analyst",
        "Liquidity Analyst",
        "News and Sentiment Analyst",
        "Predictive Intelligence Analyst",
        "Risk Management Officer",
        "Execution Analyst",
        "Portfolio Auditor",
    ]

    def analyse(
        self,
        *,
        symbol: str,
        provider: str,
        price: Optional[float],
        bid: Optional[float],
        ask: Optional[float],
        data_status: str,
        order_book: Optional[dict[str, Any]] = None,
        klines: Optional[list[dict[str, Any]]] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> CouncilDecision:
        context = context or {}
        reports: list[SpecialistReport] = []

        # --- Insufficient data gate ---
        if price is None or data_status in ("unavailable", "invalid") or not data_status:
            return CouncilDecision(
                action=Action.INSUFFICIENT_DATA,
                confidence=0.0,
                summary="Essential market data missing or invalid; no actionable recommendation.",
                specialist_reports=[],
                risk_veto=True,
                risk_notes=["Insufficient data"],
                contradictory_signals=[],
                data_quality=data_status or "unavailable",
            )

        if data_status in ("stale", "incomplete"):
            # Still produce analysis but force WAIT / NO_TRADE path later
            pass

        # Technical
        tech_bias, tech_conf, tech_ev = self._technical(klines, price)
        reports.append(
            SpecialistReport(
                role="Technical Analysis Specialist",
                analysis=f"Trend/momentum assessment for {symbol}",
                bias=tech_bias,
                confidence=tech_conf,
                evidence=tech_ev,
                assumptions=["OHLCV series is continuous and correctly timestamped"],
                limitations=["No multi-timeframe confluence yet"],
            )
        )

        # Liquidity / structure from order book
        liq_bias, liq_conf, liq_ev = self._liquidity(order_book)
        reports.append(
            SpecialistReport(
                role="Liquidity Analyst",
                analysis="Order-book imbalance and spread assessment",
                bias=liq_bias,
                confidence=liq_conf,
                evidence=liq_ev,
                assumptions=["Book snapshot is representative of near-term liquidity"],
                limitations=["Single snapshot; no hidden liquidity"],
            )
        )

        reports.append(
            SpecialistReport(
                role="Market Structure Analyst",
                analysis="Venue and microstructure notes",
                bias="neutral",
                confidence=0.4,
                evidence=[f"Provider={provider}", f"Data status={data_status}"],
                assumptions=[],
                limitations=["Cross-venue comparison not yet active"],
            )
        )

        # Placeholders for roles that need more data feeds (honest about limits)
        for role in [
            "Fundamental Analysis Specialist",
            "Macroeconomic Analyst",
            "News and Sentiment Analyst",
            "Predictive Intelligence Analyst",
            "Quantitative Researcher",
            "Chief Investment Strategist",
            "Execution Analyst",
            "Portfolio Auditor",
        ]:
            reports.append(
                SpecialistReport(
                    role=role,
                    analysis="Insufficient specialized inputs for full analysis in this version",
                    bias="neutral",
                    confidence=0.2,
                    evidence=[],
                    assumptions=[],
                    limitations=["Required data feed or model not yet connected"],
                )
            )

        # Risk officer
        risk_notes: list[str] = []
        risk_veto = False
        if data_status in ("stale", "delayed", "invalid", "incomplete"):
            risk_notes.append(f"Data quality concern: {data_status}")
            risk_veto = True
        if order_book and order_book.get("spread_bps") is not None and order_book["spread_bps"] > 50:
            risk_notes.append(f"Wide spread: {order_book['spread_bps']:.1f} bps")
        if context.get("daily_realized_pnl_pct", 0) <= -3:
            risk_notes.append("Daily loss limit proximity")
            risk_veto = True

        reports.append(
            SpecialistReport(
                role="Risk Management Officer",
                analysis="Risk veto evaluation",
                bias="neutral",
                confidence=0.9,
                evidence=risk_notes or ["No hard risk breach detected from available inputs"],
                assumptions=[],
                limitations=[],
            )
        )

        # Aggregation (not majority vote)
        bull = sum(r.confidence for r in reports if r.bias == "bullish")
        bear = sum(r.confidence for r in reports if r.bias == "bearish")
        total = bull + bear + 1e-9
        net = (bull - bear) / total

        contradictory = []
        if bull > 0.3 and bear > 0.3:
            contradictory.append("Mixed technical vs liquidity signals")

        if risk_veto or data_status in ("stale", "invalid", "incomplete"):
            action = Action.NO_TRADE if risk_veto else Action.WAIT
            conf = 0.3
            summary = "Risk or data quality blocks actionable recommendation."
        elif net > 0.45:
            action = Action.BUY if net < 0.7 else Action.STRONG_BUY
            conf = min(0.85, abs(net))
            summary = f"Evidence leans bullish (net score {net:.2f})."
        elif net < -0.45:
            action = Action.SELL if net > -0.7 else Action.STRONG_SELL
            conf = min(0.85, abs(net))
            summary = f"Evidence leans bearish (net score {net:.2f})."
        else:
            action = Action.WAIT
            conf = 0.4
            summary = "No clear edge after evidence aggregation."

        return CouncilDecision(
            action=action,
            confidence=round(conf, 3),
            summary=summary,
            specialist_reports=reports,
            risk_veto=risk_veto,
            risk_notes=risk_notes,
            contradictory_signals=contradictory,
            data_quality=data_status,
        )

    def _technical(
        self, klines: Optional[list[dict[str, Any]]], price: float
    ) -> tuple[str, float, list[str]]:
        if not klines or len(klines) < 5:
            return "neutral", 0.25, ["Insufficient candles for trend"]
        closes = [k["close"] for k in klines if k.get("data_status") != "invalid"]
        if len(closes) < 5:
            return "neutral", 0.25, ["Valid closes insufficient"]
        sma = sum(closes[-5:]) / 5
        prev = closes[-5]
        chg = (closes[-1] - prev) / prev if prev else 0
        evidence = [f"5-period SMA={sma:.4f}", f"Price={price:.4f}", f"5-bar change={chg:.2%}"]
        if price > sma and chg > 0.01:
            return "bullish", 0.55, evidence
        if price < sma and chg < -0.01:
            return "bearish", 0.55, evidence
        return "neutral", 0.35, evidence

    def _liquidity(self, book: Optional[dict[str, Any]]) -> tuple[str, float, list[str]]:
        if not book:
            return "neutral", 0.2, ["No order book"]
        imb = book.get("imbalance") or 0
        spread_bps = book.get("spread_bps")
        evidence = [
            f"Imbalance={imb:.3f}",
            f"Spread_bps={spread_bps}",
            f"BidVol={book.get('bid_volume')}",
            f"AskVol={book.get('ask_volume')}",
        ]
        if imb > 0.25:
            return "bullish", 0.5, evidence
        if imb < -0.25:
            return "bearish", 0.5, evidence
        return "neutral", 0.35, evidence

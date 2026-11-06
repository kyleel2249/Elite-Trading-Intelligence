"""
AI Trading Council — elite named specialists + Risk Officer veto.
Evidence-weighted aggregation; never a blind vote count.
Marcus Okonkwo / Sofia Rahman / Priya Nair use adapters when inputs allow.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from app.intelligence.traders import ELITE_TRADERS, EliteTraderProfile
from app.intelligence.adapters import FundamentalAdapter, MacroAdapter, SentimentAdapter


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
    trader_name: str
    trader_id: str
    analysis: str
    bias: str
    confidence: float
    evidence: list[str] = field(default_factory=list)
    methods_applied: list[str] = field(default_factory=list)
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
    risk_officer: str
    contradictory_signals: list[str]
    data_quality: str
    methodology_notes: list[str]
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class TradingCouncil:
    """12 elite specialists. Helena Frost (Risk) has absolute veto."""

    def __init__(self) -> None:
        self.fa = FundamentalAdapter()
        self.macro = MacroAdapter()
        self.sentiment = SentimentAdapter()

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
        methodology_notes = [
            "Aggregation is evidence-weighted confidence, not headcount voting",
            "Risk Management Officer (Helena Frost) holds veto authority",
            "Venue and quote-currency identity are preserved; no silent cross-venue substitution",
            "FA/Macro/Sentiment desks use adapters when series allow; otherwise abstain honestly",
        ]

        if price is None or data_status in ("unavailable", "invalid") or not data_status:
            risk = ELITE_TRADERS["risk"]
            return CouncilDecision(
                action=Action.INSUFFICIENT_DATA,
                confidence=0.0,
                summary="Essential market data missing or invalid; council abstains.",
                specialist_reports=[],
                risk_veto=True,
                risk_notes=["Insufficient data — veto by Risk Management Officer"],
                risk_officer=f"{risk.name} ({risk.title})",
                contradictory_signals=[],
                data_quality=data_status or "unavailable",
                methodology_notes=methodology_notes,
            )

        ta = ELITE_TRADERS["ta"]
        tech_bias, tech_conf, tech_ev, tech_methods = self._technical(klines, price, ta)
        reports.append(
            SpecialistReport(
                role=ta.title,
                trader_name=ta.name,
                trader_id=ta.id,
                analysis=f"{ta.mandate} Applied to {symbol} @ {price}",
                bias=tech_bias,
                confidence=tech_conf,
                evidence=tech_ev,
                methods_applied=tech_methods,
                assumptions=["OHLCV continuity", "Timestamps normalized to UTC"],
                limitations=["Single primary timeframe unless multi-series supplied"],
            )
        )

        liq = ELITE_TRADERS["liquidity"]
        liq_bias, liq_conf, liq_ev, liq_methods = self._liquidity(order_book, liq)
        reports.append(
            SpecialistReport(
                role=liq.title,
                trader_name=liq.name,
                trader_id=liq.id,
                analysis=liq.mandate,
                bias=liq_bias,
                confidence=liq_conf,
                evidence=liq_ev,
                methods_applied=liq_methods,
                assumptions=["Book snapshot approximates near-term liquidity"],
                limitations=["No hidden liquidity; single snapshot"],
            )
        )

        st = ELITE_TRADERS["structure"]
        reports.append(
            SpecialistReport(
                role=st.title,
                trader_name=st.name,
                trader_id=st.id,
                analysis=st.mandate,
                bias="neutral",
                confidence=0.45,
                evidence=[
                    f"Provider={provider}",
                    f"Data status={data_status}",
                    "Quote identity preserved (no auto USD/USDT conversion)",
                ],
                methods_applied=st.methods[:3],
                assumptions=[],
                limitations=["Cross-venue microstructure comparison pending fuller feeds"],
            )
        )

        # Marcus Okonkwo — Fundamental adapter
        fa_p = ELITE_TRADERS["fa"]
        fa_sig = self.fa.analyse(symbol=symbol, price=price, klines=klines, context=context)
        reports.append(
            SpecialistReport(
                role=fa_p.title,
                trader_name=fa_p.name,
                trader_id=fa_p.id,
                analysis=fa_p.mandate,
                bias=fa_sig.bias,
                confidence=fa_sig.confidence,
                evidence=fa_sig.evidence,
                methods_applied=fa_sig.methods_applied,
                assumptions=[],
                limitations=fa_sig.limitations,
            )
        )

        # Sofia Rahman — Macro adapter
        mac_p = ELITE_TRADERS["macro"]
        mac_sig = self.macro.analyse(klines=klines, order_book=order_book, context=context)
        reports.append(
            SpecialistReport(
                role=mac_p.title,
                trader_name=mac_p.name,
                trader_id=mac_p.id,
                analysis=mac_p.mandate,
                bias=mac_sig.bias,
                confidence=mac_sig.confidence,
                evidence=mac_sig.evidence,
                methods_applied=mac_sig.methods_applied,
                assumptions=[],
                limitations=mac_sig.limitations,
            )
        )

        # Priya Nair — Sentiment adapter
        sen_p = ELITE_TRADERS["sentiment"]
        sen_sig = self.sentiment.analyse(klines=klines, context=context)
        reports.append(
            SpecialistReport(
                role=sen_p.title,
                trader_name=sen_p.name,
                trader_id=sen_p.id,
                analysis=sen_p.mandate,
                bias=sen_sig.bias,
                confidence=sen_sig.confidence,
                evidence=sen_sig.evidence,
                methods_applied=sen_sig.methods_applied,
                assumptions=[],
                limitations=sen_sig.limitations,
            )
        )

        for key in ("predictive", "quant", "cis", "execution", "auditor"):
            t = ELITE_TRADERS[key]
            reports.append(
                SpecialistReport(
                    role=t.title,
                    trader_name=t.name,
                    trader_id=t.id,
                    analysis=(
                        f"{t.mandate} Specialized path partially scaffolded; neutral until full module attaches."
                    ),
                    bias="neutral",
                    confidence=0.2,
                    evidence=[],
                    methods_applied=t.methods[:2],
                    assumptions=[],
                    limitations=t.evidence_standards
                    + ["Full module not fully connected in this build"],
                )
            )

        risk = ELITE_TRADERS["risk"]
        risk_notes: list[str] = []
        risk_veto = False
        if data_status in ("stale", "delayed", "invalid", "incomplete"):
            risk_notes.append(f"Data quality concern: {data_status}")
            if data_status in ("stale", "invalid", "incomplete"):
                risk_veto = True
        if order_book and order_book.get("spread_bps") is not None and order_book["spread_bps"] > 50:
            risk_notes.append(f"Wide spread: {order_book['spread_bps']:.1f} bps — execution risk elevated")
        if context.get("daily_realized_pnl_pct", 0) <= -3:
            risk_notes.append("Daily loss limit proximity — veto")
            risk_veto = True
        if context.get("current_drawdown_pct", 0) >= 10:
            risk_notes.append("Portfolio drawdown limit — veto")
            risk_veto = True

        reports.append(
            SpecialistReport(
                role=risk.title,
                trader_name=risk.name,
                trader_id=risk.id,
                analysis=risk.mandate,
                bias="neutral",
                confidence=0.95,
                evidence=risk_notes or ["No hard risk breach from available inputs"],
                methods_applied=risk.methods,
                assumptions=[],
                limitations=[],
            )
        )

        bull = sum(r.confidence for r in reports if r.bias == "bullish")
        bear = sum(r.confidence for r in reports if r.bias == "bearish")
        total = bull + bear + 1e-9
        net = (bull - bear) / total

        contradictory = []
        if bull > 0.3 and bear > 0.3:
            contradictory.append("Mixed evidence across technical, liquidity, and adapter desks")

        if risk_veto:
            action = Action.NO_TRADE
            conf = 0.25
            summary = f"Risk veto by {risk.name}. No actionable recommendation."
        elif data_status in ("stale", "delayed"):
            action = Action.WAIT
            conf = 0.3
            summary = "Data not fresh enough for aggressive action; wait."
        elif net > 0.45:
            action = Action.BUY if net < 0.7 else Action.STRONG_BUY
            conf = min(0.85, abs(net))
            summary = f"Evidence-weighted stance bullish (net {net:.2f})."
        elif net < -0.45:
            action = Action.SELL if net > -0.7 else Action.STRONG_SELL
            conf = min(0.85, abs(net))
            summary = f"Evidence-weighted stance bearish (net {net:.2f})."
        else:
            action = Action.WAIT
            conf = 0.4
            summary = "No clear edge after evidence aggregation across desks."

        return CouncilDecision(
            action=action,
            confidence=round(conf, 3),
            summary=summary,
            specialist_reports=reports,
            risk_veto=risk_veto,
            risk_notes=risk_notes,
            risk_officer=f"{risk.name} ({risk.title})",
            contradictory_signals=contradictory,
            data_quality=data_status,
            methodology_notes=methodology_notes,
        )

    def _technical(
        self,
        klines: Optional[list[dict[str, Any]]],
        price: float,
        profile: EliteTraderProfile,
    ) -> tuple[str, float, list[str], list[str]]:
        methods = ["Moving-average structure and slope", "Momentum (rate of change)"]
        if not klines or len(klines) < 5:
            return "neutral", 0.25, ["Insufficient candles for structure"], methods
        closes = [k["close"] for k in klines if k.get("data_status") != "invalid"]
        if len(closes) < 5:
            return "neutral", 0.25, ["Valid closes insufficient"], methods
        sma = sum(closes[-5:]) / 5
        prev = closes[-5]
        chg = (closes[-1] - prev) / prev if prev else 0
        evidence = [f"5-period SMA={sma:.6g}", f"Price={price:.6g}", f"5-bar change={chg:.2%}"]
        if price > sma and chg > 0.01:
            return "bullish", 0.55, evidence, methods
        if price < sma and chg < -0.01:
            return "bearish", 0.55, evidence, methods
        return "neutral", 0.35, evidence, methods

    def _liquidity(
        self,
        book: Optional[dict[str, Any]],
        profile: EliteTraderProfile,
    ) -> tuple[str, float, list[str], list[str]]:
        methods = ["Top-of-book and depth imbalance", "Spread in bps"]
        if not book:
            return "neutral", 0.2, ["No order book"], methods
        imb = book.get("imbalance") or 0
        spread_bps = book.get("spread_bps")
        evidence = [
            f"Imbalance={imb:.3f}",
            f"Spread_bps={spread_bps}",
            f"BidVol={book.get('bid_volume')}",
            f"AskVol={book.get('ask_volume')}",
        ]
        if imb > 0.25:
            return "bullish", 0.5, evidence, methods
        if imb < -0.25:
            return "bearish", 0.5, evidence, methods
        return "neutral", 0.35, evidence, methods

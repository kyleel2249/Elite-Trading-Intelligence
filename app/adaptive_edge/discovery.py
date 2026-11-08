"""Autonomous New Edge Discovery Engine."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional
import hashlib
import uuid


@dataclass
class ResearchHypothesis:
    hypothesis_id: str
    category: str  # technical | fundamental | institutional | sentiment | cross_asset
    title: str
    description: str
    measurable_claim: str
    data_requirements: list[str]
    markets: list[str]
    source_triggers: list[str]
    status: str  # HYPOTHESIS | RESEARCH | REJECTED | PROMOTED_TO_LAB
    priority: float
    created_at: str
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class EdgeDiscoveryEngine:
    """
    Generates independently testable hypotheses when regimes change,
    edges weaken, or new patterns appear. Does not assume combinations
    of public methods automatically create alpha.
    """

    CATALOG = [
        {
            "category": "technical",
            "title": "Volatility contraction then expansion breakout",
            "claim": "After N-bar realized vol falls below percentile P, next expansion direction predicts 5–20 bar returns",
            "data": ["ohlcv", "realized_vol"],
            "markets": ["crypto", "equities", "fx"],
        },
        {
            "category": "technical",
            "title": "Failed breakout mean reversion",
            "claim": "Breakouts that reverse within K bars exhibit negative continuation edge",
            "data": ["ohlcv", "range_high_low"],
            "markets": ["crypto", "equities"],
        },
        {
            "category": "technical",
            "title": "Order-book imbalance short-horizon edge",
            "claim": "Persistent bid/ask depth imbalance predicts next-bar direction after cost filter",
            "data": ["order_book", "trades"],
            "markets": ["crypto"],
        },
        {
            "category": "technical",
            "title": "Cross-market lead-lag",
            "claim": "Lagged returns of liquid leader predict follower after controlling for common factor",
            "data": ["multi_asset_ohlcv"],
            "markets": ["crypto", "equities", "fx"],
        },
        {
            "category": "fundamental",
            "title": "Earnings revision momentum",
            "claim": "Upward estimate revisions cluster with positive excess returns over 20–60 days",
            "data": ["earnings_revisions", "prices"],
            "markets": ["equities"],
        },
        {
            "category": "fundamental",
            "title": "Token unlock supply shock",
            "claim": "Large scheduled unlocks associate with negative abnormal returns in window [-3,+10]",
            "data": ["unlock_calendar", "onchain", "prices"],
            "markets": ["crypto"],
        },
        {
            "category": "institutional",
            "title": "13F / Form 4 delayed reaction",
            "claim": "Publicly disclosed significant buys show residual drift after publication date (not filing date)",
            "data": ["sec_filings", "publication_timestamp", "prices"],
            "markets": ["equities"],
        },
        {
            "category": "sentiment",
            "title": "Sentiment-price divergence",
            "claim": "Extreme retail sentiment against price trend mean-reverts over 3–10 days",
            "data": ["social_sentiment", "prices"],
            "markets": ["crypto", "equities"],
        },
        {
            "category": "cross_asset",
            "title": "Liquidity regime and risk assets",
            "claim": "Proxy liquidity expansion predicts higher risk-asset returns conditional on vol regime",
            "data": ["rates", "credit", "equity_index", "crypto"],
            "markets": ["multi"],
        },
        {
            "category": "technical",
            "title": "Adaptive dual-momentum with vol target",
            "claim": "Absolute + relative momentum with volatility targeting improves Sharpe vs fixed lookback",
            "data": ["ohlcv"],
            "markets": ["equities", "crypto", "futures"],
        },
    ]

    def discover(
        self,
        triggers: list[str],
        current_regimes: Optional[dict[str, str]] = None,
        weakened_strategies: Optional[list[str]] = None,
        existing_hypothesis_ids: Optional[set[str]] = None,
        max_new: int = 5,
    ) -> list[ResearchHypothesis]:
        """Select and instantiate hypotheses relevant to current triggers."""
        existing = existing_hypothesis_ids or set()
        out: list[ResearchHypothesis] = []
        ts = datetime.now(timezone.utc).isoformat()
        priority_boost = 0.0
        if any("regime" in t or "MAJOR" in t or "EMERGENCY" in t for t in triggers):
            priority_boost += 0.25
        if weakened_strategies:
            priority_boost += 0.2

        for item in self.CATALOG:
            raw = f"{item['title']}|{item['category']}|{','.join(sorted(triggers))}"
            hid = "hyp_" + hashlib.sha256(raw.encode()).hexdigest()[:12]
            if hid in existing:
                continue
            relevant = True
            if "vol" in str(triggers).lower() and "vol" not in item["title"].lower() and item["category"] != "technical":
                relevant = bool(weakened_strategies)
            if not relevant and not weakened_strategies and priority_boost < 0.2:
                continue

            notes = [f"triggered_by:{t}" for t in triggers[:5]]
            if current_regimes:
                notes.append(f"regimes:{current_regimes}")
            if weakened_strategies:
                notes.append(f"replace_candidates_for:{weakened_strategies}")

            h = ResearchHypothesis(
                hypothesis_id=hid,
                category=item["category"],
                title=item["title"],
                description=f"Test whether {item['claim']}. Public methodology combination must prove incremental value.",
                measurable_claim=item["claim"],
                data_requirements=item["data"],
                markets=item["markets"],
                source_triggers=list(triggers),
                status="HYPOTHESIS",
                priority=round(0.5 + priority_boost + (0.05 if item["category"] == "technical" else 0), 3),
                created_at=ts,
                notes=notes,
            )
            out.append(h)
            if len(out) >= max_new:
                break

        if weakened_strategies and len(out) < max_new:
            hid = "hyp_" + uuid.uuid4().hex[:12]
            out.append(
                ResearchHypothesis(
                    hypothesis_id=hid,
                    category="technical",
                    title=f"Regime-adaptive replacement for {weakened_strategies[0]}",
                    description="Search for a simple, explainable rule set with positive EV after costs in the current regime family.",
                    measurable_claim="Walk-forward net EV > 0 and profit factor > 1.15 in holdout folds",
                    data_requirements=["ohlcv", "regime_labels"],
                    markets=["crypto", "equities"],
                    source_triggers=triggers,
                    status="HYPOTHESIS",
                    priority=0.85,
                    created_at=ts,
                    notes=[f"driven_by_weak:{weakened_strategies}"],
                )
            )
        return out

"""Schema for historical trader knowledge profiles."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional


@dataclass
class SourceNote:
    claim: str
    classification: str  # verified | reported | estimate | speculation
    source: Optional[str] = None
    notes: Optional[str] = None


@dataclass
class TraderKnowledgeProfile:
    id: str
    full_name: str
    aliases: list[str] = field(default_factory=list)
    biography: str = ""
    trading_history: str = ""
    markets_traded: list[str] = field(default_factory=list)
    preferred_instruments: list[str] = field(default_factory=list)
    philosophy: str = ""
    documented_patterns: list[str] = field(default_factory=list)
    entry_criteria: list[str] = field(default_factory=list)
    exit_criteria: list[str] = field(default_factory=list)
    stop_loss_methodology: list[str] = field(default_factory=list)
    position_sizing: list[str] = field(default_factory=list)
    risk_reward: list[str] = field(default_factory=list)
    technical_indicators: list[str] = field(default_factory=list)
    fundamental_methodology: list[str] = field(default_factory=list)
    preferred_conditions: list[str] = field(default_factory=list)
    avoid_conditions: list[str] = field(default_factory=list)
    decision_psychology: list[str] = field(default_factory=list)
    historical_returns: list[SourceNote] = field(default_factory=list)
    historical_drawdowns: list[SourceNote] = field(default_factory=list)
    win_rates: list[SourceNote] = field(default_factory=list)
    net_worth: list[SourceNote] = field(default_factory=list)
    famous_successful_trades: list[str] = field(default_factory=list)
    famous_unsuccessful_trades: list[str] = field(default_factory=list)
    predictions_outcomes: list[str] = field(default_factory=list)
    strengths: list[str] = field(default_factory=list)
    weaknesses: list[str] = field(default_factory=list)
    eti_lessons: list[str] = field(default_factory=list)
    strategy_module_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    expandable_notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

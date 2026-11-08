"""Internal Strategy Competition Arena."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Optional


@dataclass
class LeaderboardEntry:
    strategy_id: str
    family: str
    asset_class: str
    timeframe: str
    regime: str
    expected_return: Optional[float]
    realized_return: Optional[float]
    max_drawdown_pct: Optional[float]
    sharpe: Optional[float]
    profit_factor: Optional[float]
    win_rate: Optional[float]
    capital_efficiency: Optional[float]
    score: float
    rank: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class StrategyCompetitionArena:
    """Rank strategies under comparable risk budgets and cost assumptions."""

    def rank(
        self,
        entries: list[dict[str, Any]],
        regime: str = "all",
        asset_class: str = "all",
    ) -> list[LeaderboardEntry]:
        scored: list[LeaderboardEntry] = []
        for e in entries:
            sharpe = e.get("sharpe") or 0.0
            pf = e.get("profit_factor") or 0.0
            mdd = e.get("max_drawdown_pct") or 50.0
            wr = e.get("win_rate") or 0.0
            ret = e.get("realized_return") if e.get("realized_return") is not None else e.get("expected_return") or 0.0
            # Robust score: risk-adjusted, penalize drawdown
            score = (sharpe * 0.35) + (min(pf, 3.0) * 0.25) + (wr * 0.15) + (max(ret, -50) / 50 * 0.15) - (mdd / 100 * 0.4)
            scored.append(
                LeaderboardEntry(
                    strategy_id=e.get("strategy_id", "unknown"),
                    family=e.get("family", "general"),
                    asset_class=e.get("asset_class", asset_class),
                    timeframe=e.get("timeframe", "multi"),
                    regime=e.get("regime", regime),
                    expected_return=e.get("expected_return"),
                    realized_return=e.get("realized_return"),
                    max_drawdown_pct=e.get("max_drawdown_pct"),
                    sharpe=e.get("sharpe"),
                    profit_factor=e.get("profit_factor"),
                    win_rate=e.get("win_rate"),
                    capital_efficiency=e.get("capital_efficiency"),
                    score=round(score, 4),
                )
            )
        scored.sort(key=lambda x: x.score, reverse=True)
        for i, row in enumerate(scored, 1):
            row.rank = i
        return scored

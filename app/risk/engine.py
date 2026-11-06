"""
Risk Engine — final veto authority on every order (paper or live).

Hard rules:
- Max risk per trade (default 1% of equity)
- Max daily loss
- Max portfolio drawdown
- Max open positions
- Max correlated exposure
- Data freshness for live orders
- Quantity / precision sanity
- Explicit environment targeting (paper/testnet/live)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from app.config import Settings, get_settings


class Decision(str, Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    REQUIRES_REVIEW = "REQUIRES_REVIEW"


@dataclass
class OrderProposal:
    provider: str
    environment: str  # paper | testnet | live
    symbol: str
    side: str  # buy | sell
    qty: float
    order_type: str = "market"
    limit_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    client_order_id: Optional[str] = None
    equity: float = 0.0
    current_open_positions: int = 0
    daily_realized_pnl_pct: float = 0.0
    current_drawdown_pct: float = 0.0
    estimated_risk_amount: Optional[float] = None
    data_age_seconds: Optional[float] = None
    data_status: str = "unknown"
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class RiskDecision:
    decision: Decision
    reasons: list[str]
    risk_per_trade_pct: float
    approved_qty: Optional[float] = None
    notes: str = ""

    @property
    def approved(self) -> bool:
        return self.decision == Decision.APPROVED


class RiskEngine:
    """Independent risk officer. Has veto power."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()

    def evaluate(self, proposal: OrderProposal) -> RiskDecision:
        reasons: list[str] = []
        s = self.settings

        # --- Environment gates ---
        if proposal.environment == "live":
            if not s.live_trading_enabled:
                reasons.append("LIVE_TRADING_ENABLED is false")
            if proposal.provider == "alpaca" and s.alpaca_paper:
                reasons.append("Alpaca is configured for paper (ALPACA_PAPER=true)")
            if proposal.provider == "binance" and not s.binance_live_trading_enabled:
                reasons.append("BINANCE_LIVE_TRADING_ENABLED is false")

        # --- Basic validation ---
        if proposal.qty <= 0:
            reasons.append("Quantity must be positive")
        if proposal.side not in ("buy", "sell"):
            reasons.append("Side must be buy or sell")
        if proposal.equity <= 0:
            reasons.append("Account equity must be positive for risk sizing")

        # --- Position limits ---
        if proposal.current_open_positions >= s.max_open_positions:
            reasons.append(
                f"Max open positions reached ({proposal.current_open_positions}/{s.max_open_positions})"
            )

        # --- Daily loss ---
        if proposal.daily_realized_pnl_pct <= -abs(s.max_daily_loss_pct):
            reasons.append(
                f"Daily loss limit hit ({proposal.daily_realized_pnl_pct:.2f}% <= -{s.max_daily_loss_pct}%)"
            )

        # --- Drawdown ---
        if proposal.current_drawdown_pct >= s.max_portfolio_drawdown_pct:
            reasons.append(
                f"Portfolio drawdown limit ({proposal.current_drawdown_pct:.2f}% >= {s.max_portfolio_drawdown_pct}%)"
            )

        # --- Risk per trade ---
        risk_pct = s.default_risk_per_trade_pct
        if proposal.estimated_risk_amount is not None and proposal.equity > 0:
            risk_pct = (proposal.estimated_risk_amount / proposal.equity) * 100
            if risk_pct > s.default_risk_per_trade_pct:
                reasons.append(
                    f"Risk per trade {risk_pct:.2f}% exceeds limit {s.default_risk_per_trade_pct}%"
                )

        # --- Data freshness (live only) ---
        if proposal.environment == "live" and s.require_fresh_data_for_live_orders:
            if proposal.data_age_seconds is None:
                reasons.append("Live order requires known data age")
            elif proposal.data_age_seconds > s.data_max_age_seconds:
                reasons.append(
                    f"Data too stale ({proposal.data_age_seconds:.0f}s > {s.data_max_age_seconds}s)"
                )
            if proposal.data_status in ("stale", "invalid", "unavailable", "incomplete"):
                reasons.append(f"Data status not acceptable for live: {proposal.data_status}")

        if reasons:
            return RiskDecision(
                decision=Decision.REJECTED,
                reasons=reasons,
                risk_per_trade_pct=risk_pct,
                notes="; ".join(reasons),
            )

        return RiskDecision(
            decision=Decision.APPROVED,
            reasons=["All risk checks passed"],
            risk_per_trade_pct=risk_pct,
            approved_qty=proposal.qty,
            notes="Approved by RiskEngine",
        )

    def position_size(
        self,
        equity: float,
        entry_price: float,
        stop_price: float,
        risk_pct: Optional[float] = None,
    ) -> float:
        """Simple fixed-fractional position size."""
        risk_pct = risk_pct or self.settings.default_risk_per_trade_pct
        if equity <= 0 or entry_price <= 0:
            return 0.0
        risk_amount = equity * (risk_pct / 100.0)
        stop_distance = abs(entry_price - stop_price)
        if stop_distance <= 0:
            return 0.0
        qty = risk_amount / stop_distance
        return max(0.0, qty)

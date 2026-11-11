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
- Market-aware limits (app.markets): venue/asset-class support, session state for live
  orders, and per-market tightening of the notional and risk caps (never loosening)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from app.config import Settings, get_settings
from app.markets.assessment import market_risk_review
from app.markets.types import MarketReview

logger = logging.getLogger("eti.risk")


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
    # Set ONLY by TradingService / the risk gateway after the Capital Protection System has verified,
    # from server-side positions, that this order strictly reduces an existing position. It lets exits
    # through the loss/drawdown/position limits that block new risk. Never read from a request.
    reduces_exposure: bool = False
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class RiskDecision:
    decision: Decision
    reasons: list[str]
    risk_per_trade_pct: float
    approved_qty: Optional[float] = None
    notes: str = ""
    warnings: list[str] = field(default_factory=list)

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

        # --- Market-aware review (venue support, session state, per-market cap tightening) ---
        # A failure here must never silently widen limits: fail closed.
        try:
            review = market_risk_review(proposal.symbol, proposal.provider, proposal.environment)
        except Exception:
            logger.exception("market review failed for %s; failing closed", proposal.symbol)
            review = MarketReview()
            reasons.append("Market review unavailable; order rejected (fail-closed)")
        reasons.extend(review.blocking_reasons)
        warnings: list[str] = list(review.warnings)

        # --- Kill switch (all environments) ---
        if getattr(s, "kill_switch", False):
            reasons.append("KILL_SWITCH is active — all order submission halted")

        # --- Environment gates ---
        if proposal.environment == "live":
            if not s.live_trading_enabled:
                reasons.append("LIVE_TRADING_ENABLED is false")
            if proposal.provider == "alpaca" and s.alpaca_paper:
                reasons.append("Alpaca is configured for paper (ALPACA_PAPER=true); set ALPACA_PAPER=false for live")
            if proposal.provider == "binance" and not s.binance_live_trading_enabled:
                reasons.append("BINANCE_LIVE_TRADING_ENABLED is false")
            # Live requires limit orders by default for controllable entry (verified exits may use market)
            if not proposal.reduces_exposure:
                if proposal.order_type == "market":
                    reasons.append("Live orders require limit order_type (market blocked on live path)")
                if proposal.limit_price is None or proposal.limit_price <= 0:
                    reasons.append("Live orders require a positive limit_price")
            # Explicit confirmation via meta
            if getattr(s, "require_live_confirmation", True):
                if not (proposal.meta or {}).get("live_confirmed"):
                    reasons.append("Live order requires live_confirmed=true in request meta")

        # --- Basic validation ---
        if proposal.qty <= 0:
            reasons.append("Quantity must be positive")
        if proposal.side not in ("buy", "sell"):
            reasons.append("Side must be buy or sell")
        if proposal.equity <= 0 and not proposal.reduces_exposure:
            reasons.append("Account equity must be positive for risk sizing")

        if proposal.reduces_exposure:
            # A verified exit only reduces risk: loss/drawdown/position/notional/freshness limits do not apply.
            if reasons:
                return RiskDecision(decision=Decision.REJECTED, reasons=reasons,
                                    risk_per_trade_pct=0.0, notes="; ".join(reasons))
            return RiskDecision(decision=Decision.APPROVED, reasons=["Exit reduces existing exposure"],
                                risk_per_trade_pct=0.0, approved_qty=proposal.qty,
                                notes="Approved by RiskEngine (exposure-reducing exit)")

        # --- Max position notional (6% default) ---
        max_notional_pct = getattr(s, "max_position_notional_pct", 6.0) * review.notional_cap_multiplier
        if proposal.equity > 0 and proposal.qty > 0:
            px = proposal.limit_price or (proposal.meta or {}).get("ref_price")
            if px and float(px) > 0:
                notional = float(proposal.qty) * float(px)
                notional_pct = (notional / proposal.equity) * 100.0
                if notional_pct > max_notional_pct + 1e-9:
                    reasons.append(
                        f"Position notional {notional_pct:.2f}% exceeds max {max_notional_pct}% of equity"
                    )

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
            risk_limit = s.default_risk_per_trade_pct * review.risk_multiplier
            if risk_pct > risk_limit + 1e-9:
                reasons.append(
                    f"Risk per trade {risk_pct:.2f}% exceeds limit {risk_limit:g}%"
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
                warnings=warnings,
            )

        return RiskDecision(
            decision=Decision.APPROVED,
            reasons=["All risk checks passed"],
            risk_per_trade_pct=risk_pct,
            approved_qty=proposal.qty,
            notes="Approved by RiskEngine",
            warnings=warnings,
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

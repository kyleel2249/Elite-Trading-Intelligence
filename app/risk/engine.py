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
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from urllib.parse import urlsplit

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
    # Server-derived market price (never client-supplied). Lets risk sizing charge the full notional when no stop exists.
    reference_price: Optional[float] = None
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

        # --- Validate provider/environment pairing and numeric sanity before any routing ---
        if proposal.provider not in ("alpaca", "binance", "oanda"):
            reasons.append("Unsupported provider")
        if proposal.environment not in ("paper", "testnet", "live"):
            reasons.append("Unsupported environment")
        if proposal.provider == "alpaca":
            expected = "paper-api.alpaca.markets" if proposal.environment == "paper" else "api.alpaca.markets"
            url = urlsplit(s.alpaca_base_url)
            if proposal.environment == "testnet":
                reasons.append("Alpaca does not support testnet; select paper or live")
            if (url.scheme != "https" or url.netloc != expected or url.path not in ("", "/")
                    or url.query or url.fragment):
                reasons.append("Alpaca endpoint does not match requested environment")
            if s.alpaca_paper != (proposal.environment == "paper"):
                reasons.append("ALPACA_PAPER does not match requested environment")
        for name in ("qty", "equity", "daily_realized_pnl_pct", "current_drawdown_pct", "current_open_positions"):
            if not math.isfinite(getattr(proposal, name)):
                reasons.append(f"{name} must be finite")
        if proposal.order_type not in ("market", "limit"):
            reasons.append("Unsupported order type")
        if proposal.order_type == "limit" and (proposal.limit_price is None or
                not math.isfinite(proposal.limit_price) or proposal.limit_price <= 0):
            reasons.append("Limit order requires a finite positive limit price")

        # --- Environment gates ---
        if proposal.environment == "live":
            if not s.live_trading_enabled:
                reasons.append("LIVE_TRADING_ENABLED is false")
            if proposal.provider == "alpaca" and s.alpaca_paper:
                reasons.append("Alpaca is configured for paper (ALPACA_PAPER=true); set ALPACA_PAPER=false for live")
            if proposal.provider == "binance" and not s.binance_live_trading_enabled:
                reasons.append("BINANCE_LIVE_TRADING_ENABLED is false")
            if proposal.provider == "oanda" and not getattr(s, "oanda_live_trading_enabled", False):
                reasons.append("OANDA_LIVE_TRADING_ENABLED is false")
            # Live requires limit orders by default for controllable entry
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
        if proposal.equity <= 0:
            reasons.append("Account equity must be positive for risk sizing")

        # --- Max position notional (6% default) ---
        # Market profiles may only tighten the approved limits (rule 7): clamp any multiplier above 1 to 1.
        notional_mult = min(1.0, review.notional_cap_multiplier)
        risk_mult = min(1.0, review.risk_multiplier)
        max_notional_pct = getattr(s, "max_position_notional_pct", 6.0) * notional_mult
        # Orders that open or add exposure outside the paper simulator must have verifiable risk and notional.
        needs_verification = proposal.side == "buy" and proposal.environment in ("testnet", "live")
        server_px = proposal.reference_price
        if server_px is not None and not (math.isfinite(server_px) and server_px > 0):
            server_px = None
        px = server_px or proposal.limit_price or (proposal.meta or {}).get("ref_price")
        try:
            px = float(px) if px else None
        except (TypeError, ValueError):
            px = None
        if px is not None and not (math.isfinite(px) and px > 0):
            px = None
        # USD-base FX (USDZAR, USDJPY ...): quantity is already denominated in USD, so notional = qty (price would give quote currency).
        try:
            from app.markets.registry import classify as _classify
            _i = _classify(proposal.symbol, provider_hint=proposal.provider)
            usd_base = _i.asset_class.value in ("forex", "metal") and _i.base == "USD"
        except Exception:
            usd_base = False
        if proposal.equity > 0 and proposal.qty > 0 and math.isfinite(proposal.qty) and math.isfinite(proposal.equity):
            if (px and px > 0) or usd_base:
                notional = float(proposal.qty) if usd_base else float(proposal.qty) * px
                notional_pct = (notional / proposal.equity) * 100.0
                if notional_pct > max_notional_pct + 1e-9:
                    reasons.append(
                        f"Position notional {notional_pct:.2f}% exceeds max {max_notional_pct}% of equity"
                    )
            else:
                # Fail closed in every environment: without a price the notional and risk cannot be measured.
                reasons.append("Position notional cannot be verified (no reference_price, limit_price or ref_price); order rejected (fail-closed)")

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
        risk_amount = proposal.estimated_risk_amount
        if risk_amount is not None and (not math.isfinite(risk_amount) or risk_amount <= 0):
            # A zero/negative/NaN estimate is not a measurement and must not understate the real exposure.
            reasons.append("Estimated risk must be finite and positive")
            risk_amount = None
        elif (risk_amount is not None and server_px and proposal.stop_loss is None and proposal.equity > 0
              and math.isfinite(proposal.qty) and abs(proposal.qty) * server_px > risk_amount):
            # Without an enforceable stop, a client estimate cannot be lower than the order's notional.
            risk_amount = abs(proposal.qty) * server_px
        if risk_amount is None and proposal.stop_loss and px and proposal.qty > 0 and proposal.side == "buy":
            # Derive the amount at risk from the stop so a stop-protected order is verified, not assumed.
            risk_amount = float(proposal.qty) * max(0.0, px - float(proposal.stop_loss))
        if risk_amount is not None and proposal.equity > 0:
            risk_pct = (risk_amount / proposal.equity) * 100
            risk_limit = s.default_risk_per_trade_pct * risk_mult
            if risk_pct > risk_limit + 1e-9:
                reasons.append(
                    f"Risk per trade {risk_pct:.2f}% exceeds limit {risk_limit:g}%"
                )
        elif server_px and proposal.equity > 0 and math.isfinite(proposal.qty):
            # No stop and no estimate: charge the full notional to the risk budget (conservative).
            risk_pct = abs(proposal.qty) * server_px / proposal.equity * 100.0
            # The full notional is already the most conservative risk measure, so the base limit applies.
            if risk_pct > s.default_risk_per_trade_pct + 1e-9:
                reasons.append(f"Conservative notional risk {risk_pct:.2f}% exceeds limit {s.default_risk_per_trade_pct:g}%")
        elif proposal.side == "buy" and proposal.equity > 0:
            if needs_verification:
                reasons.append("Risk per trade cannot be verified (no stop_loss or estimated_risk_amount); order rejected (fail-closed)")
            else:
                warnings.append("Risk per trade not verified: no stop_loss or estimated_risk_amount supplied")

        # --- Data freshness (live only) ---
        if proposal.environment == "live" and s.require_fresh_data_for_live_orders:
            if proposal.data_age_seconds is None or not math.isfinite(proposal.data_age_seconds) or proposal.data_age_seconds < 0:
                reasons.append("Live order requires known data age")
            elif proposal.data_age_seconds > s.data_max_age_seconds:
                reasons.append(
                    f"Data too stale ({proposal.data_age_seconds:.0f}s > {s.data_max_age_seconds}s)"
                )
            if proposal.data_status != "fresh":
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
        risk_pct = self.settings.default_risk_per_trade_pct if risk_pct is None else risk_pct
        if not all(math.isfinite(x) for x in (equity, entry_price, stop_price, risk_pct)) or risk_pct <= 0:
            return 0.0
        if equity <= 0 or entry_price <= 0:
            return 0.0
        risk_amount = equity * (risk_pct / 100.0)
        stop_distance = abs(entry_price - stop_price)
        if stop_distance <= 0:
            return 0.0
        qty = risk_amount / stop_distance
        return max(0.0, qty)

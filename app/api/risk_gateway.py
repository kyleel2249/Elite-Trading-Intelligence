"""Server-side preflight bridge for the Cloudflare execution gateway.

The gateway calls this API before a live order. Inputs that affect risk are
derived from ETI's market and portfolio services; client-supplied equity,
drawdown, positions and freshness are never accepted.
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.market.service import MarketService
from app.intelligence.council import TradingCouncil
from app.risk.engine import OrderProposal, RiskEngine
from app.security.auth import require_api_key
from app.services.activity_store import ActivityStore
from app.trading.risk_context import build_risk_context
from app.trading.service import TradingService

router = APIRouter(prefix="/api/risk-gateway", tags=["risk-gateway"])


class PreflightRequest(BaseModel):
    provider: Literal["alpaca", "binance"]
    environment: Literal["paper", "testnet", "live"]
    symbol: str = Field(min_length=2, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    side: Literal["buy", "sell"]
    quantity: float = Field(gt=0, allow_inf_nan=False)
    order_type: Literal["market", "limit"] = "market"
    limit_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def live_requires_limit(self):
        if self.environment == "live" and (self.order_type != "limit" or self.limit_price is None):
            raise ValueError("Live preflight requires a limit order and limit_price")
        return self


@router.post("/preflight")
async def execution_preflight(
    req: PreflightRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
    _auth=Depends(require_api_key),
):
    """Return an auditable risk decision; this endpoint never submits an order."""
    snapshot = None
    try:
        snapshot = await MarketService(settings).get_snapshot(req.provider, req.symbol)
    except Exception:
        snapshot = {"provider": req.provider, "symbol": req.symbol, "price": None, "data_status": "unavailable"}

    risk_context = build_risk_context(
        db, settings, environment=req.environment, snapshot=snapshot,
    )
    order_book = None
    klines = None
    if req.provider == "binance":
        try:
            order_book = await MarketService(settings).get_order_book(req.symbol, depth=20)
        except Exception:
            order_book = None
        try:
            klines = await MarketService(settings).get_history("binance", req.symbol, interval="1h", limit=100)
        except Exception:
            klines = None

    # Disclosures are surfaced as evidence, never interpreted as an automatic
    # buy/sell instruction. The trading gateway remains the only order path.
    disclosures = ActivityStore(db).list_activities(ticker=req.symbol.upper(), limit=20)
    high_impact = [
        row for row in disclosures
        if row.get("significance") in ("CRITICAL", "HIGH")
        and str(row.get("verification_status") or "").upper() == "VERIFIED"
    ]
    research_context = {
        "investor_disclosures": high_impact[:10],
        "risk_context": risk_context.to_dict(),
        "daily_realized_pnl_pct": risk_context.daily_realized_pnl_pct,
        "current_drawdown_pct": risk_context.current_drawdown_pct,
        "market_provider": req.provider,
    }
    council = TradingCouncil().analyse(
        symbol=req.symbol.upper(),
        provider=req.provider,
        price=snapshot.get("price"),
        bid=snapshot.get("bid"),
        ask=snapshot.get("ask"),
        data_status=str(snapshot.get("data_status") or "unavailable"),
        order_book=order_book,
        klines=klines,
        context=research_context,
    )

    price = req.limit_price if req.limit_price is not None else snapshot.get("price")
    # A live order without a trustworthy reference quote is rejected even when
    # the limit is supplied: the quote is needed for freshness and sanity checks.
    # reference_price feeds the hard 6% single-position allocation cap in RiskEngine;
    # orders that only close an existing opposite position are exempt from that cap.
    proposal = OrderProposal(
        provider=req.provider,
        environment=req.environment,
        symbol=req.symbol.upper(),
        side=req.side,
        qty=req.quantity,
        order_type=req.order_type,
        limit_price=req.limit_price,
        equity=risk_context.equity,
        current_open_positions=risk_context.current_open_positions,
        daily_realized_pnl_pct=risk_context.daily_realized_pnl_pct,
        current_drawdown_pct=risk_context.current_drawdown_pct,
        data_age_seconds=risk_context.data_age_seconds,
        data_status=risk_context.data_status,
        reference_price=price,
        reduces_exposure=TradingService(settings, db=db)._reduces_exposure(
            req.provider, req.environment, req.symbol, req.side, req.quantity),
        meta={"reference_price": price},
    )
    decision = RiskEngine(settings).evaluate(proposal)

    reasons = list(decision.reasons)
    quote_price = snapshot.get("price")
    quote_age = risk_context.data_age_seconds
    quote_status = str(risk_context.data_status or "unavailable").lower()
    quote_is_valid = (
        isinstance(quote_price, (int, float))
        and quote_price > 0
        and quote_status == "fresh"
        and quote_age is not None
        and 0 <= quote_age <= settings.data_max_age_seconds
    )
    if not quote_is_valid:
        reasons.append("Order preflight requires a valid, timestamped, fresh market quote")
    if req.environment == "live" and council.risk_veto:
        reasons.extend(council.risk_notes or ["Trading Council risk veto"])
    approved = decision.approved and quote_is_valid and not (
        req.environment == "live" and council.risk_veto
    )
    return {
        "approved": approved,
        "decision": "APPROVED" if approved else "REJECTED",
        "reasons": reasons,
        "risk_officer": "Helena Frost",
        "position_allocation_pct": decision.position_allocation_pct,
        "risk_inputs": {"source": "server", **risk_context.to_dict()},
        "market": {
            "provider": snapshot.get("provider"),
            "symbol": snapshot.get("symbol"),
            "price": snapshot.get("price"),
            "data_status": snapshot.get("data_status"),
            "ts_utc": snapshot.get("ts_utc"),
        },
        "disclosure_context": {
            "matched_count": len(disclosures),
            "high_impact_verified_count": len(high_impact),
            "activities": high_impact[:10],
            "interpretation": "Research context only; disclosures are not automatic trade signals.",
        },
        "market_research": {
            "council_action": council.action.value,
            "confidence": council.confidence,
            "summary": council.summary,
            "risk_veto": council.risk_veto,
            "risk_notes": council.risk_notes,
            "data_quality": council.data_quality,
            "specialist_reports": [asdict(report) for report in council.specialist_reports],
            "methodology_notes": council.methodology_notes,
        },
        "order": {
            "provider": req.provider, "environment": req.environment,
            "symbol": req.symbol.upper(), "side": req.side,
            "quantity": req.quantity, "order_type": req.order_type,
            "limit_price": req.limit_price,
        },
        "submits_order": False,
    }

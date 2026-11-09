"""Multi-market intelligence API (read-only; never submits orders)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from app import __version__
from app.markets import (
    PROFILES, SESSIONS, assess, classify, list_instruments, overview, profile_for, session_status,
)
from app.markets.live import route_snapshot
from app.markets.types import AssetClass

logger = logging.getLogger("eti.markets")
router = APIRouter(tags=["markets"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parents[1] / "templates"))

# Free-form symbols are matched against the classifier, but never echoed unvalidated.
_SYMBOL = r"^[A-Za-z0-9./:_\-^ ]{1,40}$"
_PROVIDER = r"^[A-Za-z0-9_\-]{1,32}$"


def _classified(symbol: str, provider: Optional[str] = None):
    inst = classify(symbol, provider_hint=provider)
    if inst.asset_class == AssetClass.UNKNOWN:
        raise HTTPException(status_code=422, detail="Symbol could not be classified as a supported market")
    return inst


@router.get("/markets")
async def markets_page(request: Request):
    return templates.TemplateResponse(request, "markets.html", {"version": __version__})


@router.get("/api/markets/overview")
async def markets_overview():
    """Asset classes, provider capability matrix (what is executable vs analysis-only) and every market clock."""
    counts: dict[str, int] = {}
    for inst in list_instruments():
        counts[inst.asset_class.value] = counts.get(inst.asset_class.value, 0) + 1
    now = datetime.now(timezone.utc)
    return {
        "as_of_utc": now.isoformat(),
        "catalog_counts": counts,
        **overview(),
        "sessions": {sid: session_status(sid, now).to_dict() for sid in SESSIONS},
        "profile_keys": sorted(PROFILES),
    }


@router.get("/api/markets/instruments")
async def markets_instruments(
    asset_class: Optional[Literal["forex", "metal", "crypto", "stock", "index", "commodity", "future", "option"]] = None,
    tier: Optional[str] = Query(None, pattern=r"^[A-Za-z_]{1,24}$"),
    q: Optional[str] = Query(None, max_length=40),
):
    items = [i.to_dict() for i in list_instruments(asset_class, q, tier)]
    return {"count": len(items), "instruments": items,
            "note": "Curated catalog; any well-formed symbol can still be classified via /api/markets/classify."}


@router.get("/api/markets/classify")
async def markets_classify(symbol: str = Query(..., pattern=_SYMBOL), provider: Optional[str] = Query(None, pattern=_PROVIDER)):
    return classify(symbol, provider_hint=provider).to_dict()


@router.get("/api/markets/sessions")
async def markets_sessions(
    symbol: Optional[str] = Query(None, pattern=_SYMBOL),
    session_id: Optional[str] = Query(None, pattern=r"^[a-z0-9_]{1,32}$"),
):
    now = datetime.now(timezone.utc)
    if symbol:
        inst = _classified(symbol)
        return session_status(inst.session_id, now).to_dict()
    if session_id:
        if session_id not in SESSIONS:
            raise HTTPException(status_code=404, detail="Unknown session_id")
        return session_status(session_id, now).to_dict()
    return {"as_of_utc": now.isoformat(), "sessions": {sid: session_status(sid, now).to_dict() for sid in SESSIONS}}


@router.get("/api/markets/profile")
async def markets_profile(symbol: str = Query(..., pattern=_SYMBOL), provider: Optional[str] = Query(None, pattern=_PROVIDER),
                          listing_age_days: Optional[float] = Query(None, ge=0, le=100000, allow_inf_nan=False),
                          avg_daily_volume_usd: Optional[float] = Query(None, gt=0, le=1e13, allow_inf_nan=False)):
    inst = _classified(symbol, provider)
    return {"instrument": inst.to_dict(),
            "profile": profile_for(inst, listing_age_days=listing_age_days, avg_daily_volume_usd=avg_daily_volume_usd).to_dict()}


@router.get("/api/markets/assess")
async def markets_assess(
    symbol: str = Query(..., pattern=_SYMBOL),
    price: Optional[float] = Query(None, gt=0, le=1e12, allow_inf_nan=False),
    account_equity: float = Query(10000.0, gt=0, le=1e12, allow_inf_nan=False,
                                  description="Planning input only; never used to approve orders."),
    risk_pct: float = Query(1.0, gt=0, le=10, allow_inf_nan=False),
    side: Literal["buy", "sell"] = "buy",
    stop_price: Optional[float] = Query(None, gt=0, le=1e12, allow_inf_nan=False),
    atr: Optional[float] = Query(None, gt=0, le=1e12, allow_inf_nan=False),
    measured_spread_bps: Optional[float] = Query(None, ge=0, le=10000, allow_inf_nan=False),
    avg_daily_volume_usd: Optional[float] = Query(None, gt=0, le=1e13, allow_inf_nan=False),
    listing_age_days: Optional[float] = Query(None, ge=0, le=100000, allow_inf_nan=False),
    quote_to_usd: Optional[float] = Query(None, gt=0, le=1e9, allow_inf_nan=False),
    max_notional_pct: float = Query(6.0, gt=0, le=100, allow_inf_nan=False),
    provider: Optional[str] = Query(None, pattern=_PROVIDER),
    environment: Literal["paper", "testnet", "live"] = "paper",
):
    return assess(
        symbol, price=price, account_equity=account_equity, risk_pct=risk_pct, side=side, stop_price=stop_price, atr=atr,
        measured_spread_bps=measured_spread_bps, avg_daily_volume_usd=avg_daily_volume_usd, listing_age_days=listing_age_days,
        quote_to_usd=quote_to_usd, max_notional_pct=max_notional_pct, provider=provider, environment=environment,
    )


@router.get("/api/markets/snapshot")
async def markets_snapshot(symbol: str = Query(..., pattern=_SYMBOL), provider: Optional[str] = Query(None, pattern=_PROVIDER)):
    """Live quote from the provider that can serve this market (ETF proxies are labelled). No data is invented."""
    _classified(symbol, provider)
    try:
        return await route_snapshot(symbol, provider)
    except Exception as exc:  # never echo upstream exception text (URLs, keys) to clients
        logger.warning("markets snapshot failed: %s", type(exc).__name__, exc_info=True)
        raise HTTPException(status_code=502, detail="Market snapshot failed upstream")

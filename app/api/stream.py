"""Live market stream APIs — read-only, no trading path."""
from __future__ import annotations

import asyncio
import json
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.security.auth import require_api_key
from app.streaming.manager import stream_hub, BYBIT_ALLOWLIST, ALPACA_ALLOWLIST

router = APIRouter(tags=["stream"])


class SubscribeRequest(BaseModel):
    symbols: list[str] = Field(..., min_length=1, max_length=10)
    provider: str = "bybit"
    category: Literal["spot", "linear", "inverse"] = "spot"


@router.get("/api/market/live")
async def market_live(
    symbol: str = Query("BTCUSDT"),
    provider: Optional[str] = Query(None, description="bybit | alpaca | omit for any"),
    category: Optional[Literal["spot", "linear", "inverse"]] = Query(None),
):
    """Normalized last tick from WebSocket cache (not an order); category selects Bybit spot/linear/inverse."""
    return stream_hub.get_live(symbol, provider=provider, category=category)


@router.get("/api/stream/status")
async def stream_status():
    return stream_hub.status()


@router.get("/api/stream/sse")
async def stream_sse(
    request: Request,
    symbol: Optional[str] = Query(None, description="Optional symbol filter, e.g. BTCUSDT"),
    category: Optional[Literal["spot", "linear", "inverse"]] = Query(None),
):
    """
    Server-Sent Events of normalized quotes. A category filter selects Bybit spot, linear or inverse updates.
    Research/display only — does not touch RiskEngine or TradingService.
    """
    filt = symbol.upper().strip() if symbol else None
    queue = stream_hub.register_sse()

    async def event_gen():
        try:
            # Hello + snapshot
            snap = {}
            if filt:
                live = stream_hub.get_live(filt, provider="bybit" if category else None, category=category)
                if live.get("status") == "ok":
                    snap = live
            elif category:
                for key, q in list(stream_hub.bybit_quotes_by_market.items()):
                    if key.startswith(category + ":"):
                        snap[key] = q
                        if len(snap) >= 12:
                            break
            else:
                for sym, q in list(stream_hub.quotes.items())[:12]:
                    snap[sym] = q
            yield f"event: hello\ndata: {json.dumps({'type': 'hello', 'filter': filt, 'snapshot': snap})}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    quote = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield f"event: ping\ndata: {json.dumps({'type': 'ping'})}\n\n"
                    continue
                if filt and quote.get("symbol") != filt:
                    continue
                if category and quote.get("category") != category:
                    continue
                yield f"event: quote\ndata: {json.dumps(quote)}\n\n"
        finally:
            stream_hub.unregister_sse(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/api/stream/subscribe")
async def stream_subscribe(body: SubscribeRequest, _auth=Depends(require_api_key)):
    """
    Dynamically subscribe allowlisted symbols (market data only).
    Requires API key when configured — still never places orders.
    """
    provider = body.provider.lower().strip()
    if provider not in ("bybit", "alpaca"):
        raise HTTPException(status_code=400, detail="provider must be bybit or alpaca")
    result = await stream_hub.subscribe(body.symbols, provider=provider, category=body.category)
    return result


@router.get("/api/stream/allowlist")
async def stream_allowlist():
    return {
        "bybit": sorted(BYBIT_ALLOWLIST),
        "bybit_categories": ["spot", "linear", "inverse"],
        "catalogue_driven": True,
        "catalogue_endpoint": "/api/market/symbols?provider=bybit",
        "alpaca": sorted(ALPACA_ALLOWLIST),
        "note": "Bybit subscriptions are checked against the live instrument catalogue and remain market-data only; the lists above are startup defaults."
    }

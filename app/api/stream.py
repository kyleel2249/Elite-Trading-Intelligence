"""Live market stream APIs — read-only, no trading path."""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.security.auth import require_api_key
from app.streaming.manager import stream_hub, BINANCE_ALLOWLIST, ALPACA_ALLOWLIST

router = APIRouter(tags=["stream"])


class SubscribeRequest(BaseModel):
    symbols: list[str] = Field(..., min_length=1, max_length=10)
    provider: str = "binance"


@router.get("/api/market/live")
async def market_live(
    symbol: str = Query("BTCUSDT"),
    provider: Optional[str] = Query(None, description="binance | alpaca | omit for any"),
):
    """Normalized last tick from WebSocket cache (not an order)."""
    return stream_hub.get_live(symbol, provider=provider)


@router.get("/api/stream/status")
async def stream_status():
    return stream_hub.status()


@router.get("/api/stream/sse")
async def stream_sse(
    request: Request,
    symbol: Optional[str] = Query(None, description="Optional symbol filter, e.g. BTCUSDT"),
):
    """
    Server-Sent Events of normalized quotes.
    Research/display only — does not touch RiskEngine or TradingService.
    """
    filt = symbol.upper().strip() if symbol else None
    queue = stream_hub.register_sse()

    async def event_gen():
        try:
            # Hello + snapshot
            snap = {}
            if filt:
                live = stream_hub.get_live(filt)
                if live.get("status") == "ok":
                    snap = live
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
    if provider not in ("binance", "alpaca"):
        raise HTTPException(status_code=400, detail="provider must be binance or alpaca")
    result = await stream_hub.subscribe(body.symbols, provider=provider)
    return result


@router.get("/api/stream/allowlist")
async def stream_allowlist():
    return {
        "binance": sorted(BINANCE_ALLOWLIST),
        "alpaca": sorted(ALPACA_ALLOWLIST),
        "note": "Allowlist limits market-data subscriptions only",
    }

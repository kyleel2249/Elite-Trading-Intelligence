"""Elite Trader Knowledge Engine API."""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.knowledge.registry import list_traders, get_trader, search_traders, attribution_for_decision
from app.knowledge.strategies import list_strategy_modules, get_strategy_module

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


@router.get("/traders")
async def knowledge_traders(
    q: Optional[str] = Query(None, description="Search query"),
    tag: Optional[str] = None,
    market: Optional[str] = None,
):
    if q or tag or market:
        return {"count": None, "traders": search_traders(q or "", tag=tag, market=market)}
    traders = list_traders()
    return {"count": len(traders), "traders": traders}


@router.get("/traders/{trader_id}")
async def knowledge_trader_detail(trader_id: str):
    t = get_trader(trader_id)
    if not t:
        raise HTTPException(status_code=404, detail="Trader not found")
    return t


@router.get("/strategies")
async def knowledge_strategies():
    mods = list_strategy_modules()
    return {"count": len(mods), "strategies": mods}


@router.get("/strategies/{module_id}")
async def knowledge_strategy_detail(module_id: str):
    m = get_strategy_module(module_id)
    if not m:
        raise HTTPException(status_code=404, detail="Strategy module not found")
    return m


@router.get("/attribution")
async def knowledge_attribution(text: str = Query(..., min_length=3)):
    return {"attribution": attribution_for_decision(text, []), "desk_note": "Keyword attribution only"}

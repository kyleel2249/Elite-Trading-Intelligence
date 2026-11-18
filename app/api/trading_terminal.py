"""Unified read-only public market terminal for Bybit and Bitget."""
from __future__ import annotations
import logging
from pathlib import Path
from typing import Literal
import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from starlette.requests import Request
from app import __version__
from app.config import get_settings
from app.integrations.bybit import BybitClient
from app.market.service import MarketService

logger = logging.getLogger("eti.trading_terminal")
router = APIRouter(tags=["trading-terminal"])
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parents[1] / "templates"))
Exchange = Literal["bybit", "bitget"]
Category = Literal["spot", "linear", "inverse", "usdt-futures"]
INTERVALS = {"1m":("1","1min"),"3m":("3","3min"),"5m":("5","5min"),"15m":("15","15min"),"30m":("30","30min"),"1h":("60","1H"),"2h":("120","2H"),"4h":("240","4H"),"6h":("360","6H"),"12h":("720","12H"),"1d":("D","1D"),"1w":("W","1W")}
PRODUCT = "USDT-FUTURES"

def validate_category(exchange: str, category: str) -> str:
    allowed = ("spot","linear","inverse") if exchange == "bybit" else ("spot","usdt-futures")
    if category not in allowed:
        raise HTTPException(422, "Unsupported market category for selected exchange")
    return category

async def bitget(path: str, params: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get("https://api.bitget.com"+path, params=params, headers={"accept":"application/json"})
            response.raise_for_status()
            body = response.json()
        if not isinstance(body,dict) or body.get("code")!="00000":
            raise RuntimeError("Unsuccessful Bitget response")
        return body
    except Exception as exc:
        logger.warning("Bitget market request failed: %s",type(exc).__name__)
        raise HTTPException(502,"Bitget public market data is temporarily unavailable") from None

@router.get("/terminal",response_class=HTMLResponse)
async def terminal_page(request: Request):
    return templates.TemplateResponse(request,"trading_terminal.html",{"version":__version__})

@router.get("/api/terminal/market")
async def terminal_market(exchange: Exchange="bybit",category: Category="linear",symbol: str=Query("BTCUSDT",min_length=3,max_length=32,pattern=r"^[A-Za-z0-9_-]+$")):
    category=validate_category(exchange,category); symbol=symbol.upper()
    try:
        if exchange=="bybit":
            q=await BybitClient(get_settings(),category=category).get_quote(symbol)
            out={"exchange":exchange,"category":category,"symbol":symbol,"last":q.price,"bid":q.bid,"ask":q.ask,"volume24h":q.volume,"quoteCurrency":q.quote_currency,"dataStatus":q.data_status,"timestamp":q.ts_utc.isoformat()}
            if category in ("linear","inverse"):
                try: out["funding"]=(await BybitClient(get_settings(),category=category).get_funding_rate(symbol,category=category)).get("funding_rate")
                except Exception: out["funding"]=None
            return out
        params={"productType":PRODUCT,"symbol":symbol} if category=="usdt-futures" else {"symbol":symbol}
        path="/api/v2/mix/market/ticker" if category=="usdt-futures" else "/api/v2/spot/market/tickers"
        rows=(await bitget(path,params)).get("data") or []
        if not rows: raise HTTPException(404,"No ticker returned for this Bitget market")
        r=rows[0]
        return {"exchange":exchange,"category":category,"symbol":symbol,"last":float(r.get("lastPr") or r.get("close") or 0),"bid":float(r.get("bidPr") or 0),"ask":float(r.get("askPr") or 0),"volume24h":float(r.get("baseVolume") or r.get("baseVol") or 0),"high24h":float(r.get("high24h") or 0),"low24h":float(r.get("low24h") or 0),"change24h":float(r.get("change24h") or 0),"funding":float(r["fundingRate"]) if r.get("fundingRate") not in (None,"") else None,"dataStatus":"live","timestamp":r.get("ts")}
    except HTTPException: raise
    except Exception as exc:
        logger.warning("%s ticker failed: %s",exchange,type(exc).__name__)
        raise HTTPException(502,exchange.title()+" market ticker unavailable") from None

@router.get("/api/terminal/candles")
async def terminal_candles(exchange: Exchange="bybit",category: Category="linear",symbol: str=Query("BTCUSDT",min_length=3,max_length=32,pattern=r"^[A-Za-z0-9_-]+$"),interval: str=Query("1h",pattern=r"^(1m|3m|5m|15m|30m|1h|2h|4h|6h|12h|1d|1w)$"),limit: int=Query(300,ge=30,le=1000)):
    category=validate_category(exchange,category); symbol=symbol.upper()
    if exchange=="bybit":
        try:
            rows=await BybitClient(get_settings(),category=category).get_klines(symbol,interval=interval,limit=limit,category=category)
            candles=[{"time":int(x["open_time"])//1000,"open":x["open"],"high":x["high"],"low":x["low"],"close":x["close"],"volume":x["volume"]} for x in rows]
            return {"exchange":exchange,"symbol":symbol,"interval":interval,"candles":candles}
        except Exception as exc:
            logger.warning("Bybit candle history failed: %s",type(exc).__name__)
            raise HTTPException(502,"Bybit candle history unavailable") from None
    granularity=INTERVALS[interval][1]
    params={"productType":PRODUCT,"symbol":symbol,"granularity":granularity,"limit":str(limit)} if category=="usdt-futures" else {"symbol":symbol,"granularity":granularity,"limit":str(limit)}
    path="/api/v2/mix/market/candles" if category=="usdt-futures" else "/api/v2/spot/market/candles"
    rows=(await bitget(path,params)).get("data") or []
    candles=[]
    for r in rows:
        try: candles.append({"time":int(r[0])//1000,"open":float(r[1]),"high":float(r[2]),"low":float(r[3]),"close":float(r[4]),"volume":float(r[5])})
        except (IndexError,TypeError,ValueError): continue
    candles.sort(key=lambda x:x["time"])
    return {"exchange":exchange,"symbol":symbol,"interval":interval,"candles":candles}

@router.get("/api/terminal/orderbook")
async def terminal_orderbook(exchange: Exchange="bybit",category: Category="linear",symbol: str=Query("BTCUSDT",min_length=3,max_length=32,pattern=r"^[A-Za-z0-9_-]+$"),depth: int=Query(20,ge=5,le=100)):
    category=validate_category(exchange,category); symbol=symbol.upper()
    if exchange=="bybit":
        try:
            raw=await BybitClient(get_settings(),category=category).get_order_book_raw(symbol,limit=depth,category=category)
            bids,asks=raw.get("bids") or [],raw.get("asks") or []
        except Exception as exc:
            logger.warning("Bybit order book failed: %s",type(exc).__name__)
            raise HTTPException(502,"Bybit order book unavailable") from None
    else:
        if category=="usdt-futures":
            body=await bitget("/api/v2/mix/market/merge-depth",{"productType":PRODUCT,"symbol":symbol,"limit":str(depth),"precision":"scale0"})
        else:
            body=await bitget("/api/v2/spot/market/orderbook",{"symbol":symbol,"type":"step0","limit":str(depth)})
        data=body.get("data") or {}; bids,asks=data.get("bids") or [],data.get("asks") or []
    def clean(rows):
        out=[]
        for r in rows[:depth]:
            try: out.append([float(r[0]),float(r[1])])
            except (IndexError,TypeError,ValueError): continue
        return out
    bids,asks=clean(bids),clean(asks)
    bt=sum(p*q for p,q in bids); at=sum(p*q for p,q in asks)
    bb=max((x[0] for x in bids),default=None); ba=min((x[0] for x in asks),default=None)
    mid=(bb+ba)/2 if bb and ba else None
    return {"exchange":exchange,"symbol":symbol,"bids":bids,"asks":asks,"bestBid":bb,"bestAsk":ba,"spread":ba-bb if bb is not None and ba is not None else None,"spreadBps":((ba-bb)/mid*10000) if mid else None,"bidNotional":bt,"askNotional":at,"imbalance":(bt-at)/(bt+at) if bt+at else None}

@router.get("/api/terminal/derivatives")
async def terminal_derivatives(exchange: Exchange="bybit",category: Category="linear",symbol: str=Query("BTCUSDT",min_length=3,max_length=32,pattern=r"^[A-Za-z0-9_-]+$")):
    category=validate_category(exchange,category); symbol=symbol.upper()
    if category=="spot": return {"exchange":exchange,"symbol":symbol,"available":False,"reason":"Derivatives context is unavailable for Spot."}
    if exchange=="bybit":
        try: return await MarketService(get_settings()).get_derivatives_context(symbol,category=category)
        except Exception as exc:
            logger.warning("Bybit derivatives context failed: %s",type(exc).__name__)
            return {"exchange":exchange,"symbol":symbol,"available":False,"reason":"Funding/open-interest data unavailable."}
    try:
        funding=(await bitget("/api/v2/mix/market/current-fund-rate",{"symbol":symbol,"productType":PRODUCT})).get("data") or []
        oi=(await bitget("/api/v2/mix/market/open-interest",{"symbol":symbol,"productType":PRODUCT})).get("data") or {}
        row=funding[0] if isinstance(funding,list) and funding else funding if isinstance(funding,dict) else {}
        return {"exchange":exchange,"symbol":symbol,"available":bool(row or oi),"funding":row.get("fundingRate"),"openInterest":oi.get("openInterestList",oi.get("openInterest")),"readOnly":True}
    except HTTPException:
        return {"exchange":exchange,"symbol":symbol,"available":False,"reason":"Funding/open-interest data unavailable."}

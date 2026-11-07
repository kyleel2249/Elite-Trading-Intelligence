"""Data Intelligence & API Centre + Investor monitor endpoints."""
from fastapi import APIRouter, Depends

from app.config import get_settings, Settings
from app.integrations.quiver.client import QuiverClient
from app.integrations.liquid.client import LiquidClient
from app.jobs.investor_monitor import investor_monitor
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/intelligence-data", tags=["intelligence-data"])


@router.get("/status")
async def data_status(settings: Settings = Depends(get_settings)):
    quiver = QuiverClient(settings)
    liquid = LiquidClient(settings)
    return {
        "quiver": await quiver.health(),
        "liquid": await liquid.health(),
        "investor_monitor": investor_monitor.status(),
        "secrets_exposed": False,
        "note": "Quiver is research-only; never triggers orders alone. Liquid trading not assumed.",
        "risk_officer": "Helena Frost",
    }


@router.post("/test/quiver")
async def test_quiver(settings: Settings = Depends(get_settings)):
    return await QuiverClient(settings).health()


@router.post("/test/liquid")
async def test_liquid(settings: Settings = Depends(get_settings)):
    return await LiquidClient(settings).health()


@router.get("/quiver/congress")
async def quiver_congress(settings: Settings = Depends(get_settings)):
    return await QuiverClient(settings).congress_trading_live()


@router.get("/quiver/congress/{ticker}")
async def quiver_congress_ticker(ticker: str, settings: Settings = Depends(get_settings)):
    return await QuiverClient(settings).congress_trading_ticker(ticker)


@router.get("/investor-monitor/status")
async def inv_status():
    return investor_monitor.status()


@router.post("/investor-monitor/run")
async def inv_run(_auth=Depends(require_api_key)):
    return await investor_monitor.run_once()


@router.get("/investor-monitor/alerts")
async def inv_alerts():
    return {"alerts": investor_monitor.alerts[-50:], "count": len(investor_monitor.alerts)}

"""Data Intelligence & API Centre routes (Quiver + Liquid status + investor scan)."""
from fastapi import APIRouter, Depends

from app.config import Settings, get_settings
from app.integrations.quiver.client import QuiverClient
from app.integrations.liquid.client import LiquidClient
from app.intelligence.investor_activity import InvestorActivityEngine
from app.jobs.investor_monitor import investor_monitor_job
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/data-intelligence", tags=["data-intelligence"])


@router.get("/status")
async def data_intelligence_status(settings: Settings = Depends(get_settings)):
    q = QuiverClient(settings)
    liq = LiquidClient(settings)
    return {
        "quiver": await q.health(),
        "liquid": await liq.health(),
        "investor_monitor": investor_monitor_job.status(),
        "rules": [
            "Quiver is research-only",
            "Liquid trading endpoints not assumed without verified base URL",
            "No withdrawals",
            "Helena Frost gates all orders",
        ],
    }


@router.get("/quiver/datasets")
async def quiver_datasets(settings: Settings = Depends(get_settings)):
    return await QuiverClient(settings).dataset_availability_probe()


@router.get("/quiver/congress")
async def quiver_congress(settings: Settings = Depends(get_settings)):
    return await InvestorActivityEngine(settings).scan_congress()


@router.get("/quiver/contracts")
async def quiver_contracts(settings: Settings = Depends(get_settings)):
    return await InvestorActivityEngine(settings).scan_contracts()


@router.get("/quiver/lobbying")
async def quiver_lobbying(settings: Settings = Depends(get_settings)):
    return await InvestorActivityEngine(settings).scan_lobbying()


@router.get("/ticker/{ticker}")
async def ticker_alt_data(ticker: str, settings: Settings = Depends(get_settings)):
    return await InvestorActivityEngine(settings).ticker_context(ticker)


@router.get("/watchlist")
async def investor_watchlist(settings: Settings = Depends(get_settings)):
    return InvestorActivityEngine(settings).watchlist_summary()


@router.get("/monitor/status")
async def monitor_status():
    return investor_monitor_job.status()


@router.post("/monitor/scan")
async def monitor_scan(_auth=Depends(require_api_key)):
    return await investor_monitor_job.run_once()


@router.post("/monitor/start")
async def monitor_start(_auth=Depends(require_api_key)):
    await investor_monitor_job.start()
    return investor_monitor_job.status()


@router.post("/monitor/pause")
async def monitor_pause(_auth=Depends(require_api_key)):
    await investor_monitor_job.stop()
    return investor_monitor_job.status()

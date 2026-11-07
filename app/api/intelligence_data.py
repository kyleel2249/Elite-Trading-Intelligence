"""Data Intelligence & Investor Intelligence Command Centre API."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.integrations.quiver.client import QuiverClient
from app.integrations.liquid.client import LiquidClient
from app.integrations.edgar.client import EdgarClient, WATCH_CIKS
from app.intelligence.investor_activity import InvestorActivityEngine
from app.intelligence.significance import consensus_report
from app.intelligence.disclosure_learning import summary_by_category, activities_pending_study
from app.jobs.investor_monitor import investor_monitor_job
from app.services.activity_store import ActivityStore
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/data-intelligence", tags=["data-intelligence"])


@router.get("/status")
async def data_intelligence_status(settings: Settings = Depends(get_settings)):
    q = QuiverClient(settings)
    liq = LiquidClient(settings)
    edgar = EdgarClient()
    return {
        "quiver": await q.health(),
        "liquid": await liq.health(),
        "sec_edgar": await edgar.health(),
        "investor_monitor": investor_monitor_job.status(),
        "rules": [
            "Quiver is research-only",
            "13F / EDGAR = historical snapshot, not live portfolio",
            "Liquid trading endpoints not assumed",
            "No withdrawals",
            "Helena Frost gates all orders",
            "Claire Bennett audits alerts",
        ],
        "desk": {
            "strategist": "Adrian Cole",
            "auditor": "Claire Bennett",
            "risk_officer": "Helena Frost",
        },
    }


@router.get("/search")
async def search_intelligence(
    q: str = Query(..., min_length=1, description="Ticker or investor/institution name"),
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """Search stored activities and alerts by ticker or name."""
    return ActivityStore(db).search(q=q, limit=limit)


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


@router.get("/activities")
async def list_activities(
    limit: int = 50,
    ticker: Optional[str] = None,
    category: Optional[str] = None,
    significance: Optional[str] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
):
    return {
        "activities": ActivityStore(db).list_activities(
            limit=limit,
            ticker=ticker,
            category=category,
            significance=significance,
            q=q,
        )
    }


@router.get("/alerts")
async def list_alerts(
    limit: int = 50,
    unacked_only: bool = False,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
):
    return {
        "alerts": ActivityStore(db).list_alerts(
            limit=limit, unacked_only=unacked_only, q=q
        )
    }


@router.post("/alerts/{alert_id}/ack")
async def ack_alert(alert_id: str, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    ok = ActivityStore(db).acknowledge_alert(alert_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"acknowledged": True, "alert_id": alert_id}


@router.get("/consensus")
async def consensus(limit: int = 100, db: Session = Depends(get_db)):
    acts = ActivityStore(db).list_activities(limit=limit)
    return consensus_report(acts)


@router.get("/edgar/13f/{cik}")
async def edgar_13f(cik: str):
    client = EdgarClient()
    sub = await client.company_submissions(cik)
    acts = client.activities_from_13f_index(sub)
    return {"submissions": sub, "activities": acts, "watch_ciks": WATCH_CIKS}


@router.get("/learning/summary")
async def learning_summary(db: Session = Depends(get_db)):
    return summary_by_category(db)


@router.get("/learning/pending")
async def learning_pending(db: Session = Depends(get_db)):
    return {"pending": activities_pending_study(db)}

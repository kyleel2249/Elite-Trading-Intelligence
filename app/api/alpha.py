"""ETI Global Alpha Intelligence API. Reads are open (like other ETI GET routes); every
mutating or order-capable route requires X-API-Key."""
from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.alpha import ALPHA_VERSION
from app.alpha.predictions import STRATEGY_TAG, alpha_predictions
from app.alpha.access import Access, require_alpha_role
from app.alpha.context import gather_context, load_fundamentals
from app.alpha.macro import load_macro
from app.alpha.performance import evaluate_discovery
from app.alpha.coverage import build_registry
from app.alpha.db_models import (AlphaAuditLog, AlphaCandidate, AlphaResearchRun, AlphaStrategyRun, AlphaStrategyState,
                                 AlphaTradePlan, TraderQualification, WalletLabel)
from app.alpha.derivatives import load_derivatives, recent_listings
from app.alpha.discovery import DiscoveryEngine, candidate_dict, leaderboard
from app.alpha.execution import AlphaExecutor, audit
from app.alpha.fusion import validate
from app.alpha.investor_intel import (FOUNDATIONAL_35, assess_following, audit_profiles, disclosure_freshness, effective_profile,
                                      overlap_report, profile_history, propose_profile_update, qualify_investor)
from app.alpha.providers import AlpacaMarketData, BinanceFutures, BinanceUniverse, DexScreener
from app.alpha.research_job import alpha_research_job, make_bars_fn
from app.alpha.sec_sync import latest_holdings, sync_13f
from app.alpha.strategy_lab import compatibility, detect_regime, run_competition, combination_test
from app.alpha.strategy_library import LIBRARY
from app.alpha.whales import add_wallet_label, analyze_transfers, attribute
from app.config import Settings, get_settings
from app.database import get_db
from app.integrations.edgar.client import EdgarClient
from app.integrations.explorer.client import ExplorerClient
from app.knowledge.registry import get_trader, list_traders
from app.prediction_ledger.evaluation import compute_metrics
from app.prediction_ledger.service import scored_rows
from app.services.activity_store import ActivityStore

logger = logging.getLogger("eti.alpha")
router = APIRouter(prefix="/api/alpha", tags=["global-alpha"])


def _providers(db: Session, s: Settings):
    binance = BinanceUniverse(db=db)
    alpaca = AlpacaMarketData(s.alpaca_api_key, s.alpaca_secret_key, db=db)
    return binance, alpaca


def _upstream(exc: Exception, what: str) -> HTTPException:
    logger.warning("%s failed: %s", what, type(exc).__name__, exc_info=True)
    return HTTPException(status_code=502, detail=f"{what} failed upstream")


@router.get("/overview")
async def overview(db: Session = Depends(get_db), s: Settings = Depends(get_settings)):
    counts: dict[str, int] = {}
    for st, in db.query(AlphaCandidate.status).all():
        counts[st] = counts.get(st, 0) + 1
    cov = build_registry(db, s)
    return {"version": ALPHA_VERSION, "candidates_by_status": counts, "candidates_total": sum(counts.values()),
            "predictions": compute_metrics([r for r in scored_rows(db) if r.get("strategy") == STRATEGY_TAG]), "open_plans": db.query(AlphaTradePlan).filter_by(status="OPEN").count(),
            "research_job": alpha_research_job.status(), "providers_ok": sum(1 for p in cov["providers"] if p["status"] == "OK"),
            "providers_total": len(cov["providers"]), "live_trading_enabled": s.live_trading_enabled,
            "alpha_live_execution_authorized": s.alpha_live_execution_authorized,
            "foundational_profiles": len([i for i in FOUNDATIONAL_35 if get_trader(i)]),
            "strategy_modules": len(LIBRARY), "executable_modules": sum(1 for x in LIBRARY.values() if x.executable)}


@router.get("/coverage")
async def coverage(db: Session = Depends(get_db), s: Settings = Depends(get_settings)):
    return build_registry(db, s)


# ------------------------------------------------------------------ discovery
@router.get("/leaderboard")
async def get_leaderboard(asset_class: Optional[str] = None, status: Optional[str] = None, limit: int = Query(50, ge=1, le=200),
                          db: Session = Depends(get_db)):
    return {"candidates": leaderboard(db, asset_class, status, limit)}


@router.get("/candidates/detail")
async def candidate_detail(candidate_id: str, db: Session = Depends(get_db)):
    row = db.query(AlphaCandidate).filter_by(candidate_id=candidate_id).one_or_none()
    if not row:
        raise HTTPException(404, "candidate not found")
    d = candidate_dict(row)
    d["evidence"] = row.evidence
    d["predictions"] = alpha_predictions(db, 10, asset=row.symbol)
    d["plans"] = [{"plan_id": p.plan_id, "status": p.status, "environment": p.environment} for p in db.query(AlphaTradePlan).filter_by(candidate_id=candidate_id)]
    return d


@router.get("/candidates/rejected")
async def rejected(limit: int = Query(100, ge=1, le=300), db: Session = Depends(get_db)):
    rows = db.query(AlphaCandidate).filter(AlphaCandidate.status.in_(("REJECTED", "INVALIDATED"))).order_by(AlphaCandidate.last_seen.desc()).limit(limit).all()
    return {"candidates": [candidate_dict(r) for r in rows]}


@router.get("/new-listings")
async def new_listings(days: int = Query(30, ge=1, le=180), db: Session = Depends(get_db)):
    """Binance spot listings first seen by ETI after its baseline sweep (the first sweep seeds, it never flags)."""
    return {"listings": recent_listings(db, "binance_public", days),
            "note": "New listings lack history; ETI will not score one until it has 60 daily bars."}


@router.get("/derivatives/{symbol}")
async def derivatives(symbol: str = Path(pattern=r"^[A-Za-z0-9]{5,20}$"), db: Session = Depends(get_db),
                      who: Access = Depends(require_alpha_role("analyst"))):
    return await load_derivatives(BinanceFutures(db=db), symbol.upper())


class ScanRequest(BaseModel):
    kind: Literal["crypto", "equities", "dex", "all"] = "all"
    symbols: list[str] = Field(default_factory=list, max_length=100)


@router.post("/scan")
async def scan(req: ScanRequest, db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    binance, alpaca = _providers(db, s)
    eng = DiscoveryEngine(db, binance=binance, alpaca=alpaca, dex=DexScreener(db=db))
    out: dict[str, Any] = {}
    try:
        if req.kind in ("crypto", "all"):
            out["crypto"] = await eng.scan_crypto(s.alpha_crypto_scan_limit)
        if req.kind in ("equities", "all"):
            uni = req.symbols or [x.strip() for x in s.alpha_equity_universe.split(",") if x.strip()]
            out["equities"] = await eng.scan_equities(uni)
        if req.kind in ("dex", "all"):
            out["dex"] = await eng.scan_dex()
    except Exception as exc:  # noqa: BLE001
        raise _upstream(exc, "Discovery scan") from None
    return out


class ValidateRequest(BaseModel):
    candidate_id: str = Field(min_length=3, max_length=160)


@router.post("/validate")
async def validate_candidate(req: ValidateRequest, db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    cand = db.query(AlphaCandidate).filter_by(candidate_id=req.candidate_id).one_or_none()
    if not cand:
        raise HTTPException(404, "candidate not found")
    binance, alpaca = _providers(db, s)
    try:
        bars = await make_bars_fn(binance, alpaca)(cand)
    except Exception as exc:  # noqa: BLE001
        raise _upstream(exc, "Bar fetch") from None
    from app.trading.risk_context import build_risk_context
    ctx = build_risk_context(db, s, environment="paper", snapshot=None)
    extra = await gather_context(db, s, cand, bars)
    return validate(db, cand, bars, settings=s, equity=ctx.equity, open_positions=ctx.current_open_positions, **extra)


class ExecuteRequest(BaseModel):
    candidate_id: str = Field(min_length=3, max_length=160)
    environment: Literal["paper", "testnet", "live"] = "paper"
    confirm_live: Optional[str] = Field(default=None, max_length=64)


@router.post("/execute")
async def execute(req: ExecuteRequest, db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("trader"))):
    if req.environment == "live" and who.role != "admin":
        raise HTTPException(403, "live-environment attempts require the admin role")
    audit(db, f"api:{who.role}", "execute_requested", {"candidate_id": req.candidate_id, "environment": req.environment, "key_id": who.key_id})
    binance, alpaca = _providers(db, s)
    res = await AlphaExecutor(db, s).execute(req.candidate_id, req.environment, make_bars_fn(binance, alpaca), req.confirm_live)
    if res["status"] == "rejected" and any("live execution not authorized" in r for r in res["reasons"]):
        raise HTTPException(403, res["reasons"][0])
    return res


@router.post("/monitor")
async def monitor(db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("trader"))):
    audit(db, f"api:{who.role}", "monitor_requested", {"key_id": who.key_id})
    return await AlphaExecutor(db, s).monitor()


@router.get("/plans")
async def plans(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    rows = db.query(AlphaTradePlan).order_by(AlphaTradePlan.created_at.desc()).limit(limit).all()
    return {"plans": [{"plan_id": p.plan_id, "candidate_id": p.candidate_id, "symbol": p.symbol, "environment": p.environment, "status": p.status,
                       "entry": p.entry, "stop": p.stop_current or p.stop, "tp1": p.tp1, "tp2": p.tp2, "tp3": p.tp3, "qty": p.qty,
                       "remaining_qty": p.remaining_qty, "tp_hits": p.tp_hits, "pnl": p.pnl if p.pnl is not None else p.realized_pnl,
                       "close_reason": p.close_reason, "attribution": p.attribution, "created_at": p.created_at.isoformat()} for p in rows]}


# ------------------------------------------------------------------ predictions (ETI's single immutable ledger)
@router.get("/performance/discovery")
async def discovery_performance(horizon_days: int = Query(14, ge=1, le=90), asset_class: Optional[str] = Query(None, pattern="^(crypto|equity|etf|token)$"),
                                db: Session = Depends(get_db)):
    """Precision, false-positive/miss rates, recall and lead time of early flags, from point-in-time snapshots."""
    return evaluate_discovery(db, horizon_days, asset_class)


@router.get("/predictions")
async def predictions(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    """Alpha-originated predictions. Outcomes, calibration and reports live in /api/predictions/*."""
    return {"predictions": alpha_predictions(db, limit), "ledger": "/api/predictions", "metrics": "/api/predictions/metrics"}


# ------------------------------------------------------------------ strategies
@router.get("/strategies")
async def strategies(db: Session = Depends(get_db)):
    states: dict[str, list[dict[str, Any]]] = {}
    for st in db.query(AlphaStrategyState).all():
        states.setdefault(st.strategy_id, []).append({"asset_class": st.asset_class, "status": st.status, "version": st.version,
                                                      "passes": st.consecutive_passes, "fails": st.consecutive_fails, "live_trades": st.live_trades, "live_pnl": st.live_pnl})
    return {"strategies": [{**m.public(), "states": states.get(k, [])} for k, m in LIBRARY.items()],
            "honesty": "Modules are inspired by public principles, not the investors' private systems."}


@router.get("/strategies/runs")
async def strategy_runs(strategy_id: Optional[str] = None, limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    q = db.query(AlphaStrategyRun).order_by(AlphaStrategyRun.created_at.desc())
    if strategy_id:
        q = q.filter_by(strategy_id=strategy_id)
    return {"runs": [{"strategy_id": r.strategy_id, "asset_class": r.asset_class, "symbol": r.symbol, "verdict": r.verdict, "reasons": r.reasons,
                      "in_sample": r.in_sample, "out_of_sample": r.out_of_sample, "created_at": r.created_at.isoformat()} for r in q.limit(limit)]}


@router.get("/strategies/compatibility")
async def strategy_compat(symbol: str = Query("BTCUSDT", pattern=r"^[A-Za-z0-9.]{1,20}$"), asset_class: Literal["crypto", "equity", "etf"] = "crypto", timeframe: str = "1d",
                          db: Session = Depends(get_db), s: Settings = Depends(get_settings)):
    binance, alpaca = _providers(db, s)
    try:
        bars = await (binance.klines(symbol, "1d", 300) if asset_class == "crypto" else alpaca.daily_bars(symbol, 300))
    except Exception as exc:  # noqa: BLE001
        raise _upstream(exc, "Bar fetch") from None
    regime = detect_regime(bars)
    return {"symbol": symbol, "regime": regime, "matrix": [{"strategy_id": k, **compatibility(k, asset_class, timeframe, regime)} for k in LIBRARY]}


@router.post("/strategies/competition")
async def competition(symbols: list[str] = Query(pattern=r"^[A-Za-z0-9]{3,20}$", default=["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT"]),
                      db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    binance, _ = _providers(db, s)
    ds = {}
    for sym in symbols[:15]:
        try:
            bars = await binance.klines(sym.upper(), "1d", 1000)
            if len(bars) >= 400:
                ds[("crypto", sym.upper())] = bars
        except Exception:  # noqa: BLE001
            logger.info("history fetch failed for %s; skipped in competition", sym, exc_info=True)
            continue
    if not ds:
        raise HTTPException(502, "no usable datasets fetched")
    return run_competition(db, ds)


class ComboRequest(BaseModel):
    a: str
    b: str
    symbol: str = "BTCUSDT"


@router.post("/strategies/combination")
async def combination(req: ComboRequest, db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    binance, _ = _providers(db, s)
    try:
        bars = await binance.klines(req.symbol.upper(), "1d", 1000)
    except Exception as exc:  # noqa: BLE001
        raise _upstream(exc, "Bar fetch") from None
    return combination_test(db, req.a, req.b, bars, "crypto", req.symbol.upper())


# ------------------------------------------------------------------ investors
@router.get("/investors/profiles")
async def investor_profiles(db: Session = Depends(get_db)):
    audit = audit_profiles(db)
    comp = {r["trader_id"]: r["completeness_pct"] for r in audit["results"]}
    return {"profiles": [{"id": t["id"], "name": t["full_name"], "tags": t["tags"], "foundational": t["id"] in FOUNDATIONAL_35,
                          "completeness_pct": comp.get(t["id"]), "strategy_modules": t["strategy_module_ids"]} for t in list_traders()]}


@router.get("/investors/profiles/{trader_id}")
async def investor_profile(trader_id: str, db: Session = Depends(get_db)):
    p = effective_profile(db, trader_id)
    if not p or "id" not in p:
        raise HTTPException(404, "trader not found")
    a = audit_profiles(db, [p["id"]])
    p["audit"] = a["results"][0] if a["results"] else None
    p["history"] = profile_history(db, p["id"])
    p["inspired_modules_detail"] = [LIBRARY[m].public() for m in p.get("strategy_module_ids", []) if m in LIBRARY]
    return p


@router.get("/investors/audit")
async def investor_audit(db: Session = Depends(get_db)):
    return audit_profiles(db)


class QualifyRequest(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    category: str = Field(default="unspecified", max_length=48)
    years_documented: float = Field(ge=0, le=100)
    sources: list[dict[str, Any]] = Field(default_factory=list, max_length=30)
    performance_evidence: Literal["audited", "primary_reported", "secondary_reported", "none"] = "none"
    return_basis: Literal["personal_account", "fund_level", "mixed", "unknown"] = "unknown"
    risk_evidence: bool = False
    methodology_documented: bool = False
    basis_of_nomination: str = Field(default="documented_track_record", max_length=48)


@router.post("/investors/qualify")
async def qualify(req: QualifyRequest, db: Session = Depends(get_db), who: Access = Depends(require_alpha_role("analyst"))):
    audit(db, f"api:{who.role}", "qualification_requested", {"name": req.name[:80], "key_id": who.key_id})
    return qualify_investor(db, req.model_dump())


@router.get("/investors/qualifications")
async def qualifications(db: Session = Depends(get_db)):
    rows = db.query(TraderQualification).order_by(TraderQualification.decided_at.desc()).limit(100).all()
    return {"qualifications": [{"name": r.name, "category": r.category, "status": r.status, "reasons": r.reasons, "at": r.decided_at.isoformat()} for r in rows]}


class ProfileUpdate(BaseModel):
    trader_id: str
    field: str
    new_value: Any
    reason: str = Field(min_length=5, max_length=1000)
    sources: list[dict[str, Any]] = Field(min_length=1, max_length=10)


@router.post("/investors/profile-update")
async def profile_update(req: ProfileUpdate, db: Session = Depends(get_db), who: Access = Depends(require_alpha_role("analyst"))):
    audit(db, f"api:{who.role}", "profile_update_requested", {"trader_id": req.trader_id, "field": req.field, "key_id": who.key_id})
    try:
        return propose_profile_update(db, req.trader_id, req.field, req.new_value, req.reason, req.sources)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


@router.get("/investors/activity")
async def investor_activity(ticker: Optional[str] = None, limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    rows = ActivityStore(db).list_activities(ticker=ticker, limit=limit)
    for r in rows:
        r["freshness"] = disclosure_freshness(r)
    return {"activities": rows}


class AssessRequest(BaseModel):
    activity_id: str
    candidate_id: Optional[str] = None
    investor_qualified: bool = False
    investor_modules: list[str] = Field(default_factory=list)
    reference_price: Optional[float] = Field(default=None, gt=0)


@router.post("/investors/assess")
async def assess(req: AssessRequest, db: Session = Depends(get_db)):
    acts = [a for a in ActivityStore(db).list_activities(limit=200) if a.get("activity_id") == req.activity_id]
    if not acts:
        raise HTTPException(404, "activity not found")
    cand = db.query(AlphaCandidate).filter_by(candidate_id=req.candidate_id).one_or_none() if req.candidate_id else None
    cd = candidate_dict(cand) if cand else None
    lab = ((cand.evidence or {}).get("validation") or {}).get("champion_strategies_long", []) if cand else []
    return assess_following(acts[0], current_price=cand.last_price if cand else None, reference_price=req.reference_price, candidate=cd,
                            investor_qualified=req.investor_qualified, investor_modules=req.investor_modules, lab_longs=lab)


class Sync13F(BaseModel):
    cik: str = Field(pattern=r"^\d{1,10}$")


@router.post("/investors/13f/sync")
async def sync_13f_route(req: Sync13F, db: Session = Depends(get_db), s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    try:
        sub = await EdgarClient(s.sec_user_agent).company_submissions(req.cik)
        if sub.get("status") != "ok":
            raise HTTPException(502, "SEC submissions unavailable")
        return await sync_13f(db, req.cik, sub["recent_13f_filings"], sub.get("name") or "Unknown filer", s.sec_user_agent)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _upstream(exc, "13F sync") from None


@router.get("/investors/13f/overlap")
async def overlap(ciks: list[str] = Query(default=[]), db: Session = Depends(get_db)):
    data = {c: latest_holdings(db, c) for c in ciks if c.isdigit()}
    return overlap_report({k: v for k, v in data.items() if v})


# ------------------------------------------------------------------ on-chain
class WalletLabelReq(BaseModel):
    chain: str = Field(min_length=2, max_length=32)
    address: str = Field(min_length=10, max_length=96)
    label: str = Field(min_length=2, max_length=160)
    entity_type: Literal["exchange", "fund", "treasury", "protocol", "individual", "unknown"]
    source: str = Field(min_length=5, max_length=300)
    confidence: float = Field(gt=0, le=1)
    verified: bool = False


@router.post("/whales/labels")
async def wallet_label(req: WalletLabelReq, db: Session = Depends(get_db), who: Access = Depends(require_alpha_role("analyst"))):
    audit(db, f"api:{who.role}", "wallet_label_requested", {"chain": req.chain, "entity_type": req.entity_type, "key_id": who.key_id})
    try:
        r = add_wallet_label(db, req.chain, req.address, req.label, req.entity_type, req.source, req.confidence, req.verified)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return attribute(db, r.chain, r.address)


@router.get("/whales/labels")
async def wallet_labels(db: Session = Depends(get_db)):
    return {"labels": [attribute(db, r.chain, r.address) | {"chain": r.chain} for r in db.query(WalletLabel).limit(500)]}


@router.get("/whales/analysis")
async def whale_analysis(chain: str, contract: str = Query(min_length=10, max_length=96), price_usd: float = Query(gt=0),
                         threshold_usd: float = Query(100_000, gt=0), db: Session = Depends(get_db), s: Settings = Depends(get_settings),
                         who: Access = Depends(require_alpha_role("analyst"))):  # spends the operator's explorer quota, so it is not anonymous
    client = ExplorerClient(s.alpha_explorer_base_url, s.alpha_explorer_api_key)
    if not client.configured:
        return {"status": "not_configured", "detail": "ALPHA_EXPLORER_BASE_URL and ALPHA_EXPLORER_API_KEY are required"}
    try:
        tx = await client.token_transfers(contract)
    except Exception as exc:  # noqa: BLE001
        raise _upstream(exc, "Explorer") from None
    addrs = {str(t.get(k, "")).lower() for t in tx for k in ("from", "to")}
    labels = {a: attribute(db, chain, a) for a in addrs if a}
    return analyze_transfers(tx, price_usd=price_usd, threshold_usd=threshold_usd, labels={a: v for a, v in labels.items() if v["label"]})


# ------------------------------------------------------------------ macro & fundamentals (outbound quota: key required)
@router.get("/macro")
async def macro(s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    return await load_macro(s)


@router.get("/fundamentals/{ticker}")
async def fundamentals(ticker: str, price: Optional[float] = Query(None, gt=0), db: Session = Depends(get_db),
                       s: Settings = Depends(get_settings), who: Access = Depends(require_alpha_role("analyst"))):
    if not ticker.replace(".", "").replace("-", "").isalnum() or len(ticker) > 10:
        raise HTTPException(422, "invalid ticker")
    out = await load_fundamentals(db, s, ticker, price)
    if out is None:
        raise HTTPException(404, "no SEC XBRL fundamentals available for this ticker")
    return out


# ------------------------------------------------------------------ operations
@router.post("/research/run")
async def research_run(force_competition: bool = False, who: Access = Depends(require_alpha_role("analyst"))):
    return await alpha_research_job.run_once(force_competition=force_competition)


@router.get("/research/runs")
async def research_runs(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db)):
    rows = db.query(AlphaResearchRun).order_by(AlphaResearchRun.started_at.desc()).limit(limit).all()
    return {"job": alpha_research_job.status(), "runs": [{"id": r.id, "kind": r.kind, "status": r.status, "started_at": r.started_at.isoformat(),
                                                           "finished_at": r.finished_at.isoformat() if r.finished_at else None, "summary": r.summary} for r in rows]}


@router.get("/audit-log")
async def audit_log(limit: int = Query(50, ge=1, le=300), db: Session = Depends(get_db)):
    rows = db.query(AlphaAuditLog).order_by(AlphaAuditLog.ts.desc()).limit(limit).all()
    return {"entries": [{"ts": r.ts.isoformat(), "actor": r.actor, "action": r.action, "detail": r.detail} for r in rows]}

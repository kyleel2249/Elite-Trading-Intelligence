"""Gathers the independent evidence the Decision layer needs for one candidate (council, investor
disclosures, OMNISIGNAL X). Shared by the API, the executor's order-time re-validation and the research job."""
from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable, Optional, Sequence

import httpx
from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaCandidate
from app.alpha.discovery import candidate_dict
from app.alpha.fundamentals import SecFundamentals, garp_screen, quality_screen
from app.alpha.investor_intel import assess_following
from app.alpha.macro import load_macro
from app.alpha.omnisignal_bridge import fetch_omnisignal
from app.alpha.providers import SecTickerUniverse
from app.config import Settings
from app.services.activity_store import ActivityStore

logger = logging.getLogger("eti.alpha")
_CIK: dict[str, Any] = {"ts": 0.0, "map": {}}
_FACTS: dict[int, tuple[float, dict[str, Any]]] = {}
DAY = 86400


async def load_fundamentals(db: Session, settings: Settings, ticker: str, price: Optional[float],
                            tickers: Optional[SecTickerUniverse] = None, facts_src: Optional[SecFundamentals] = None) -> Optional[dict[str, Any]]:
    """Quality + growth-at-reasonable-price screens from SEC XBRL for one US ticker; None when it cannot be evaluated."""
    try:
        if not _CIK["map"] or time.time() - _CIK["ts"] > DAY:
            rows = await (tickers or SecTickerUniverse(user_agent=settings.sec_user_agent, db=db)).listed()
            _CIK.update(ts=time.time(), map={r["ticker"].upper(): int(r["cik"]) for r in rows if r.get("cik") is not None})
        cik = _CIK["map"].get(ticker.upper())
        if cik is None:
            return None
        hit = _FACTS.get(cik)
        if not hit or time.time() - hit[0] > DAY:
            facts = await (facts_src or SecFundamentals(settings.sec_user_agent, db=db)).company_facts(cik)
            _FACTS[cik] = (time.time(), facts)
        else:
            facts = hit[1]
        return {"cik": cik, "entity": facts.get("entityName"), "quality": quality_screen(facts), "garp": garp_screen(facts, price)}
    except Exception:  # noqa: BLE001 - provider status already recorded
        logger.warning("fundamentals unavailable for %s", ticker, exc_info=True)
        return None


async def gather_context(db: Session, settings: Settings, cand: AlphaCandidate, bars: Sequence[dict[str, Any]],
                         omni_client: Optional[httpx.AsyncClient] = None,
                         macro_fn: Optional[Callable[[Settings], Awaitable[dict[str, Any]]]] = None,
                         fundamentals_fn: Optional[Callable[..., Awaitable[Optional[dict[str, Any]]]]] = None) -> dict[str, Any]:
    ctx: dict[str, Any] = {"investor_assessments": [], "council": None, "omnisignal": None, "macro": None, "fundamentals": None}
    try:
        m = await (macro_fn or load_macro)(settings)
        ctx["macro"] = m if m.get("status") == "ok" else None
    except Exception:  # noqa: BLE001
        logger.warning("macro context failed", exc_info=True)
    if cand.asset_class == "equity":
        ctx["fundamentals"] = await (fundamentals_fn or load_fundamentals)(db, settings, cand.symbol, cand.last_price)
    if cand.asset_class in ("equity", "etf"):
        try:
            for act in ActivityStore(db).list_activities(ticker=cand.symbol, limit=20):
                # Investor qualification is never assumed here: unqualified investors cannot yield a following opportunity.
                ctx["investor_assessments"].append(assess_following(
                    act, current_price=cand.last_price, reference_price=None, candidate=candidate_dict(cand),
                    investor_qualified=False, investor_modules=[], lab_longs=[]))
        except Exception:  # noqa: BLE001
            logger.warning("investor context failed for %s", cand.symbol, exc_info=True)
    if cand.asset_class == "crypto":
        try:
            from app.intelligence.council import TradingCouncil
            c = TradingCouncil().analyse(symbol=cand.symbol, provider="binance", price=bars[-1]["close"] if bars else None, bid=None, ask=None,
                                         data_status="fresh", klines=list(bars)[-48:])
            ctx["council"] = {"action": c.action.value, "confidence": c.confidence, "summary": c.summary, "risk_veto": c.risk_veto}
        except Exception:  # noqa: BLE001
            logger.warning("council unavailable for %s", cand.symbol, exc_info=True)
        ctx["omnisignal"] = await fetch_omnisignal(settings.omnisignal_base_url, cand.symbol, client=omni_client)
    return ctx

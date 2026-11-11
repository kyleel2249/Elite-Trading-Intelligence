"""Research AI: public-investor intelligence.

- Qualification: transparent, evidence-based criteria; wealth or popularity never qualifies.
- Disclosure freshness: 13F / Form 4 / Form 13D-G are delayed; delay is carried forward.
- Investor-following: a 12-step assessment that can only produce a research
  classification. It never authorizes an order.
- Profile audit and versioned updates: gaps are reported, never filled with guesses.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.alpha.db_models import TraderProfileVersion, TraderQualification
from app.knowledge.registry import _all_profiles, get_trader
from app.knowledge.schema import TraderKnowledgeProfile

FOUNDATIONAL_35 = (
    "george_soros stanley_druckenmiller paul_tudor_jones bruce_kovner richard_dennis william_eckhardt ed_seykota mark_minervini "
    "nicolas_darvas jesse_livermore richard_wyckoff william_oneil larry_williams linda_bradford_raschke kathy_lien ray_dalio "
    "jim_simons warren_buffett charlie_munger peter_lynch john_paulson michael_burry david_tepper john_templeton ed_thorp "
    "michael_steinhardt julian_robertson david_shaw marty_schwartz tom_basso howard_marks chris_hohn david_einhorn "
    "john_w_henry robert_mercer").split()

PRIMARY_KINDS = {"regulator_filing", "fund_letter", "audited_financials", "own_book_or_paper", "official_fund_disclosure"}
PERFORMANCE_GRADES = {"audited": 3, "primary_reported": 2, "secondary_reported": 1, "none": 0}

_PLACEHOLDERS = ("source-dependent", "see public", "see patterns", "see philosophy", "often unpublished", "varies by", "not assumed",
                 "public career summary", "usually not fully public", "media estimate if any", "evaluate dated", "expand with primary",
                 "per documented public methodology", "style-favorable", "process discipline", "outside edge", "outside competence",
                 "firm/strategy specific", "thesis or system exit", "aligned with documented", "timestamped evaluation only",
                 "public case studies", "regime sensitivity", "attribution only when", "helena frost risk always applies",
                 "expandable", "evaluate dated claims")


def _is_placeholder(text: str) -> bool:
    t = text.lower()
    return any(p in t for p in _PLACEHOLDERS)


# ---------------------------------------------------------------- qualification

def qualify_investor(db: Optional[Session], payload: dict[str, Any]) -> dict[str, Any]:
    """payload: name, category, years_documented, sources[{kind,url,published,title}], performance_evidence,
    return_basis, risk_evidence(bool), methodology_documented(bool), basis_of_nomination."""
    name = (payload.get("name") or "").strip()
    sources = payload.get("sources") or []
    primary = [s for s in sources if s.get("kind") in PRIMARY_KINDS]
    distinct = {(s.get("url") or s.get("title") or "").strip().lower() for s in sources if s.get("url") or s.get("title")}
    years = float(payload.get("years_documented") or 0)
    perf = payload.get("performance_evidence", "none")
    basis = payload.get("return_basis", "unknown")
    checks = [
        {"id": "C1_longevity", "pass": years >= 10, "detail": f"{years:g} documented years (>= 10 required)"},
        {"id": "C2_independent_sources", "pass": len(distinct) >= 2 and len(primary) >= 1,
         "detail": f"{len(distinct)} distinct sources, {len(primary)} primary (needs >= 2 and >= 1)"},
        {"id": "C3_performance_evidence", "pass": PERFORMANCE_GRADES.get(perf, 0) >= 2,
         "detail": f"performance evidence grade '{perf}' (needs primary_reported or audited)"},
        {"id": "C4_risk_management_evidence", "pass": bool(payload.get("risk_evidence")), "detail": "documented drawdown or risk process"},
        {"id": "C5_methodology_documented", "pass": bool(payload.get("methodology_documented")), "detail": "methodology described in primary material"},
        {"id": "C6_not_wealth_or_popularity_only", "pass": payload.get("basis_of_nomination") not in ("net_worth", "social_following", "media_popularity"),
         "detail": f"nominated on '{payload.get('basis_of_nomination')}'"},
    ]
    flags = []
    if basis in ("fund_level", "mixed", "unknown"):
        flags.append(f"returns are '{basis}': fund returns must not be presented as personal returns")
    if perf in ("none", "secondary_reported"):
        flags.append("performance rests on secondary or no evidence; survivorship and selection bias cannot be assessed")
    failed = [c for c in checks if not c["pass"]]
    hard = {"C1_longevity", "C2_independent_sources", "C6_not_wealth_or_popularity_only"}
    if any(c["id"] in hard for c in failed):
        status = "REJECTED"
    elif not failed:
        status = "QUALIFIED"
    else:
        status = "PENDING_EVIDENCE"
    out = {"name": name, "category": payload.get("category", "unspecified"), "status": status, "criteria": checks,
           "flags": flags, "reasons": [c["detail"] for c in failed] or ["all qualification criteria met"],
           "rule": "Wealth, follower count and short-term gains never qualify an investor."}
    if db is not None and name:
        db.add(TraderQualification(name=name, category=out["category"], evidence=sources, criteria={"checks": checks, "flags": flags},
                                   status=status, reasons=out["reasons"]))
        db.commit()
    return out


# ---------------------------------------------------------------- disclosure freshness

def _parse(d: Optional[str]) -> Optional[date]:
    if not d:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y%m%d"):
        try:
            return datetime.strptime(str(d)[:19], fmt).date()
        except ValueError:
            continue
    return None


def disclosure_freshness(act: dict[str, Any], today: Optional[date] = None) -> dict[str, Any]:
    today = today or datetime.now(timezone.utc).date()
    cat = (act.get("category") or "").lower()
    pub = _parse(act.get("publication_date") or act.get("filing_or_report_date"))
    txn = _parse(act.get("transaction_date"))
    period = _parse(act.get("period_of_report"))
    anchor = txn or period
    delay = (pub - anchor).days if pub and anchor else None
    age_since_pub = (today - pub).days if pub else None
    age_since_event = (today - anchor).days if anchor else age_since_pub
    thresholds = {"13f_holding": (14, 60, 135), "institutional_holding": (14, 60, 135), "insider_purchase": (7, 30, 90),
                  "insider_buy": (7, 30, 90), "congressional_trade": (7, 30, 90)}.get(cat, (7, 30, 90))
    if age_since_event is None:
        level = "UNKNOWN"
    elif age_since_event <= thresholds[0] + (delay or 0) and age_since_event <= thresholds[1]:
        level = "FRESH"
    elif age_since_event <= thresholds[1] + (delay or 0):
        level = "AGING"
    else:
        level = "STALE"
    kind = "reported_holding" if cat in ("13f_holding", "institutional_holding") else "disclosed_transaction"
    return {"level": level, "information_delay_days": delay, "days_since_event": age_since_event, "days_since_publication": age_since_pub,
            "information_kind": kind, "is_delayed": True,
            "warning": "13F lists certain long positions at quarter end, filed up to 45 days later; it is not the investor's current portfolio."
            if kind == "reported_holding" else "Disclosed trade; price may have moved materially since the transaction date."}


# ---------------------------------------------------------------- investor-following assessment

FOLLOW_CLASSES = ("INVESTOR_FOLLOWING_OPPORTUNITY", "INVESTOR_STRATEGY_MATCH", "INSTITUTIONAL_ACCUMULATION_SIGNAL",
                  "CONTRARIAN_OPPORTUNITY", "STALE_DISCLOSURE", "REJECTED_OPPORTUNITY")
TRUSTED_SOURCES = {"sec_edgar", "quiver_quant", "official_fund_disclosure", "exchange_filing"}


def assess_following(act: dict[str, Any], *, current_price: Optional[float], reference_price: Optional[float],
                     candidate: Optional[dict[str, Any]], investor_qualified: bool, investor_modules: list[str],
                     lab_longs: list[str], other_buyers: int = 0, min_rr: float = 2.0,
                     today: Optional[date] = None) -> dict[str, Any]:
    """12-step assessment. Output is a research classification; execution is decided elsewhere."""
    fresh = disclosure_freshness(act, today)
    checks: list[dict[str, Any]] = []

    def step(n: int, name: str, ok: Optional[bool], detail: str, hard: bool = False) -> None:
        checks.append({"step": n, "name": name, "pass": ok, "detail": detail, "hard": hard})

    direction = (act.get("direction") or "").lower()
    step(1, "documented investment action", direction in ("buy", "sell") or act.get("category") in ("13f_holding",),
         f"category={act.get('category')} direction={direction or 'n/a'}", hard=True)
    verified = str(act.get("verification_status") or "").upper()
    step(2, "source verified", act.get("source_provider") in TRUSTED_SOURCES and not verified.startswith(("UNCONFIRMED", "DISPUTED")),
         f"source={act.get('source_provider')} status={verified}", hard=True)
    step(3, "transaction date established", bool(act.get("transaction_date") or act.get("period_of_report")),
         f"transaction={act.get('transaction_date')} period={act.get('period_of_report')}")
    step(4, "delay assessed", fresh["level"] in ("FRESH", "AGING"), f"{fresh['level']}; delay {fresh['information_delay_days']}d; {fresh['days_since_event']}d old")
    step(5, "investor methodology evaluated", investor_qualified and bool(investor_modules),
         f"qualified={investor_qualified}; modules={investor_modules}")
    stage = (candidate or {}).get("stage")
    bad_stage = stage in ("DISTRIBUTION", "REVERSAL_RISK", "MOMENTUM_EXHAUSTION")
    step(6, "current market conditions", candidate is not None and not bad_stage, f"stage={stage}" if candidate else "no current market analysis", hard=bad_stage)
    chase = None
    if current_price and reference_price:
        chase = current_price / reference_price - 1
    step(7, "opportunity still valid", chase is not None and chase <= 0.10,
         f"price moved {chase:+.1%} versus disclosure reference" if chase is not None else "no reference price", hard=bool(chase is not None and chase > 0.25))
    plan = (candidate or {}).get("plan") or {}
    step(8, "present-day entry computed", bool(plan.get("entry_zone")), f"entry_zone={plan.get('entry_zone')}")
    liq = ((candidate or {}).get("scores") or {}).get("liquidity")
    step(9, "valuation & liquidity", liq is not None and liq >= 25, f"liquidity score={liq}; valuation data not available" if liq is not None else "no liquidity evidence", hard=liq is not None and liq < 10)
    rr = None
    if current_price and plan.get("invalidation_level") and plan.get("atr14"):
        risk = current_price - plan["invalidation_level"]
        rr = (3 * plan["atr14"]) / risk if risk > 0 else None
    step(10, "risk/reward", rr is not None and rr >= min_rr, f"R:R to 3xATR target = {rr:.2f}" if rr else "cannot compute", hard=rr is not None and rr < 1.0)
    step(11, "agreement with ETI strategies", bool(lab_longs), f"{len(lab_longs)} compatible strategies long: {lab_longs[:4]}")
    step(12, "independent validation", None, "pending: the Decision layer must validate before any order")
    hard_fail = [c for c in checks if c["hard"] and c["pass"] is False]
    reasons = [f"step {c['step']} {c['name']}: {c['detail']}" for c in hard_fail]
    if fresh["level"] == "STALE":
        cls = "STALE_DISCLOSURE"
    elif hard_fail:
        cls = "REJECTED_OPPORTUNITY"
    elif other_buyers >= 1 and investor_qualified and direction == "buy" and stage in ("EARLY_ACCUMULATION", "PRE_ACCUMULATION", "BREAKOUT_FORMATION"):
        cls = "INSTITUTIONAL_ACCUMULATION_SIGNAL"
    elif direction == "buy" and stage in ("PRE_ACCUMULATION", "EARLY_ACCUMULATION") and chase is not None and chase <= 0.0 and investor_qualified:
        cls = "CONTRARIAN_OPPORTUNITY"
    elif investor_qualified and lab_longs and direction == "buy" and (chase is None or chase <= 0.10):
        cls = "INVESTOR_STRATEGY_MATCH"
    elif direction == "buy" and investor_qualified and all(c["pass"] for c in checks if c["step"] in (1, 2, 3, 4, 5, 6, 7)):
        cls = "INVESTOR_FOLLOWING_OPPORTUNITY"
    else:
        cls = "REJECTED_OPPORTUNITY"
        reasons = reasons or [f"step {c['step']} {c['name']}: {c['detail']}" for c in checks if c["pass"] is False][:3] or ["criteria for a following opportunity not met"]
    return {"classification": cls, "freshness": fresh, "checks": checks, "reasons": reasons or ["all pre-validation checks satisfied"],
            "authorizes_order": False, "rule": "Wealth or popularity alone is never a reason; the Decision layer must independently validate."}


def overlap_report(holdings_by_filer: dict[str, list[dict[str, Any]]], qualified_filers: Optional[set[str]] = None) -> dict[str, Any]:
    """CUSIPs held by two or more filers in their latest filing. Carries each filing's date; no sector themes are asserted."""
    by_cusip: dict[str, dict[str, Any]] = {}
    for filer, rows in holdings_by_filer.items():
        if qualified_filers is not None and filer not in qualified_filers:
            continue
        for r in rows:
            if r.get("put_call") or not r.get("cusip"):
                continue
            e = by_cusip.setdefault(r["cusip"], {"cusip": r["cusip"], "issuer": r.get("issuer"), "holders": {}})
            e["holders"][filer] = {"shares": r.get("shares"), "value_usd": r.get("value_usd"), "period_of_report": r.get("period_of_report"),
                                   "filing_date": r.get("filing_date")}
    overlaps = [dict(v, holder_count=len(v["holders"])) for v in by_cusip.values() if len(v["holders"]) >= 2]
    overlaps.sort(key=lambda x: -x["holder_count"])
    return {"overlaps": overlaps[:50], "note": "Overlap of delayed quarterly snapshots; filers' reporting periods may differ; no shared thesis is implied."}


# ---------------------------------------------------------------- profile audit & versioning

PROFILE_CATEGORIES: list[tuple[int, str, str]] = [
    (1, "biography", "biography"), (2, "trading history", "trading_history"), (3, "markets traded", "markets_traded"),
    (4, "instruments", "preferred_instruments"), (5, "philosophy", "philosophy"), (6, "documented patterns", "documented_patterns"),
    (7, "entry criteria", "entry_criteria"), (8, "exit criteria", "exit_criteria"), (9, "stop-loss methodology", "stop_loss_methodology"),
    (10, "position sizing", "position_sizing"), (11, "risk/reward", "risk_reward"), (12, "indicators", "technical_indicators"),
    (13, "fundamental methodology", "fundamental_methodology"), (14, "preferred conditions", "preferred_conditions"),
    (15, "avoid conditions", "avoid_conditions"), (16, "psychology", "decision_psychology"), (17, "returns", "historical_returns"),
    (18, "drawdowns", "historical_drawdowns"), (19, "win rates", "win_rates"), (20, "net worth", "net_worth"),
    (21, "successful trades", "famous_successful_trades"), (22, "unsuccessful trades", "famous_unsuccessful_trades"),
    (23, "predictions", "predictions_outcomes"), (24, "strengths/weaknesses/lessons", "strengths"),
]


def _category_state(p: TraderKnowledgeProfile, attr: str) -> dict[str, Any]:
    v = getattr(p, attr)
    items = v if isinstance(v, list) else [v]
    texts = [(i.claim if hasattr(i, "claim") else str(i)) for i in items if i]
    if not texts:
        return {"status": "MISSING", "cited": False}
    real = [t for t in texts if not _is_placeholder(t)]
    cited = any(getattr(i, "source", None) for i in items if hasattr(i, "claim"))
    notes = [i for i in items if hasattr(i, "claim")]
    sourced_unknown = [i for i in notes if getattr(i, "classification", "") == "not_documented" and getattr(i, "source", None)]
    claims_data = [i for i in notes if getattr(i, "classification", "") not in ("not_documented", "speculation")]
    if sourced_unknown and not claims_data:
        return {"status": "UNKNOWN_PUBLICLY", "cited": cited}  # a sourced "none found", with no note asserting actual data, is a complete answer
    if attr in ("win_rates",) and all("no " in t.lower() or "usually not" in t.lower() or "not fully public" in t.lower() for t in texts):
        return {"status": "UNKNOWN_PUBLICLY", "cited": cited}  # honest 'unknown' is a valid, complete answer
    if not real:
        return {"status": "PLACEHOLDER", "cited": cited}
    return {"status": "DOCUMENTED_UNCITED" if not cited and attr in ("historical_returns", "historical_drawdowns", "net_worth") else "DOCUMENTED",
            "cited": cited}


def audit_profiles(db: Optional[Session] = None, ids: Optional[list[str]] = None) -> dict[str, Any]:
    profiles = _all_profiles()
    out, missing = [], [i for i in FOUNDATIONAL_35 if i not in profiles]
    for pid in ids or FOUNDATIONAL_35:
        p = profiles.get(pid)
        if p is None:
            continue
        cats = {name: _category_state(p, attr) for _, name, attr in PROFILE_CATEGORIES}
        complete = sum(1 for c in cats.values() if c["status"] in ("DOCUMENTED", "UNKNOWN_PUBLICLY"))
        gaps = [n for n, c in cats.items() if c["status"] in ("MISSING", "PLACEHOLDER", "DOCUMENTED_UNCITED")]
        out.append({"trader_id": pid, "name": p.full_name, "complete_categories": complete, "of": 24,
                    "completeness_pct": round(complete / 24 * 100, 1), "research_gaps": gaps,
                    "cited_sources": sum(1 for n in (p.historical_returns + p.historical_drawdowns + p.win_rates + p.net_worth) if n.source),
                    "categories": cats})
    out.sort(key=lambda r: r["completeness_pct"])
    avg = sum(r["completeness_pct"] for r in out) / len(out) if out else 0.0
    return {"profiles": len(out), "foundational_missing": missing, "average_completeness_pct": round(avg, 1), "results": out,
            "note": "PLACEHOLDER means the text is generic filler, not research. Gaps need primary-source research; ETI never invents rules or statistics."}


VERSIONABLE_FIELDS = {a for _, _, a in PROFILE_CATEGORIES} | {"aliases", "expandable_notes", "tags", "eti_lessons", "strategy_module_ids", "weaknesses"}


def propose_profile_update(db: Session, trader_id: str, field: str, new_value: Any, reason: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
    if field not in VERSIONABLE_FIELDS:
        raise ValueError(f"field '{field}' is not versionable")
    if trader_id not in _all_profiles():
        raise ValueError("unknown trader")
    good = [s for s in sources if (s.get("url") or s.get("citation")) and s.get("published")]
    if not good or not reason.strip():
        raise ValueError("an update needs a reason and at least one source with citation/url and publication date")
    current = effective_profile(db, trader_id)
    old = current.get(field)
    last = db.query(TraderProfileVersion).filter_by(trader_id=trader_id).order_by(TraderProfileVersion.version.desc()).first()
    ver = (last.version + 1) if last else 2  # version 1 is the shipped baseline
    row = TraderProfileVersion(trader_id=trader_id, version=ver, field=field, old_value={"value": old}, new_value={"value": new_value},
                               change_reason=reason.strip(), sources=good)
    db.add(row)
    db.commit()
    return {"trader_id": trader_id, "version": ver, "field": field, "preserved_previous": True}


def effective_profile(db: Session, trader_id: str) -> dict[str, Any]:
    base = get_trader(trader_id) or {}
    for v in db.query(TraderProfileVersion).filter_by(trader_id=trader_id).order_by(TraderProfileVersion.version.asc()).all():
        base[v.field] = (v.new_value or {}).get("value")
    base["_version"] = (db.query(TraderProfileVersion).filter_by(trader_id=trader_id).count() or 0) + 1
    return base


def profile_history(db: Session, trader_id: str) -> list[dict[str, Any]]:
    rows = db.query(TraderProfileVersion).filter_by(trader_id=trader_id).order_by(TraderProfileVersion.version.asc()).all()
    return [{"version": r.version, "field": r.field, "old": r.old_value, "new": r.new_value, "reason": r.change_reason,
             "sources": r.sources, "at": r.created_at.isoformat()} for r in rows]

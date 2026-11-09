"""Decision AI: independent validation and intelligence fusion.

The Decision layer re-fetches raw bars and recomputes features itself; it never
trusts the Discovery layer's stored numbers. Engines publish structured evidence
(EngineEvidence). Any hard-veto evidence makes approval impossible, no matter how
strong other scores are (investor consensus can never override a hard risk failure).

Plug-in engines: register_engine(name, fn) attaches additional engines (e.g. an
OMNISIGNAL-style fusion or other signal engines) without changing this module.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Sequence

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaCandidate, AlphaStrategyState
from app.alpha.discovery import overall_rank
from app.alpha.features import compute_features
from app.alpha.predictions import record_alpha_prediction
from app.alpha.scoring import classify_stage, components_from_features, score_early_alpha
from app.alpha.strategy_lab import detect_regime, live_signals
from app.alpha.strategy_library import LIBRARY
from app.alpha.token_safety import screen_dex_pair
from app.config import Settings, get_settings
from app.risk.engine import RiskEngine

logger = logging.getLogger("eti.alpha")
BAD_STAGES = ("DISTRIBUTION", "REVERSAL_RISK", "MOMENTUM_EXHAUSTION")
RISK_SCALE = {"equity": 1.0, "etf": 1.0, "crypto": 0.75, "token": 0.25}
MIN_DOLLAR_VOL = {"equity": 1_000_000.0, "etf": 1_000_000.0, "crypto": 1_000_000.0, "token": 50_000.0}
MAX_BAR_AGE_DAYS = {"equity": 5, "etf": 5, "crypto": 2, "token": 2}


@dataclass
class EngineEvidence:
    engine: str
    available: bool
    bias: str = "neutral"          # bullish | bearish | neutral
    confidence: float = 0.0
    hard_veto: bool = False
    evidence: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)


EngineFn = Callable[[dict[str, Any]], EngineEvidence]
_ENGINES: dict[str, EngineFn] = {}


def register_engine(name: str, fn: EngineFn) -> None:
    _ENGINES[name] = fn


# ------------------------------------------------------------------ built-in engines

def engine_technical(ctx: dict[str, Any]) -> EngineEvidence:
    f, stage = ctx["features"], ctx["stage"]
    if not f.get("sufficient"):
        return EngineEvidence("technical", False, limitations=["insufficient bars"])
    bull = stage in ("EARLY_ACCUMULATION", "BREAKOUT_FORMATION", "BREAKOUT_CONFIRMATION", "TREND_EXPANSION")
    bear = stage in BAD_STAGES
    return EngineEvidence("technical", True, "bullish" if bull else "bearish" if bear else "neutral", 0.6 if (bull or bear) else 0.3,
                          evidence=[f"stage={stage}", f"rvol={f.get('rvol')}", f"ud_volume_ratio={f.get('ud_volume_ratio')}"])


def engine_strategy_lab(ctx: dict[str, Any]) -> EngineEvidence:
    sigs = ctx["lab"]
    comp = [s for s in sigs if s["compatible"] and s["long"] is not None]
    if not comp:
        return EngineEvidence("strategy_lab", False, limitations=["no compatible executable strategy with enough bars"])
    longs = [s for s in comp if s["long"]]
    ratio = len(longs) / len(comp)
    return EngineEvidence("strategy_lab", True, "bullish" if ratio >= 0.5 else "bearish" if ratio == 0 else "neutral", 0.3 + 0.4 * ratio,
                          evidence=[f"{len(longs)}/{len(comp)} compatible modules long", *[s["strategy_id"] for s in longs][:6]],
                          limitations=["signals use default parameters; unpromoted modules count as evidence, not proof"])


def engine_investor(ctx: dict[str, Any]) -> EngineEvidence:
    follow = ctx.get("investor_assessments") or []
    if not follow:
        return EngineEvidence("investor_intel", False, limitations=["no disclosed investor activity matched this asset"])
    good = [a for a in follow if a["classification"] in ("INVESTOR_FOLLOWING_OPPORTUNITY", "INVESTOR_STRATEGY_MATCH", "INSTITUTIONAL_ACCUMULATION_SIGNAL", "CONTRARIAN_OPPORTUNITY")]
    return EngineEvidence("investor_intel", True, "bullish" if good else "neutral", 0.5 if good else 0.2,
                          evidence=[f"{a['classification']}" for a in follow[:5]],
                          limitations=["disclosures are delayed; investor activity can never override a risk failure"])


def engine_onchain(ctx: dict[str, Any]) -> EngineEvidence:
    oc = ctx.get("onchain")
    if not oc or oc.get("component") is None:
        return EngineEvidence("onchain", False, limitations=["no measurable on-chain evidence (needs explorer config and labelled exchange addresses)"])
    c = oc["component"]
    return EngineEvidence("onchain", True, "bullish" if c >= 60 else "bearish" if c <= 40 else "neutral", 0.5,
                          evidence=[f"net exchange flow USD={oc.get('net_exchange_flow_usd')}"], limitations=oc.get("limits", []))


def engine_council(ctx: dict[str, Any]) -> EngineEvidence:
    c = ctx.get("council")
    if c is None:
        return EngineEvidence("trading_council", False, limitations=["council not run"])
    act = c["action"]
    bias = "bullish" if act in ("BUY", "STRONG_BUY") else "bearish" if act in ("SELL", "STRONG_SELL") else "neutral"
    return EngineEvidence("trading_council", True, bias, float(c.get("confidence") or 0.0), hard_veto=bool(c.get("risk_veto")),
                          evidence=[f"action={act}", c.get("summary", "")[:160]], limitations=["council uses price/volume plus optional macro and news feeds"])


def engine_omnisignal(ctx: dict[str, Any]) -> EngineEvidence:
    """Worker OMNISIGNAL X (Swift-inspired + GainzAlgo-inspired engines, fusion, independent validator)."""
    from app.alpha.omnisignal_bridge import summarize
    sm = summarize(ctx.get("omnisignal"))
    if not sm["available"]:
        return EngineEvidence("omnisignal_x", False, limitations=["OMNISIGNAL_BASE_URL not set, symbol unsupported, or Worker data unreliable"])
    d = sm["decision"]
    conf = min(1.0, max(0.0, float(sm.get("confidence_heuristic") or 0) / 100.0))
    ev = [f"decision={d}", f"agreement={sm.get('agreement')}", f"validator={sm.get('classification')}"] + sm["hard_failures"][:2]
    lim = ["Worker confidence is a heuristic score, not a probability", "daily-candle candidate analysed with the swing profile"]
    if d == "BUY":
        return EngineEvidence("omnisignal_x", True, "bullish", conf, evidence=ev, limitations=lim)
    if d == "SELL":  # an independently validated opposing signal blocks a long thesis
        return EngineEvidence("omnisignal_x", True, "bearish", conf, hard_veto=True, evidence=ev, limitations=lim)
    if d == "REJECTED" and sm["hard_failures"]:
        return EngineEvidence("omnisignal_x", True, "neutral", conf, hard_veto=True, evidence=ev, limitations=lim)
    return EngineEvidence("omnisignal_x", True, "neutral", conf, evidence=ev, limitations=lim)


def engine_macro(ctx: dict[str, Any]) -> EngineEvidence:
    """Soft evidence only: the macro backdrop can lower or raise conviction but never approves or vetoes on its own."""
    m = ctx.get("macro")
    if not m or m.get("status") != "ok":
        return EngineEvidence("macro_regime", False, limitations=["FRED not configured or unavailable"])
    liq = (m.get("liquidity") or {}).get("regime", "UNKNOWN")
    ev = [f"liquidity={liq}", f"growth/inflation={(m.get('growth_inflation') or {}).get('quadrant')}", f"credit={(m.get('credit') or {}).get('state')}"]
    lim = ["descriptive ETI parameterization; not backtested", "never approves or vetoes a trade by itself"]
    if liq == "EASING_LIQUIDITY":
        return EngineEvidence("macro_regime", True, "bullish", 0.3, evidence=ev, limitations=lim)
    if liq == "TIGHTENING_LIQUIDITY":
        return EngineEvidence("macro_regime", True, "bearish", 0.3, evidence=ev, limitations=lim)
    return EngineEvidence("macro_regime", True, "neutral", 0.2, evidence=ev, limitations=lim)


def engine_fundamentals(ctx: dict[str, Any]) -> EngineEvidence:
    f = ctx.get("fundamentals")
    if not f:
        return EngineEvidence("fundamentals", False, limitations=["no SEC XBRL fundamentals (equities only; needs ticker-to-CIK match)"])
    q, g = f.get("quality") or {}, f.get("garp") or {}
    ev = [f"quality={q.get('verdict')}", f"garp={g.get('verdict')}" + (f" PEG {g.get('peg')}" if g.get("peg") is not None else "")]
    lim = ["trailing audited 10-K data, possibly >1 year old", "ETI-parameterized screens, not investors' own thresholds"]
    if q.get("verdict") == "PASSES_SCREEN" and g.get("verdict") in ("FAVORABLE", "FAIR"):
        return EngineEvidence("fundamentals", True, "bullish", 0.4, evidence=ev, limitations=lim)
    if q.get("verdict") == "FAILS_SCREEN" or g.get("verdict") == "UNFAVORABLE":
        return EngineEvidence("fundamentals", True, "bearish", 0.3, evidence=ev, limitations=lim)
    return EngineEvidence("fundamentals", True, "neutral", 0.2, evidence=ev, limitations=lim)


def engine_risk(ctx: dict[str, Any]) -> EngineEvidence:
    """Hard-veto engine: liquidity, safety, data, volatility. Cannot be outvoted."""
    f, ac = ctx["features"], ctx["asset_class"]
    veto, ev = False, []
    if not f.get("sufficient"):
        return EngineEvidence("risk", True, hard_veto=True, evidence=["insufficient history"])
    dv = f.get("dollar_volume_20") or 0.0
    if dv < MIN_DOLLAR_VOL.get(ac, 1e6):
        veto = True
        ev.append(f"illiquid: average dollar volume {dv:,.0f}")
    if (f.get("atr_pct") or 0) > (0.25 if ac in ("crypto", "token") else 0.12):
        veto = True
        ev.append(f"volatility too high: ATR {f['atr_pct']:.1%} of price")
    safety = ctx.get("safety")
    if safety and safety.get("hard_fail"):
        veto = True
        ev.append("token safety screen hard-failed")
    if ctx["stage"] in BAD_STAGES:
        veto = True
        ev.append(f"lifecycle stage {ctx['stage']}")
    return EngineEvidence("risk", True, "bearish" if veto else "neutral", 1.0 if veto else 0.5, hard_veto=veto, evidence=ev or ["no hard risk failure"])


for _n, _f in (("technical", engine_technical), ("strategy_lab", engine_strategy_lab), ("investor_intel", engine_investor),
               ("onchain", engine_onchain), ("trading_council", engine_council), ("omnisignal_x", engine_omnisignal), ("macro_regime", engine_macro), ("fundamentals", engine_fundamentals), ("risk", engine_risk)):
    register_engine(_n, _f)


# ------------------------------------------------------------------ plan maths

def build_trade_plan(f: dict[str, Any], settings: Settings, equity: float, asset_class: str, adv_dollars: Optional[float]) -> dict[str, Any]:
    entry = f["last"]
    a = f.get("atr14") or 0.0
    structural = f["low_20"] - 0.5 * a
    atr_stop = entry - 3.0 * a
    stop = max(structural, atr_stop)             # tighter of the two ...
    stop = min(stop, entry - 1.0 * a)            # ... but never inside normal noise
    r = entry - stop
    if r <= 0 or a <= 0:
        return {"valid": False, "reason": "cannot construct a stop below entry"}
    tp1, tp2, tp3 = entry + 1.5 * r, entry + 3.0 * r, entry + 5.0 * r
    risk_pct = settings.default_risk_per_trade_pct * RISK_SCALE.get(asset_class, 0.5)
    qty = RiskEngine(settings).position_size(equity, entry, stop, risk_pct)
    capped = False
    notional_cap = equity * settings.max_position_notional_pct / 100.0  # same cap the server-side RiskEngine enforces
    notional_capped = qty * entry > notional_cap
    if notional_capped:
        qty = notional_cap / entry
    if adv_dollars and qty * entry > adv_dollars * settings.alpha_max_participation_pct / 100.0:
        qty, capped = adv_dollars * settings.alpha_max_participation_pct / 100.0 / entry, True
    return {"valid": True, "entry": entry, "stop": stop, "tp1": tp1, "tp2": tp2, "tp3": tp3, "risk_per_unit": r,
            "rr_tp2": 3.0, "rr_tp3": 5.0, "risk_pct": risk_pct, "qty": qty, "notional": qty * entry,
            "liquidity_capped": capped, "notional_capped": notional_capped, "max_notional_pct": settings.max_position_notional_pct, "scale_out": "1/3 at TP1 (stop to breakeven), 1/3 at TP2, remainder at TP3",
            "method": "stop = tighter of structural 20-bar low-0.5ATR and 3xATR, never inside 1xATR; targets 1.5R/3R/5R"}


def _bar_age_days(bars: Sequence[dict[str, Any]]) -> Optional[float]:
    last = bars[-1]
    t = last.get("close_time") or last.get("open_time")
    try:
        if isinstance(t, (int, float)):
            ts = datetime.fromtimestamp(float(t) / 1000.0, tz=timezone.utc)
        else:
            ts = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return (datetime.now(timezone.utc) - ts).total_seconds() / 86400.0


# ------------------------------------------------------------------ independent validation

def validate(db: Session, cand: AlphaCandidate, bars: Sequence[dict[str, Any]], *, settings: Optional[Settings] = None,
             equity: float = 10_000.0, open_positions: int = 0, council: Optional[dict[str, Any]] = None,
             investor_assessments: Optional[list[dict[str, Any]]] = None, onchain: Optional[dict[str, Any]] = None,
             dex_pair: Optional[dict[str, Any]] = None, bench_closes: Optional[list[float]] = None,
             omnisignal: Optional[dict[str, Any]] = None, macro: Optional[dict[str, Any]] = None,
             fundamentals: Optional[dict[str, Any]] = None, record: bool = True) -> dict[str, Any]:
    """Re-derive everything from `bars`. Returns the decision and updates the candidate."""
    settings = settings or get_settings()
    ac = cand.asset_class
    f = compute_features(bars, bench_closes)
    stg = classify_stage(f, ac) if f.get("sufficient") else {"stage": None, "reasons": ["insufficient"]}
    comps = components_from_features(f, ac)
    if onchain and onchain.get("component") is not None:
        comps["onchain"] = onchain["component"]
    if fundamentals:
        from app.alpha.fundamentals import valuation_component
        comps["valuation"] = valuation_component(fundamentals.get("garp"))
    early = score_early_alpha(ac, comps)
    safety = screen_dex_pair(dex_pair) if dex_pair else None
    regime = detect_regime(bars) if f.get("sufficient") else {"trend": "unknown", "regimes": ["any"]}
    lab = live_signals(bars, ac if ac != "token" else "crypto") if f.get("sufficient") else []
    ctx = {"asset_class": ac, "features": f, "stage": stg["stage"], "lab": lab, "council": council, "safety": safety,
           "investor_assessments": investor_assessments or [], "onchain": onchain, "omnisignal": omnisignal, "macro": macro, "fundamentals": fundamentals}
    evidences: list[EngineEvidence] = []
    for name, fn in _ENGINES.items():
        try:
            evidences.append(fn(ctx))
        except Exception as exc:  # noqa: BLE001 - a broken plug-in must not approve anything
            evidences.append(EngineEvidence(name, True, hard_veto=True, evidence=[f"engine error: {type(exc).__name__}"]))
    avail = [e for e in evidences if e.available]
    bulls = [e for e in avail if e.bias == "bullish" and e.engine not in ("risk", "macro_regime")]  # macro is context, not independent agreement
    vetoes = [e for e in avail if e.hard_veto]

    checks: list[dict[str, Any]] = []

    def chk(cid: str, ok: bool, detail: str, hard: bool = True) -> None:
        checks.append({"id": cid, "pass": bool(ok), "detail": detail, "hard": hard})

    age = _bar_age_days(bars) if bars else None
    chk("V1_data_fresh_and_sufficient", f.get("sufficient") and age is not None and age <= MAX_BAR_AGE_DAYS.get(ac, 3),
        f"{len(bars)} bars, last bar {age:.1f}d old" if age is not None else "bar age unknown")
    plan = build_trade_plan(f, settings, equity, ac, f.get("dollar_volume_20")) if f.get("sufficient") else {"valid": False}
    chk("V2_liquidity_and_size", f.get("sufficient") and (f.get("dollar_volume_20") or 0) >= MIN_DOLLAR_VOL.get(ac, 1e6) and not plan.get("liquidity_capped", False),
        f"avg dollar volume {f.get('dollar_volume_20')}; order {'capped by participation limit' if plan.get('liquidity_capped') else 'within participation limit'}")
    chk("V3_risk_reward", plan.get("valid") and plan.get("rr_tp2", 0) >= 2.0, f"R:R to TP2 = {plan.get('rr_tp2')}")
    chk("V4_safety_screen", not (safety and safety["hard_fail"]), f"safety={safety['verdict'] if safety else 'n/a (not a DEX asset)'}")
    chk("V5_lifecycle_stage", stg["stage"] not in BAD_STAGES and stg["stage"] is not None, f"stage={stg['stage']}")
    hot = 0.5 if ac in ("crypto", "token") else 0.25
    chk("V6_not_extended", (f.get("extension_50") or 0) < hot, f"extension vs SMA50 = {f.get('extension_50')}")
    chk("V7_independent_engine_agreement", len(bulls) >= 2, f"{len(bulls)} independent engines bullish: {[b.engine for b in bulls]}")
    chk("V8_no_engine_veto", not vetoes, f"vetoes: {[v.engine for v in vetoes]}")
    chk("V9_portfolio_capacity", open_positions < settings.max_open_positions, f"{open_positions}/{settings.max_open_positions} positions")
    chk("V10_discovery_consistency", cand.stage is None or cand.stage == stg["stage"],
        f"discovery stage {cand.stage} vs validation stage {stg['stage']}", hard=False)
    hard_fail = [c for c in checks if c["hard"] and not c["pass"]]
    passed = sum(1 for c in checks if c["pass"])
    score = round(passed / len(checks) * 100, 1)

    champions = {s.strategy_id for s in db.query(AlphaStrategyState).filter_by(asset_class=ac if ac != "token" else "crypto", status="CHAMPION").all()}
    champ_long = [s["strategy_id"] for s in lab if s["long"] and s["strategy_id"] in champions]
    decision, status = "REJECT", cand.status
    if cand.asset_class == "token":
        hard_fail.append({"id": "V0_execution_venue", "detail": "no authorized execution venue for DEX tokens; research only"})
    if f.get("sufficient") and plan.get("valid") and cand.plan and cand.plan.get("invalidation_level") and f["last"] < cand.plan["invalidation_level"]:
        decision, status = "INVALIDATED", "INVALIDATED"
    elif not hard_fail:
        high = (len(champ_long) >= 2 and early.get("coverage", 0) >= 0.6 and (early.get("score") or 0) >= 70 and plan["rr_tp2"] >= 3.0)
        decision, status = ("APPROVE_HIGH_CONVICTION", "HIGH_CONVICTION_OPPORTUNITY") if high else ("APPROVE_CONFIRMED", "CONFIRMED_OPPORTUNITY")
    else:
        only_soft_evidence = all(c["id"] in ("V7_independent_engine_agreement", "V9_portfolio_capacity") for c in hard_fail)
        decision = "DEFER" if only_soft_evidence else "REJECT"
        # A failed re-validation must never leave an earlier approval in place.
        fallback = "DEVELOPING_OPPORTUNITY" if cand.status in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY") else cand.status
        terminal = ("V1_data_fresh_and_sufficient", "V2_liquidity_and_size", "V4_safety_screen", "V8_no_engine_veto", "V0_execution_venue")
        status = fallback if decision == "DEFER" else ("REJECTED" if any(c["id"] in terminal for c in hard_fail) else fallback)
        if cand.asset_class == "token":
            status = fallback if fallback != "REJECTED" else "REJECTED"

    attribution = build_attribution(lab, champions, avail, investor_assessments or [], plan)
    result = {"candidate_id": cand.candidate_id, "decision": decision, "status": status, "validation_score": score, "checks": checks,
              "hard_failures": [c["id"] for c in hard_fail], "stage": stg["stage"], "regime": regime,
              "early_alpha": {k: early.get(k) for k in ("score", "coverage", "uncertainty", "band")},
              "plan": {k: (round(v, 8) if isinstance(v, float) else v) for k, v in plan.items()},
              "engines": [asdict(e) for e in evidences], "champion_strategies_long": champ_long, "attribution": attribution,
              "validated_at": datetime.now(timezone.utc).isoformat(), "executable": status in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY"),
              "note": "Executable means eligible to be sent to the server-side risk gateway, not an instruction to trade."}
    sub = dict(cand.scores or {})
    sub.update({"independent_validation": score, "early_alpha": early.get("score"), "risk": sub.get("risk")})
    cand.scores, cand.status, cand.stage = sub, status, stg["stage"]
    cand.overall_rank_score = overall_rank(sub)
    cand.validated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    ev = dict(cand.evidence or {})
    ev["validation"] = result
    cand.evidence = ev
    if plan.get("valid"):
        cand.plan = {**(cand.plan or {}), "invalidation_level": plan["stop"], "entry": plan["entry"], "tp": [plan["tp1"], plan["tp2"], plan["tp3"]]}
    db.commit()
    if record and result["executable"] and f.get("sufficient"):
        try:
            conf = min(0.7, 0.30 + 0.004 * score)  # uncalibrated prior; the ledger's calibration table measures it
            record_alpha_prediction(
                db, symbol=cand.symbol, asset_class=ac, price=f["last"], tp1=plan["tp1"], tp2=plan["tp2"], stop=plan["stop"], probability=conf,
                candidate_id=cand.candidate_id, stage=stg["stage"], regime=regime.get("trend"),
                reasoning=f"{decision}: stage {stg['stage']}, validation {score}, bullish engines {[b.engine for b in bulls]}; probability is an uncalibrated prior")
        except ValueError:
            logger.warning("prediction not recorded for %s", cand.candidate_id, exc_info=True)
    return result


def build_attribution(lab: list[dict[str, Any]], champions: set[str], evidences: list[EngineEvidence],
                      investor_assessments: list[dict[str, Any]], plan: dict[str, Any]) -> dict[str, Any]:
    agree = [s for s in lab if s.get("long")]
    disagree = [s for s in lab if s.get("long") is False and s.get("compatible")]
    return {
        "strategies_agreeing": [{"id": s["strategy_id"], "inspired_by": s["inspired_by"], "validated_champion": s["strategy_id"] in champions} for s in agree],
        "strategies_disagreeing": [{"id": s["strategy_id"], "inspired_by": s["inspired_by"]} for s in disagree],
        "principles_applied": sorted({LIBRARY[s["strategy_id"]].source_basis for s in agree}),
        "engines": [{"engine": e.engine, "bias": e.bias, "available": e.available, "evidence": e.evidence[:3]} for e in evidences],
        "documented_investor_transactions": [{"classification": a["classification"], "reasons": a["reasons"][:2]} for a in investor_assessments],
        "risk_controls": ["independent re-validation from raw bars", "hard-veto engine", "ATR/structure stop", "liquidity participation cap",
                          "server-side RiskEngine at order time", "paper/testnet by default"] if plan.get("valid") else ["plan invalid"],
        "disclaimer": "Strategy names show which implemented, documented principles agree. No trade is claimed to be made or copied by any named investor unless a documented transaction is cited above.",
    }

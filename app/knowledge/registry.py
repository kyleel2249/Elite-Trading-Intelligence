"""Searchable registry of documented exceptional traders & investors."""
from __future__ import annotations

from typing import Any, Optional

from app.knowledge.schema import TraderKnowledgeProfile
from app.knowledge import profiles_foundational as f
from app.knowledge import profiles_additional as a
from app.knowledge import profiles_deep as d
from app.knowledge import profiles_deep2 as d2
from app.knowledge import profiles_deep3 as d3
from app.knowledge import profiles_deep4 as d4
from app.knowledge import profiles_deep5 as d5
from app.knowledge import profiles_more as m
from app.knowledge.strategies import STRATEGY_MODULES
from app.knowledge.research_2026 import apply as apply_research


def _all_profiles() -> dict[str, TraderKnowledgeProfile]:
    out: dict[str, TraderKnowledgeProfile] = {}
    out.update(f.PROFILES)
    out.update(a.PROFILES)
    out.update(m.PROFILES)
    out.update(d.DEEP_PROFILES)
    out.update(d2.DEEP_PROFILES)
    out.update(d3.DEEP_PROFILES)
    # d4 and d5 replace the template-filler profiles with substantive, classified ones; later update wins.
    out.update(d4.DEEP_PROFILES)
    out.update(d5.DEEP_PROFILES)
    out.pop("paul_tudor_secondary_note", None)
    apply_research(out)
    return out


def list_traders() -> list[dict[str, Any]]:
    return [p.to_dict() for p in sorted(_all_profiles().values(), key=lambda x: x.full_name)]


def get_trader(trader_id: str) -> Optional[dict[str, Any]]:
    key = trader_id.lower().replace(" ", "_")
    p = _all_profiles().get(key)
    if p:
        return p.to_dict()
    for k, v in _all_profiles().items():
        if trader_id.lower() in k or trader_id.lower() in v.full_name.lower():
            return v.to_dict()
    return None


def search_traders(q: str, tag: Optional[str] = None, market: Optional[str] = None) -> list[dict[str, Any]]:
    q = (q or "").lower().strip()
    results = []
    for p in _all_profiles().values():
        blob = " ".join(
            [
                p.full_name,
                p.biography,
                p.philosophy,
                " ".join(p.tags),
                " ".join(p.markets_traded),
                " ".join(p.documented_patterns),
                " ".join(p.eti_lessons),
                p.expandable_notes or "",
            ]
        ).lower()
        if q and q not in blob:
            continue
        if tag and tag.lower() not in [t.lower() for t in p.tags]:
            continue
        if market and market.lower() not in [mkt.lower() for mkt in p.markets_traded]:
            continue
        results.append(p.to_dict())
    return sorted(results, key=lambda x: x["full_name"])


def attribution_for_decision(
    summary: str,
    specialist_evidence: list[str],
    structured_tags: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    text = (summary + " " + " ".join(specialist_evidence)).lower()
    tags = {t.lower() for t in (structured_tags or [])}

    tag_map = {
        "trend_breakout": ["turtle_trend", "darvas_box", "minervini_vcp"],
        "vcp": ["minervini_vcp"],
        "wyckoff": ["wyckoff_supply_demand"],
        "liquidity_regime": ["druck_liquidity_macro", "soros_reflexivity"],
        "structure_level": ["ptj_structure_preservation"],
        "supply_demand": ["wyckoff_supply_demand"],
        "value_quality": ["buffett_munger_value", "lynch_fundamental"],
        "contrarian_mispricing": ["burry_contrarian"],
        "quant_stat": ["simons_quant"],
        "mechanical_risk": ["seykota_mechanical"],
        "growth_momentum": ["oneil_canslim", "minervini_vcp"],
        "canslim": ["oneil_canslim"],
    }

    scores: dict[str, float] = {}
    reasons: dict[str, list[str]] = {}

    for tag, mods in tag_map.items():
        if tag in tags or tag.replace("_", " ") in text:
            for mid in mods:
                scores[mid] = scores.get(mid, 0) + 2.0
                reasons.setdefault(mid, []).append(f"structured_tag:{tag}")

    for mid, mod in STRATEGY_MODULES.items():
        for kw in mod.attribution_keywords:
            if kw.lower() in text:
                scores[mid] = scores.get(mid, 0) + 1.0
                reasons.setdefault(mid, []).append(f"keyword:{kw}")

    hits = []
    for mid, score in scores.items():
        mod = STRATEGY_MODULES.get(mid)
        if not mod:
            continue
        hits.append(
            {
                "strategy_module_id": mid,
                "name": mod.name,
                "inspired_by": mod.inspired_by,
                "match_score": score,
                "reasons": reasons.get(mid, []),
                "principles": mod.principles[:3],
                "incompatible_with": mod.incompatible_with,
                "note": "Attribution explains influence — not sole causation",
                "risk_officer": "Helena Frost",
                "strategist": "Adrian Cole",
                "auditor": "Claire Bennett",
            }
        )
    hits.sort(key=lambda x: -x["match_score"])
    return hits

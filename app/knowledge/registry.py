"""Searchable registry of documented exceptional traders & investors."""
from __future__ import annotations

from typing import Any, Optional

from app.knowledge.schema import TraderKnowledgeProfile, SourceNote
from app.knowledge import profiles_foundational as f
from app.knowledge import profiles_additional as a


def _all_profiles() -> dict[str, TraderKnowledgeProfile]:
    out: dict[str, TraderKnowledgeProfile] = {}
    out.update(f.PROFILES)
    out.update(a.PROFILES)
    return out


def list_traders() -> list[dict[str, Any]]:
    return [p.to_dict() for p in sorted(_all_profiles().values(), key=lambda x: x.full_name)]


def get_trader(trader_id: str) -> Optional[dict[str, Any]]:
    p = _all_profiles().get(trader_id.lower().replace(" ", "_"))
    if p:
        return p.to_dict()
    # fuzzy id
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
            ]
        ).lower()
        if q and q not in blob:
            continue
        if tag and tag.lower() not in [t.lower() for t in p.tags]:
            continue
        if market and market.lower() not in [m.lower() for m in p.markets_traded]:
            continue
        results.append(p.to_dict())
    return sorted(results, key=lambda x: x["full_name"])


def attribution_for_decision(summary: str, specialist_evidence: list[str]) -> list[dict[str, Any]]:
    """Map decision text to strategy modules (explainability — not causal proof)."""
    from app.knowledge.strategies import STRATEGY_MODULES

    text = (summary + " " + " ".join(specialist_evidence)).lower()
    hits = []
    for mid, mod in STRATEGY_MODULES.items():
        score = sum(1 for kw in mod.attribution_keywords if kw.lower() in text)
        if score:
            hits.append(
                {
                    "strategy_module_id": mid,
                    "name": mod.name,
                    "inspired_by": mod.inspired_by,
                    "match_score": score,
                    "principles": mod.principles[:3],
                    "note": "Attribution by keyword overlap — not a claim that this module solely drove the decision",
                }
            )
    hits.sort(key=lambda x: -x["match_score"])
    return hits

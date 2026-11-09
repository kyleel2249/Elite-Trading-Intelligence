"""Sentiment aggregation. Sentiment is evidence, never a trigger.

Items come from real providers (news, filings, social, on-chain...). This module
only scores and sanity-checks them; sources with no data are reported as
unavailable rather than silently treated as neutral.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional

RELIABILITY = {"verified": 1.0, "credible": 0.8, "unverified": 0.3, "social": 0.2}
LABELS = [(85, "extremely_bullish"), (68, "bullish"), (57, "moderately_bullish"),
          (43, "neutral"), (32, "moderately_bearish"), (15, "bearish"), (-1, "extremely_bearish")]


@dataclass
class SentimentItem:
    source: str
    verification: str            # verified | credible | unverified | social
    score: float                 # -1 (bearish) .. +1 (bullish)
    ts: datetime
    text: str = ""
    author: Optional[str] = None
    engagement: float = 0.0
    sponsored: bool = False


@dataclass
class SentimentResult:
    symbol: str
    available: bool
    score_0_100: Optional[float] = None
    label: str = "unavailable"
    bullish_pct: float = 0.0
    bearish_pct: float = 0.0
    neutral_pct: float = 0.0
    momentum: float = 0.0
    acceleration: float = 0.0
    news_intensity: int = 0
    social_attention_growth: float = 0.0
    disagreement: float = 0.0
    freshness_minutes: Optional[float] = None
    source_reliability: float = 0.0
    contrarian_flag: bool = False
    manipulation_suspected: bool = False
    flags: list[str] = field(default_factory=list)
    sources_used: list[str] = field(default_factory=list)
    sources_unavailable: list[str] = field(default_factory=list)
    can_trigger_order: bool = False   # always False by design

    def to_dict(self) -> dict:
        return asdict(self)


def _norm(t: str) -> str:
    return hashlib.sha1(re.sub(r"\W+", " ", t.lower()).strip().encode()).hexdigest()


def label_for(score: float) -> str:
    for floor, name in LABELS:
        if score >= floor:
            return name
    return "extremely_bearish"


def _wmean(pairs):
    sw = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / sw if sw > 0 else 0.0


def aggregate(symbol: str, items: list[SentimentItem], expected_sources: Optional[list[str]] = None,
              now: Optional[datetime] = None, bot_burst: int = 5) -> SentimentResult:
    now = now or datetime.now(timezone.utc)
    seen_sources = sorted({i.source for i in items})
    unavailable = sorted(set(expected_sources or []) - set(seen_sources))
    if not items:
        return SentimentResult(symbol, False, sources_unavailable=unavailable,
                               flags=["no_sentiment_data"])

    flags: list[str] = []
    # duplicates (syndicated/duplicate news, copy-paste promotion)
    hashes = Counter(_norm(i.text) for i in items if i.text)
    dup_ratio = sum(c - 1 for c in hashes.values()) / len(items)
    seen, uniq = set(), []
    for i in items:
        h = _norm(i.text) if i.text else None
        if h and h in seen:
            continue
        if h:
            seen.add(h)
        uniq.append(i)
    # bot-like authors
    per_author = Counter(i.author for i in uniq if i.author)
    bot_authors = {a for a, c in per_author.items() if c >= bot_burst}
    bot_ratio = sum(1 for i in uniq if i.author in bot_authors) / len(uniq)
    sponsored = [i for i in uniq if i.sponsored]
    if dup_ratio > 0.4:
        flags.append("duplicate_content_heavy")
    if bot_ratio > 0.3:
        flags.append("bot_like_authors")
    if sponsored:
        flags.append("paid_promotion_present")
    social_only = all(i.verification == "social" for i in uniq)
    if social_only:
        flags.append("social_only_no_verified_source")

    def weight(i: SentimentItem) -> float:
        w = RELIABILITY.get(i.verification, 0.2)
        if i.author in bot_authors:
            w *= 0.1
        if i.sponsored:
            w *= 0.1
        age_h = max(0.0, (now - i.ts).total_seconds() / 3600)
        w *= 0.5 ** (age_h / 12.0)            # 12h half-life
        w *= 1 + min(1.0, math.log1p(max(0.0, i.engagement)) / 10.0) * 0.25
        return w

    pairs = [(max(-1.0, min(1.0, i.score)), weight(i)) for i in uniq]
    mean = _wmean(pairs)
    sw = sum(w for _, w in pairs) or 1.0
    bull = sum(w for s, w in pairs if s > 0.15) / sw
    bear = sum(w for s, w in pairs if s < -0.15) / sw
    var = sum(w * (s - mean) ** 2 for s, w in pairs) / sw

    ordered = sorted(uniq, key=lambda i: i.ts)
    n = len(ordered)
    third = max(1, n // 3)
    f = lambda sl: _wmean([(max(-1, min(1, i.score)), weight(i)) for i in sl]) if sl else 0.0
    early, mid, late = f(ordered[:third]), f(ordered[third:2 * third]), f(ordered[2 * third:])
    momentum = late - early if n >= 3 else 0.0
    acceleration = (late - mid) - (mid - early) if n >= 6 else 0.0

    recent = sum(1 for i in uniq if (now - i.ts).total_seconds() <= 6 * 3600)
    prior = sum(1 for i in uniq if 6 * 3600 < (now - i.ts).total_seconds() <= 12 * 3600)
    growth = (recent - prior) / prior if prior else (float(recent) if recent else 0.0)

    score = 50 + 50 * mean
    latest = max(uniq, key=lambda i: i.ts)
    res = SentimentResult(
        symbol=symbol, available=True, score_0_100=round(score, 2), label=label_for(score),
        bullish_pct=round(bull * 100, 1), bearish_pct=round(bear * 100, 1),
        neutral_pct=round(max(0.0, 1 - bull - bear) * 100, 1),
        momentum=round(momentum, 3), acceleration=round(acceleration, 3),
        news_intensity=sum(1 for i in uniq if i.verification in ("verified", "credible")),
        social_attention_growth=round(growth, 2), disagreement=round(math.sqrt(var), 3),
        freshness_minutes=round((now - latest.ts).total_seconds() / 60, 1),
        source_reliability=round(sum(RELIABILITY.get(i.verification, 0.2) for i in uniq) / len(uniq), 3),
        contrarian_flag=(score >= 85 or score <= 15) and social_only,
        manipulation_suspected=("duplicate_content_heavy" in flags or "bot_like_authors" in flags
                                or (social_only and growth > 3 and abs(mean) > 0.6)),
        flags=flags, sources_used=seen_sources, sources_unavailable=unavailable,
    )
    if res.manipulation_suspected:
        res.flags.append("treat_as_unreliable")
    return res

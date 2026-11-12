"""News-based sentiment evidence built on the existing NewsAPI feed (app.intelligence.feeds).

Honest limits: polarity is the feed's keyword proxy (not a calibrated NLP model), and a
headline only counts as ``credible`` if its outlet is on a small allowlist; everything else
is ``unverified`` and down-weighted. If NEWSAPI_KEY is missing the result says so.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.quant.sentiment import SentimentItem, SentimentResult, aggregate

CREDIBLE_OUTLETS = {
    "reuters", "bloomberg", "the wall street journal", "financial times", "associated press",
    "cnbc", "the economist", "barron's", "marketwatch", "the new york times", "bbc news",
}


def _parse_ts(value: Optional[str]) -> datetime:
    try:
        return datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def headlines_to_items(headlines: list[dict[str, Any]]) -> list[SentimentItem]:
    items: list[SentimentItem] = []
    for h in headlines or []:
        title = (h.get("title") or "").strip()
        if not title or title.lower() == "[removed]":
            continue
        outlet = (h.get("source") or "").strip().lower()
        ts = _parse_ts(h.get("published_at"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        items.append(SentimentItem(
            source=f"newsapi:{outlet or 'unknown'}",
            verification="credible" if outlet in CREDIBLE_OUTLETS else "unverified",
            score=float(max(-1, min(1, h.get("local_polarity") or 0))),
            ts=ts, text=title))   # no author: outlets are not bot accounts
    return items


async def news_items(symbol: str, settings=None, page_size: int = 20) -> list[SentimentItem]:
    from app.intelligence.feeds import fetch_news_headlines
    feed = await fetch_news_headlines(query=symbol, page_size=page_size, settings=settings)
    return headlines_to_items(feed.get("headlines", [])) if feed.get("status") == "ok" else []


async def news_sentiment(symbol: str, settings=None, page_size: int = 20) -> SentimentResult:
    from app.intelligence.feeds import fetch_news_headlines
    feed = await fetch_news_headlines(query=symbol, page_size=page_size, settings=settings)
    if feed.get("status") != "ok":
        res = aggregate(symbol, [], expected_sources=["newsapi"])
        res.flags.append(f"newsapi_{feed.get('status', 'error')}")
        return res
    return aggregate(symbol, headlines_to_items(feed.get("headlines", [])), expected_sources=["newsapi"])

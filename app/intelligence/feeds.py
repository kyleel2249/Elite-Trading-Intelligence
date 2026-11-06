"""
Optional external feeds for Sofia Rahman (macro/FRED) and Priya Nair (news).
Graceful degradation when keys are missing — never fabricate series.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)


async def fetch_fred_series(
    series_id: str = "DFF",
    limit: int = 30,
    settings: Optional[Settings] = None,
) -> dict[str, Any]:
    """
    FRED observations for macro desk (Sofia Rahman).
    Default series DFF = Federal Funds Effective Rate.
    """
    settings = settings or get_settings()
    if not settings.fred_api_key:
        return {
            "status": "not_configured",
            "series_id": series_id,
            "message": "FRED_API_KEY not set",
            "analyst": "Sofia Rahman",
        }
    url = "https://api.stlouisfed.org/fred/series/observations"
    params = {
        "series_id": series_id,
        "api_key": settings.fred_api_key,
        "file_type": "json",
        "sort_order": "desc",
        "limit": limit,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, params=params)
            if r.status_code != 200:
                return {
                    "status": "error",
                    "series_id": series_id,
                    "http_status": r.status_code,
                    "detail": r.text[:300],
                    "analyst": "Sofia Rahman",
                }
            data = r.json()
            obs = data.get("observations") or []
            points = []
            for o in obs:
                try:
                    if o.get("value") not in (".", "", None):
                        points.append({"date": o.get("date"), "value": float(o["value"])})
                except Exception:
                    continue
            # chronological
            points = list(reversed(points))
            change = None
            if len(points) >= 2:
                change = points[-1]["value"] - points[-2]["value"]
            return {
                "status": "ok",
                "series_id": series_id,
                "points": points[-limit:],
                "latest": points[-1] if points else None,
                "change": change,
                "analyst": "Sofia Rahman",
                "source": "FRED",
            }
    except Exception as e:
        logger.warning("FRED fetch failed: %s", e)
        return {"status": "error", "series_id": series_id, "error": str(e), "analyst": "Sofia Rahman"}


async def fetch_news_headlines(
    query: str = "markets OR bitcoin OR federal reserve",
    page_size: int = 10,
    settings: Optional[Settings] = None,
) -> dict[str, Any]:
    """NewsAPI headlines for sentiment desk (Priya Nair)."""
    settings = settings or get_settings()
    if not settings.newsapi_key:
        return {
            "status": "not_configured",
            "message": "NEWSAPI_KEY not set",
            "analyst": "Priya Nair",
        }
    url = "https://newsapi.org/v2/everything"
    params = {
        "q": query,
        "pageSize": page_size,
        "sortBy": "publishedAt",
        "language": "en",
        "apiKey": settings.newsapi_key,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, params=params)
            if r.status_code != 200:
                return {
                    "status": "error",
                    "http_status": r.status_code,
                    "detail": r.text[:300],
                    "analyst": "Priya Nair",
                }
            data = r.json()
            articles = data.get("articles") or []
            # Crude polarity from title keywords
            bull_kw = ("surge", "rally", "gain", "high", "beat", "growth", "record")
            bear_kw = ("crash", "fall", "drop", "loss", "recession", "fear", "selloff", "war")
            score = 0
            headlines = []
            for a in articles:
                title = (a.get("title") or "").lower()
                h_score = 0
                if any(k in title for k in bull_kw):
                    h_score += 1
                if any(k in title for k in bear_kw):
                    h_score -= 1
                score += h_score
                headlines.append(
                    {
                        "title": a.get("title"),
                        "source": (a.get("source") or {}).get("name"),
                        "url": a.get("url"),
                        "published_at": a.get("publishedAt"),
                        "local_polarity": h_score,
                    }
                )
            n = max(len(headlines), 1)
            norm = max(-1.0, min(1.0, score / n))
            return {
                "status": "ok",
                "sentiment_score": norm,
                "headline_count": len(headlines),
                "headlines": headlines[:page_size],
                "analyst": "Priya Nair",
                "source": "NewsAPI",
                "note": "Keyword polarity proxy — not a calibrated NLP model",
            }
    except Exception as e:
        logger.warning("News fetch failed: %s", e)
        return {"status": "error", "error": str(e), "analyst": "Priya Nair"}

from datetime import datetime, timezone

from app.quant.news_sentiment import headlines_to_items
from app.quant.sentiment import aggregate


def hl(title, source, pol, ts="2026-11-08T11:00:00Z"):
    return {"title": title, "source": source, "local_polarity": pol, "published_at": ts}


def test_headlines_become_items_with_outlet_credibility():
    items = headlines_to_items([hl("Stocks rally", "Reuters", 1), hl("Rumor mill", "randomblog.biz", -1),
                                {"title": "[Removed]", "source": "x"}, {"title": "", "source": "y"}])
    assert len(items) == 2
    assert items[0].verification == "credible" and items[1].verification == "unverified"


def test_unconfigured_or_empty_feed_is_reported_as_unavailable_not_neutral():
    r = aggregate("BTC", headlines_to_items([]), expected_sources=["newsapi"])
    assert not r.available and r.sources_unavailable == ["newsapi"] and r.label == "unavailable"


def test_credible_bearish_outweighs_unverified_bullish():
    now = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)
    items = headlines_to_items([hl("Bank collapse fear", "Bloomberg", -1),
                                hl("Moon soon a", "blog1", 1), hl("Moon soon b", "blog2", 1)])
    assert aggregate("X", items, now=now).score_0_100 < 50


def test_many_headlines_from_one_outlet_are_not_treated_as_a_bot():
    items = headlines_to_items([hl(f"Reuters story {i}", "Reuters", 1) for i in range(8)])
    assert "bot_like_authors" not in aggregate("X", items).flags

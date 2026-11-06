from app.knowledge.registry import list_traders, get_trader, search_traders, attribution_for_decision
from app.knowledge.strategies import list_strategy_modules, get_strategy_module


def test_foundational_names_present():
    names = {t["full_name"] for t in list_traders()}
    for required in [
        "George Soros",
        "Stanley Druckenmiller",
        "Paul Tudor Jones",
        "Richard Dennis",
        "Ed Seykota",
        "Mark Minervini",
        "Jim Simons",
        "Warren Buffett",
        "Michael Burry",
        "Ed Thorp",
    ]:
        assert required in names


def test_get_trader_and_search():
    s = get_trader("george_soros")
    assert s is not None
    assert s["strategy_module_ids"]
    hits = search_traders("reflexivity")
    assert any(h["id"] == "george_soros" for h in hits)


def test_strategy_modules():
    mods = list_strategy_modules()
    assert len(mods) >= 10
    assert get_strategy_module("turtle_trend") is not None


def test_attribution():
    hits = attribution_for_decision("trend breakout structure", ["liquidity macro imbalance"])
    assert isinstance(hits, list)

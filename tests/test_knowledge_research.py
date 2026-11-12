"""The 2026-11-08 research overlay must stay honest: dated sources, no invented figures."""
import re

from app.knowledge import registry, research_2026


def test_every_profile_is_covered_exactly_once():
    ids = {t["id"] for t in registry.list_traders()}
    groups = [set(research_2026.NET_WORTH), set(research_2026.DECEASED), set(research_2026.NO_ESTIMATE)]
    assert set().union(*groups) == ids
    assert sum(len(g) for g in groups) == len(ids)


def test_estimates_carry_a_dated_source_and_win_rates_are_never_speculation():
    for t in registry.list_traders():
        for n in t["net_worth"]:
            assert "media estimate if any" not in n["claim"].lower()
            if n["classification"] == "estimate":
                assert re.search(r"(19|20)\d\d", n["source"] or ""), t["id"]
        for n in t["win_rates"]:
            assert n["classification"] != "speculation", t["id"]


def test_documented_win_rates_are_flagged_as_secondary_quotes():
    soros = registry.get_trader("george_soros")["win_rates"][0]
    assert soros["classification"] == "reported" and "secondary" in soros["notes"].lower()

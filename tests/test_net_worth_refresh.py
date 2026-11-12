"""Offline tests for the self-updating net-worth pipeline: parsing, safety bounds, merging and registry integration."""
import datetime as dt
import importlib.util
import json
import pathlib

import pytest

from app.knowledge import registry, research_2026

_spec = importlib.util.spec_from_file_location("refresh_net_worth", pathlib.Path(__file__).resolve().parent.parent / "scripts" / "refresh_net_worth.py")
rnw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rnw)

TODAY = dt.date(2026, 11, 15)
PAGE = '<script>{"name":"Ray Dalio","netWorth":{"value":"18894528000"}}</script>'


def test_parser_requires_the_expected_person_and_valid_json_shape():
    assert rnw.parse_net_worth(PAGE, "Dalio") == 18894528000
    assert rnw.parse_net_worth(PAGE, "Soros") is None
    assert rnw.parse_net_worth("<html>no data</html>", "Dalio") is None
    assert rnw.parse_net_worth('{"name":"Ray Dalio","netWorth":{"value":12}}', "Dalio") is None
    assert rnw.parse_net_worth('{"name":"Ray Dalio","netWorth":{"value":18894528000}}', "Dalio") == 18894528000


def test_format_and_plausibility_bounds():
    assert rnw.format_usd(162_100_000_000) == "$162.1B" and rnw.format_usd(750_000_000) == "$750M"
    assert rnw.plausible(10**9, None, TODAY)[0]
    assert not rnw.plausible(10**3, None, TODAY)[0]
    prev = {"valueUsd": 10_000_000_000, "asOf": "2026-11-08"}
    assert rnw.plausible(11_000_000_000, prev, TODAY)[0]
    assert not rnw.plausible(40_000_000_000, prev, TODAY)[0]
    assert rnw.plausible(40_000_000_000, {"valueUsd": 10_000_000_000, "asOf": "2025-01-01"}, TODAY)[0]


def test_refresh_keeps_old_entries_when_fetches_fail_and_updates_the_rest():
    existing = {"updatedAt": "2026-11-08T00:00:00Z", "entries": {"george_soros": {"valueUsd": 8_600_000_000, "display": "$8.6B", "asOf": "2026-11-08", "url": "u"}}}

    def fetch(url):
        if url.endswith("/ray-dalio/"):
            return PAGE
        raise RuntimeError("HTTP 404")

    out, report, n = rnw.refresh(existing, fetch, TODAY)
    assert n == 1 and out["entries"]["ray_dalio"]["display"] == "$18.9B" and out["entries"]["ray_dalio"]["asOf"] == "2026-11-15"
    assert out["entries"]["george_soros"]["asOf"] == "2026-11-08"  # untouched, still dated honestly
    assert any(line.startswith("SKIP") for line in report)


def test_total_failure_changes_nothing():
    existing = {"updatedAt": "2026-11-08T00:00:00Z", "entries": {}}
    out, _, n = rnw.refresh(existing, lambda u: (_ for _ in ()).throw(RuntimeError("blocked")), TODAY)
    assert n == 0 and out["updatedAt"] == "2026-11-08T00:00:00Z" and out["entries"] == {}


def test_registry_uses_live_figures_and_survives_bad_files(tmp_path, monkeypatch):
    live = tmp_path / "live.json"
    monkeypatch.setattr(research_2026, "LIVE_FILE", live)
    live.write_text(json.dumps({"updatedAt": "2026-11-15T05:17:00Z", "entries": {
        "ray_dalio": {"valueUsd": 19_100_000_000, "display": "$19.1B", "asOf": "2026-11-15", "url": "https://www.forbes.com/profile/ray-dalio/"},
        "jim_simons": {"valueUsd": 36_000_000_000, "display": "$36.0B", "asOf": "2026-11-15", "url": "https://www.forbes.com/profile/marilyn-simons/", "label": "Marilyn Simons & family"},
        "charlie_munger": {"valueUsd": 1, "display": "$1B", "asOf": "2026-11-15", "url": "x"},
        "bad": {"valueUsd": "nope"}}}))
    dalio = registry.get_trader("ray_dalio")["net_worth"]
    assert dalio[0]["claim"] == "$19.1B (real-time)" and dalio[0]["classification"] == "estimate" and "2026-11-15" in dalio[0]["source"]
    assert any("Forbes World's Billionaires" in (n["source"] or "") for n in dalio)  # dated list valuation kept
    assert not any((n["source"] or "").startswith("Forbes profile") and "2026-11-07" in n["source"] for n in dalio)
    assert "family" in registry.get_trader("jim_simons")["net_worth"][0]["claim"].lower()
    assert registry.get_trader("charlie_munger")["net_worth"][0]["claim"].startswith("Deceased")  # never overridden
    assert research_2026.freshness()["liveAsOf"] == {"ray_dalio": "2026-11-15", "jim_simons": "2026-11-15"}
    for broken in ["{not json", json.dumps([1, 2]), json.dumps({"entries": "x"})]:
        live.write_text(broken)
        assert registry.get_trader("ray_dalio")["net_worth"][0]["claim"].startswith("$18.9B")  # falls back to the researched figure
    live.unlink()
    assert research_2026.freshness()["netWorthLiveUpdatedAt"] is None

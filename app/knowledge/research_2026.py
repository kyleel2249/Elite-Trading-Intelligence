"""Dated research overlay for net-worth and win-rate notes (research pass of 2026-11-08).

Every figure here was read from the cited source on the research date; nothing is carried over from memory.
Net worths are estimates by their publisher (Forbes / Bloomberg) and move daily. Where no credible dated source
was found the note says so with classification "not_documented" instead of guessing.
"""
from __future__ import annotations

import json
import pathlib

from app.knowledge.schema import SourceNote, TraderKnowledgeProfile

RESEARCH_DATE = "2026-11-08"
# Written weekly by scripts/refresh_net_worth.py (GitHub Actions); absent until the first successful refresh.
LIVE_FILE = pathlib.Path(__file__).resolve().parent.parent.parent / "data" / "net_worth_live.json"
F400 = "Forbes 400 2026 (net worths as of 2026-09-04)"
FWB = "Forbes World's Billionaires 2026 (as of 2026-03-01)"


def _n(claim: str, cls: str, source: str, notes: str | None = None) -> SourceNote:
    return SourceNote(claim=claim, classification=cls, source=source, notes=notes)


NET_WORTH: dict[str, list[SourceNote]] = {
    "george_soros": [_n("$8.6B (#192 on the Forbes 400 2026)", "estimate", "Forbes profile forbes.com/profile/george-soros, real-time as of 2026-11-07, last updated 2026-09-15; accessed " + RESEARCH_DATE,
                        "Aggregator sites quote anywhere from $7.2B to $14B; the Forbes figure is used. Soros has donated roughly $32B to philanthropy.")],
    "stanley_druckenmiller": [
        _n("$8.9B (#185 on the Forbes 400 2026)", "estimate", "Forbes profile forbes.com/profile/stanley-druckenmiller, last updated 2026-09-15; accessed " + RESEARCH_DATE),
        _n("$12.5B", "estimate", "Bloomberg Billionaires Index profile (snapshot date not shown on the page); accessed " + RESEARCH_DATE, "Forbes and Bloomberg use different methodologies; treat as a range."),
    ],
    "ray_dalio": [
        _n("$18.9B (#62 on the Forbes 400 2026)", "estimate", "Forbes profile forbes.com/profile/ray-dalio, real-time as of 2026-11-07, last updated 2026-09-15; accessed " + RESEARCH_DATE),
        _n("$15.4B (#188)", "estimate", FWB + ", Forbes"),
    ],
    "paul_tudor_jones": [_n("$8.1B (tied #211 on the Forbes 400 2026; unchanged from 2025)", "estimate", F400 + ", as reported by CityBiz (Palm Beach list); accessed " + RESEARCH_DATE)],
    "john_paulson": [_n("$12.3B (#110 on the Forbes 400 2026)", "estimate", F400 + ", as reported by Patch (New York City list); accessed " + RESEARCH_DATE)],
    "david_tepper": [
        _n("$28.5B (#39 on the Forbes 400 2026)", "estimate", F400 + ", as reported by NJBIZ and Tucson.com; accessed " + RESEARCH_DATE),
        _n("$23.7B (#109)", "estimate", FWB + ", Forbes"),
    ],
    "steven_cohen": [
        _n("$26.7B (#43 on the Forbes 400 2026)", "estimate", F400 + ", as reported by Tucson.com; accessed " + RESEARCH_DATE),
        _n("$23B (#111)", "estimate", FWB + ", Forbes"),
    ],
    "bruce_kovner": [
        _n("$10.4B (#150 on the Forbes 400 2026)", "estimate", F400 + ", as reported by Patch; also cited in Forbes 250 (2026-10-20)"),
        _n("$8.25B", "estimate", "Bloomberg Billionaires Index profile, crawled shortly before " + RESEARCH_DATE + " (page shows no explicit date)", "Forbes and Bloomberg differ; treat as a range."),
    ],
    "david_shaw": [
        _n("$10.8B (#144 on the Forbes 400 2026)", "estimate", F400 + ", as reported by Patch; accessed " + RESEARCH_DATE),
        _n("about $14.3B", "estimate", "Bloomberg Billionaires Index list, crawled shortly before " + RESEARCH_DATE + " (page shows no explicit date)", "Forbes and Bloomberg differ materially; treat as a range."),
    ],
    "bill_ackman": [
        _n("$10.9B (#142 on the Forbes 400 2026)", "estimate", F400 + ", as reported by Patch; accessed " + RESEARCH_DATE),
        _n("$9B", "estimate", "Forbes Iconoclast 50 2026, published 2026-06-02"),
    ],
    "chris_hohn": [_n("$11.8B", "estimate", "Forbes Iconoclast 50 2026, published 2026-06-02", "Bloomberg's index lists him near $13.9B in a late-2026 snapshot; sources differ.")],
    "warren_buffett": [_n("$162.1B (#9 in the world)", "estimate", "Forbes profile forbes.com/profile/warren-buffett, real-time as of 2026-11-08, last updated 2026-10-14; accessed " + RESEARCH_DATE,
                          "Retired as Berkshire CEO at the end of 2025; remains chairman emeritus.")],
    "jim_simons": [_n("Jim Simons died on 2024-05-10. His family's fortune is listed as $36.6B ('Marilyn Simons & family', #27 on the Forbes 400 2026)", "estimate", F400 + ", as reported by Tucson.com; accessed " + RESEARCH_DATE,
                      "This is the family's wealth, not a living individual's net worth.")],
    "howard_marks": [_n("about $2.2B", "estimate", "WealthRank aggregator, November 2026 (secondary source)", "Low confidence: aggregator, not Forbes or Bloomberg. Verify before relying on it.")],
    "seth_klarman": [_n("about $1.2B", "estimate", "WealthRank aggregator, November 2026 (secondary source)", "Low confidence: aggregator, not Forbes or Bloomberg. Verify before relying on it.")],
}

DECEASED: dict[str, str] = {
    "charlie_munger": "2023-11-28", "julian_robertson": "2022-08-29", "john_templeton": "2008-07-08",
    "jesse_livermore": "1940-11-28", "richard_wyckoff": "1934-03-07", "william_oneil": "2023-11-29", "nicolas_darvas": "1977",
}

NO_ESTIMATE = [
    "ed_seykota", "ed_thorp", "richard_dennis", "william_eckhardt", "mark_minervini", "larry_williams", "linda_bradford_raschke",
    "kathy_lien", "peter_lynch", "michael_burry", "michael_steinhardt", "marty_schwartz", "tom_basso", "david_einhorn",
    "john_w_henry", "robert_mercer", "alexander_elder", "jack_schwager", "nassim_taleb", "van_tharp",
]

WIN_RATES: dict[str, list[SourceNote]] = {
    "george_soros": [_n("Reported: batting average below 50%, possibly below 30%", "reported",
                        "Quoted from Scott Bessent (a former Soros Fund Management CIO) in the 'Principles of Great Traders' compilation by G. Coyle, hosted at seykota.com; accessed " + RESEARCH_DATE,
                        "Secondary quote; the original interview was not verified. Soros's edge is reported to come from payoff asymmetry, not hit rate.")],
    "mark_minervini": [_n("Self-stated: usually right only about half the time, sometimes 60-65% in strong markets", "reported",
                          "Minervini's own statements as summarized by finermarketpoints.com (2026); accessed " + RESEARCH_DATE,
                          "Secondary summary; the primary book or interview was not verified. Not an audited statistic.")],
    "richard_dennis": [_n("Turtle-style trend systems are commonly cited at roughly 35% winners with large reward-to-risk", "estimate",
                          "journalplus.co blog citing Michael Covel's Turtle history; accessed " + RESEARCH_DATE,
                          "Secondary, unverified; this describes the Turtle system class, not a certified personal figure for Dennis.")],
    "william_eckhardt": [_n("Turtle-style trend systems are commonly cited at roughly 35% winners with large reward-to-risk", "estimate",
                            "journalplus.co blog citing Michael Covel's Turtle history; accessed " + RESEARCH_DATE,
                            "Secondary, unverified; describes the system class, not a certified personal figure.")],
}


def load_live() -> dict:
    """Read the auto-refreshed figures; any problem returns an empty result so the registry never breaks."""
    try:
        data = json.loads(LIVE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
        return {}
    good = {}
    for pid, e in data["entries"].items():
        if (isinstance(e, dict) and isinstance(e.get("valueUsd"), (int, float)) and e["valueUsd"] > 0
                and isinstance(e.get("display"), str) and isinstance(e.get("asOf"), str) and isinstance(e.get("url"), str)):
            good[pid] = e
    return {"updatedAt": data.get("updatedAt"), "entries": good}


def apply_live(profiles: dict[str, TraderKnowledgeProfile]) -> None:
    """Prepend the freshest real-time figure; older Forbes-profile notes are replaced, dated list valuations are kept."""
    for pid, e in load_live().get("entries", {}).items():
        p = profiles.get(pid)
        if p is None or pid in DECEASED:
            continue
        claim = (e["label"] + ": " if e.get("label") else "") + e["display"] + " (real-time)"
        note = _n(claim, "estimate", "Forbes profile " + e["url"] + ", real-time net worth fetched " + e["asOf"],
                  "Refreshed automatically each week; real-time estimates move daily and may lag the latest Forbes update.")
        p.net_worth = [note] + [n for n in p.net_worth if not (n.source or "").startswith("Forbes profile")]


def freshness() -> dict:
    live = load_live()
    return {"researchDate": RESEARCH_DATE, "netWorthLiveUpdatedAt": live.get("updatedAt"),
            "liveAsOf": {k: v["asOf"] for k, v in live.get("entries", {}).items() if k not in DECEASED}}


def apply(profiles: dict[str, TraderKnowledgeProfile]) -> None:
    for pid, p in profiles.items():
        if pid in NET_WORTH:
            p.net_worth = NET_WORTH[pid]
        elif pid in DECEASED:
            p.net_worth = [_n("Deceased (" + DECEASED[pid] + "); no living net-worth estimate applies", "reported", "Widely documented biographical record")]
        elif pid in NO_ESTIMATE:
            p.net_worth = [_n("No dated public net-worth estimate recorded; none found in the sources checked on " + RESEARCH_DATE, "not_documented", "Checked: Forbes 400 2026 coverage and the Bloomberg Billionaires Index",
                              "Absence of an estimate is not evidence of low wealth.")]
        if pid in WIN_RATES:
            p.win_rates = WIN_RATES[pid]
        else:
            for note in p.win_rates:
                if note.classification == "speculation":
                    note.classification = "not_documented"
                    note.source = "Research pass " + RESEARCH_DATE + ": no verified or credibly reported trader-level figure located"
    apply_live(profiles)

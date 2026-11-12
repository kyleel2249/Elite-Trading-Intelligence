#!/usr/bin/env python3
"""Refresh living-trader net worth from public Forbes profile pages and write data/net_worth_live.json.

Safety rules (this script must never make the data worse):
  * robots.txt is fetched and honoured; if it cannot be verified, nothing is fetched.
  * One request per profile, sequential, with a delay and an identifying User-Agent (weekly, low volume).
  * A value is accepted only if the page's JSON ties the number to the expected person's name, is inside absolute
    sanity bounds, and does not jump implausibly versus the previous value. Anything else is skipped and the old
    entry (with its old date) is kept.
  * The file is written only if at least one profile refreshed. Exit code 1 means nothing refreshed (alert).
Profiles marked slug_confirmed=False use a best-guess Forbes slug; a wrong slug simply 404s and is skipped.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import urllib.robotparser
from typing import Callable, Optional

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "net_worth_live.json"
UA = "ETI-research-bot/1.0 (+https://github.com/kyleel2249/Elite-Trading-Intelligence; weekly low-volume refresh)"
BASE = "https://www.forbes.com/profile/"

# id -> (forbes slug, name token that must appear in the page's name field, label, slug_confirmed)
TRACKED: dict[str, tuple[str, str, Optional[str], bool]] = {
    "george_soros": ("george-soros", "Soros", None, True),
    "stanley_druckenmiller": ("stanley-druckenmiller", "Druckenmiller", None, True),
    "ray_dalio": ("ray-dalio", "Dalio", None, True),
    "john_paulson": ("john-paulson", "Paulson", None, True),
    "warren_buffett": ("warren-buffett", "Buffett", None, True),
    "jim_simons": ("marilyn-simons", "Simons", "Marilyn Simons & family", True),
    "david_tepper": ("david-tepper", "Tepper", None, False),
    "steven_cohen": ("steve-cohen", "Cohen", None, False),
    "paul_tudor_jones": ("paul-tudor-jones-ii", "Tudor Jones", None, False),
    "bruce_kovner": ("bruce-kovner", "Kovner", None, False),
    "david_shaw": ("david-shaw", "Shaw", None, False),
    "bill_ackman": ("william-ackman", "Ackman", None, False),
}

# Matches the profile JSON, e.g. {"name":"Ray Dalio","netWorth":{"value":"18894528000"}}
NW_RE = re.compile(r'"name"\s*:\s*"([^"]+)"\s*,\s*"netWorth"\s*:\s*\{\s*"value"\s*:\s*"?(\d{6,15})(?:\.\d+)?"?')
MIN_USD, MAX_USD = 1e8, 6e11


def parse_net_worth(html: str, name_token: str) -> Optional[int]:
    """Return net worth in USD only when the JSON ties it to the expected person."""
    for m in NW_RE.finditer(html):
        if name_token.lower() in m.group(1).lower():
            return int(m.group(2))
    return None


def format_usd(v: float) -> str:
    return "$%.1fB" % (v / 1e9) if v >= 1e9 else "$%.0fM" % (v / 1e6)


def plausible(new: int, previous: Optional[dict], today: dt.date) -> tuple[bool, str]:
    if not (MIN_USD <= new <= MAX_USD):
        return False, "outside absolute bounds"
    if previous and isinstance(previous.get("valueUsd"), (int, float)) and previous["valueUsd"] > 0:
        try:
            age = (today - dt.date.fromisoformat(previous["asOf"])).days
        except Exception:
            age = 0
        ratio = new / previous["valueUsd"]
        if age <= 120 and not (0.4 <= ratio <= 2.5):
            return False, "moved %.2fx versus the previous value; needs human review" % ratio
    return True, "ok"


def refresh(existing: dict, fetch: Callable[[str], str], today: dt.date, only: Optional[str] = None, delay: float = 0.0) -> tuple[dict, list[str], int]:
    entries = dict(existing.get("entries", {}))
    report: list[str] = []
    updated = 0
    for pid, (slug, token, label, confirmed) in TRACKED.items():
        if only and pid != only:
            continue
        url = BASE + slug + "/"
        try:
            html = fetch(url)
        except Exception as exc:  # network, 404, bot wall: keep the old entry
            report.append("SKIP %s: %s%s" % (pid, exc, "" if confirmed else " (slug is a best guess)"))
            continue
        value = parse_net_worth(html, token)
        if value is None:
            report.append("SKIP %s: no net-worth JSON tied to '%s' (page format may have changed)" % (pid, token))
            continue
        ok, why = plausible(value, entries.get(pid), today)
        if not ok:
            report.append("SKIP %s: %s (%s)" % (pid, format_usd(value), why))
            continue
        entry = {"valueUsd": value, "display": format_usd(value), "asOf": today.isoformat(), "url": url}
        if label:
            entry["label"] = label
        entries[pid] = entry
        updated += 1
        report.append("OK   %s: %s" % (pid, entry["display"]))
        if delay:
            time.sleep(delay)
    out = {"updatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if updated else existing.get("updatedAt"),
           "source": "Forbes profile pages (real-time net worth), refreshed by scripts/refresh_net_worth.py", "entries": dict(sorted(entries.items()))}
    return out, report, updated


def _http_get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def robots_allows(urls: list[str]) -> tuple[bool, str]:
    try:
        text = _http_get("https://www.forbes.com/robots.txt")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True, "no robots.txt (404)"
        return False, "robots.txt unavailable (HTTP %s); cannot verify permission" % e.code
    except Exception as e:
        return False, "robots.txt unavailable (%s); cannot verify permission" % e
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(text.splitlines())
    blocked = [u for u in urls if not rp.can_fetch(UA, u)]
    return (not blocked), ("robots.txt disallows: " + ", ".join(blocked)) if blocked else "robots.txt allows"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", help="refresh a single trader id")
    ap.add_argument("--dry-run", action="store_true", help="do not write the data file")
    ap.add_argument("--delay", type=float, default=4.0, help="seconds between requests")
    args = ap.parse_args(argv)
    existing = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"updatedAt": None, "entries": {}}
    urls = [BASE + v[0] + "/" for k, v in TRACKED.items() if not args.only or k == args.only]
    ok, why = robots_allows(urls)
    print("[net-worth] " + why)
    if not ok:
        print("[net-worth] aborting without fetching; existing data kept")
        return 1
    out, report, updated = refresh(existing, _http_get, dt.date.today(), args.only, args.delay)
    print("\n".join(report))
    print("[net-worth] refreshed %d of %d profile(s)" % (updated, len(urls)))
    if updated == 0:
        return 1
    if not args.dry_run:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
        print("[net-worth] wrote %s" % OUT.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())

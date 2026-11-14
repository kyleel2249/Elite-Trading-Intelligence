"""Equity catalysts from SEC filings: 8-K events, insider open-market purchases, 13D/13G large-holder filings.

A filing is a CONFIRMED event (it is on EDGAR), unlike a rumor. What a filing means is not decided here:
only a few 8-K items are unambiguous risks (bankruptcy, delisting notice, non-reliance on financials,
obligation acceleration) and those act as a hard veto for 90 days. Everything else is attention evidence.
Insider SALES are never scored (mostly planned/noisy); only open-market PURCHASES by officers/directors are."""
from __future__ import annotations

import re
import time
from datetime import date, datetime
from typing import Any, Optional

from app.alpha.providers import _Base
from app.integrations.edgar.filings import UnsafeXml, accession_path, parse_form4

SEC_DATA = "https://data.sec.gov"
SEC_WWW = "https://www.sec.gov"
HARD_NEGATIVE_ITEMS = {"1.03": "bankruptcy or receivership", "3.01": "delisting notice or listing-rule failure",
                       "4.02": "non-reliance on previously issued financial statements", "2.04": "event accelerating a financial obligation"}
SOFT_NEGATIVE_ITEMS = {"2.06": "material impairment", "1.05": "material cybersecurity incident", "4.01": "change of certifying accountant"}
ATTENTION_ITEMS = {"1.01": "material definitive agreement", "2.01": "completion of acquisition or disposition", "2.02": "results of operations",
                   "5.01": "change in control", "5.02": "officer or director change"}
OWNERSHIP_FORMS = ("SC 13D", "SC 13G", "SCHEDULE 13D", "SCHEDULE 13G")
VETO_DAYS, EVENT_DAYS, OWNERSHIP_DAYS, FORM4_DAYS, FORM4_MAX = 90, 120, 365, 90, 12
_DOC = re.compile(r"^[\w.\-]+\.xml$")
_XSL_DOC = re.compile(r"^xsl[\w.\-]*/([\w.\-]+\.xml)$")
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
CACHE_SECONDS = 6 * 3600


def _d(s: str) -> date:
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def parse_submissions(sub: dict[str, Any], today: Optional[date] = None) -> dict[str, Any]:
    """Classify recent filings from a data.sec.gov submissions document."""
    today = today or date.today()
    rec = ((sub.get("filings") or {}).get("recent")) or {}
    n = len(rec.get("form") or [])
    col = lambda k: list(rec.get(k) or [""] * n)  # noqa: E731
    forms, dates, accs, docs, items = col("form"), col("filingDate"), col("accessionNumber"), col("primaryDocument"), col("items")
    events, hard, soft, own, f4 = [], [], [], [], []
    for i in range(n):
        try:
            age = (today - _d(dates[i])).days
        except (ValueError, TypeError):
            continue
        form = str(forms[i]).upper()
        if form.startswith("8-K") and age <= EVENT_DAYS:
            codes = [c.strip() for c in str(items[i]).split(",") if c.strip()]
            for c in codes:
                row = {"date": dates[i], "age_days": age, "item": c, "accession": accs[i], "confirmed": True, "source": "SEC 8-K"}
                if c in HARD_NEGATIVE_ITEMS and age <= VETO_DAYS:
                    hard.append({**row, "meaning": HARD_NEGATIVE_ITEMS[c]})
                elif c in SOFT_NEGATIVE_ITEMS:
                    soft.append({**row, "meaning": SOFT_NEGATIVE_ITEMS[c]})
                elif c in ATTENTION_ITEMS:
                    events.append({**row, "meaning": ATTENTION_ITEMS[c]})
        elif any(form.startswith(o) for o in OWNERSHIP_FORMS) and age <= OWNERSHIP_DAYS:
            own.append({"date": dates[i], "form": forms[i], "age_days": age, "accession": accs[i], "note": "large-holder filing exists; positions not parsed"})
        elif form == "4" and age <= FORM4_DAYS and len(f4) < FORM4_MAX:
            f4.append({"date": dates[i], "accession": accs[i], "primary_document": docs[i]})
    return {"events": events, "hard_negative": hard, "soft_negative": soft, "ownership_filings": own, "form4": f4}


def insider_summary(transactions: list[dict[str, Any]]) -> dict[str, Any]:
    buyers: dict[str, float] = {}
    sells = 0.0
    for t in transactions:
        if not t.get("open_market") or not t.get("shares") or not t.get("price"):
            continue
        roles = " ".join(t.get("roles") or []).lower()
        if "isdirector" not in roles and "isofficer" not in roles and "officer" not in roles and not any(x in roles for x in ("ceo", "cfo", "president", "chair")):
            continue  # ten-percent owners and others are not "insiders" for this signal
        value = t["shares"] * t["price"]
        if t["direction"] == "buy":
            buyers[t.get("owner") or "unknown"] = buyers.get(t.get("owner") or "unknown", 0.0) + value
        elif t["direction"] == "sell":
            sells += value
    return {"distinct_buyers": len(buyers), "purchase_value_usd": round(sum(buyers.values()), 2), "sale_value_usd": round(sells, 2),
            "note": "Only open-market purchases (code P) by officers/directors are scored; sales are reported but never scored."}


def insider_component(s: dict[str, Any]) -> Optional[float]:
    """Positive-only evidence: no purchases means 'not measured', never 'bad'."""
    if s["distinct_buyers"] >= 3 and s["purchase_value_usd"] >= 100_000:
        return 80.0
    if s["distinct_buyers"] >= 2:
        return 70.0
    if s["distinct_buyers"] == 1 and s["purchase_value_usd"] >= 25_000:
        return 60.0
    return None


class SecSubmissions(_Base):
    provider = "sec_edgar"

    def __init__(self, user_agent: str, **kw: Any):
        super().__init__(**kw)
        self.ua = user_agent

    async def submissions(self, cik: int) -> dict[str, Any]:
        return await self._get(f"{SEC_DATA}/submissions/CIK{int(cik):010d}.json", headers={"User-Agent": self.ua})

    async def form4_xml(self, cik: int, accession: str, primary_document: str) -> Optional[str]:
        m = _XSL_DOC.match(primary_document or "")  # only the XSL display prefix (xslF345X0n/) is stripped to reach the raw XML
        doc = m.group(1) if m else (primary_document or "")
        if not _DOC.match(doc):  # anything else containing a path separator or odd characters is never fetched
            return None
        path = accession_path(str(cik), accession)
        return await self._get(f"{SEC_WWW}{path}/{doc}", headers={"User-Agent": self.ua}, as_text=True)


async def load_catalysts(src: SecSubmissions, cik: int, today: Optional[date] = None, use_cache: bool = True) -> Optional[dict[str, Any]]:
    key = f"{cik}:{(today or date.today()).isoformat()}"
    hit = _CACHE.get(key)
    if use_cache and hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        parsed = parse_submissions(await src.submissions(cik), today)
    except Exception:  # noqa: BLE001 - provider status already recorded
        return None
    txs: list[dict[str, Any]] = []
    skipped = 0
    for f in parsed["form4"]:
        try:
            xml = await src.form4_xml(cik, f["accession"], f["primary_document"])
            txs.extend(parse_form4(xml) if xml else [])
        except (UnsafeXml, ValueError):
            skipped += 1
        except Exception:  # noqa: BLE001
            skipped += 1
    insider = insider_summary(txs)
    insider["form4_filings_read"] = len(parsed["form4"]) - skipped
    insider["form4_filings_skipped"] = skipped
    out = {**{k: parsed[k] for k in ("events", "hard_negative", "soft_negative", "ownership_filings")}, "insider": insider,
           "insider_component": insider_component(insider), "confirmed_source": "SEC EDGAR filings (not rumors)"}
    if use_cache:
        _CACHE[key] = (time.time(), out)
    return out

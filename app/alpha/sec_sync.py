"""Fetch and store 13F information tables from SEC EDGAR (public, read-only)."""
from __future__ import annotations

import re
from typing import Any, Optional

import httpx
from sqlalchemy.orm import Session

from app.alpha.db_models import Holding13F
from app.alpha.providers import record_status
from app.integrations.edgar.filings import accession_path, compare_13f, parse_13f_information_table, scale_13f_value

SEC = "https://www.sec.gov"
_SAFE_NAME = re.compile(r"^[\w.\-]+\.xml$")


async def _get(client: Optional[httpx.AsyncClient], url: str, ua: str, db: Session) -> httpx.Response:
    try:
        if client is not None:
            r = await client.get(url, headers={"User-Agent": ua})
        else:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.get(url, headers={"User-Agent": ua})
        r.raise_for_status()
        record_status(db, "sec_edgar", True)
        return r
    except Exception as exc:  # noqa: BLE001
        record_status(db, "sec_edgar", False, f"{type(exc).__name__}: {exc}"[:300])
        raise


async def sync_13f(db: Session, cik: str, filings: list[dict[str, Any]], filer_name: str, ua: str,
                   client: Optional[httpx.AsyncClient] = None) -> dict[str, Any]:
    """filings: [{accession, filing_date, form}] newest first (from EdgarClient.company_submissions)."""
    stored, periods = [], {}
    for f in [x for x in filings if str(x.get("form", "")).upper().startswith("13F-HR")][:2]:
        acc = f["accession"]
        base = f"{SEC}{accession_path(cik, acc)}"
        if db.query(Holding13F).filter_by(accession=acc).first():
            rows = db.query(Holding13F).filter_by(accession=acc).all()
            periods[acc] = [{"cusip": r.cusip, "issuer": r.issuer, "shares": r.shares, "put_call": r.put_call} for r in rows]
            stored.append({"accession": acc, "rows": len(rows), "cached": True})
            continue
        idx = (await _get(client, f"{base}/index.json", ua, db)).json()
        names = [i["name"] for i in (idx.get("directory") or {}).get("item", []) if str(i.get("name", "")).lower().endswith(".xml")]
        info = [n for n in names if "primary_doc" not in n.lower() and _SAFE_NAME.match(n)]
        if not info:
            stored.append({"accession": acc, "rows": 0, "error": "information table not found"})
            continue
        xml = (await _get(client, f"{base}/{info[0]}", ua, db)).text
        rows = parse_13f_information_table(xml)
        period = f.get("period_of_report")
        for r in rows:
            db.add(Holding13F(filer_cik=str(int(cik)).zfill(10), filer_name=filer_name, accession=acc, period_of_report=period,
                              filing_date=f.get("filing_date"), issuer=r["issuer"], cusip=r["cusip"], title_of_class=r["title_of_class"],
                              value_usd=scale_13f_value(r["value_raw"], period), shares=r["shares"], put_call=r["put_call"]))
        db.commit()
        periods[acc] = rows
        stored.append({"accession": acc, "rows": len(rows), "cached": False})
    accs = list(periods)
    change = compare_13f(periods[accs[1]], periods[accs[0]]) if len(accs) == 2 else None
    return {"cik": cik, "filer": filer_name, "filings": stored, "quarter_over_quarter": change,
            "warning": "13F is a delayed quarterly snapshot of certain long positions; not a current portfolio."}


def latest_holdings(db: Session, cik: str) -> list[dict[str, Any]]:
    cik10 = str(int(cik)).zfill(10)
    latest = db.query(Holding13F).filter_by(filer_cik=cik10).order_by(Holding13F.filing_date.desc()).first()
    if not latest:
        return []
    return [{"cusip": r.cusip, "issuer": r.issuer, "shares": r.shares, "value_usd": r.value_usd, "put_call": r.put_call,
             "period_of_report": r.period_of_report, "filing_date": r.filing_date}
            for r in db.query(Holding13F).filter_by(accession=latest.accession).all()]

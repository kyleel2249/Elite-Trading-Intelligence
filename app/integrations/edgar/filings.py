"""SEC filing parsers: 13F information tables and Form 4 transactions.

13F is a delayed quarterly snapshot (up to 45 days after quarter end) of
certain long positions. Form 4 is filed within two business days of the trade.
Neither is a live portfolio feed; callers must carry the delay forward.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import date, datetime
from typing import Any, Optional


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _text(el: Optional[ET.Element], path: str) -> Optional[str]:
    if el is None:
        return None
    cur = el
    for part in path.split("/"):
        nxt = None
        for ch in cur:
            if _strip_ns(ch.tag) == part:
                nxt = ch
                break
        if nxt is None:
            return None
        cur = nxt
    return (cur.text or "").strip() or None


def parse_13f_information_table(xml_text: str) -> list[dict[str, Any]]:
    """Return holdings rows. `value_usd` is normalised to dollars: filings for
    periods ending after 2022-12-31 report whole dollars; older ones report thousands
    - callers pass the already-correct scale via `value_usd` after `scale_13f_value`."""
    root = ET.fromstring(xml_text)
    rows: list[dict[str, Any]] = []
    for el in root.iter():
        if _strip_ns(el.tag) != "infoTable":
            continue
        shares = _text(el, "shrsOrPrnAmt/sshPrnamt")
        value = _text(el, "value")
        rows.append({
            "issuer": _text(el, "nameOfIssuer") or "",
            "title_of_class": _text(el, "titleOfClass"),
            "cusip": (_text(el, "cusip") or "").upper(),
            "value_raw": float(value.replace(",", "")) if value else None,
            "shares": float(shares.replace(",", "")) if shares else None,
            "share_type": _text(el, "shrsOrPrnAmt/sshPrnamtType"),
            "put_call": _text(el, "putCall"),
            "discretion": _text(el, "investmentDiscretion"),
        })
    return rows


def scale_13f_value(raw: Optional[float], period_of_report: Optional[str]) -> Optional[float]:
    """Value column was in $1,000s before the 2023 form change (periods <= 2022-12-31)."""
    if raw is None:
        return None
    try:
        d = datetime.strptime(period_of_report or "", "%Y-%m-%d").date()
    except ValueError:
        return raw  # unknown scale: caller should treat value as approximate
    return raw * 1000.0 if d <= date(2022, 12, 31) else raw


def compare_13f(prev: list[dict[str, Any]], curr: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Quarter-over-quarter change by CUSIP (long equity rows only)."""
    def agg(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for r in rows:
            if r.get("put_call") or not r.get("cusip"):
                continue
            a = out.setdefault(r["cusip"], {"issuer": r["issuer"], "shares": 0.0})
            a["shares"] += r.get("shares") or 0.0
        return out
    p, c = agg(prev), agg(curr)
    new, exited, added, trimmed = [], [], [], []
    for cusip, row in c.items():
        old = p.get(cusip)
        if old is None:
            new.append({"cusip": cusip, "issuer": row["issuer"], "shares": row["shares"]})
        elif row["shares"] > old["shares"] * 1.05:
            added.append({"cusip": cusip, "issuer": row["issuer"], "from": old["shares"], "to": row["shares"]})
        elif row["shares"] < old["shares"] * 0.95:
            trimmed.append({"cusip": cusip, "issuer": row["issuer"], "from": old["shares"], "to": row["shares"]})
    for cusip, row in p.items():
        if cusip not in c:
            exited.append({"cusip": cusip, "issuer": row["issuer"], "shares": row["shares"]})
    return {"new": new, "exited": exited, "added": added, "trimmed": trimmed}


def parse_form4(xml_text: str) -> list[dict[str, Any]]:
    """Non-derivative open-market transactions: code P=purchase, S=sale."""
    root = ET.fromstring(xml_text)
    issuer = _text(root, "issuer/issuerName")
    ticker = _text(root, "issuer/issuerTradingSymbol")
    owner = _text(root, "reportingOwner/reportingOwnerId/rptOwnerName")
    rel = root.find(".//reportingOwnerRelationship")
    roles = []
    if rel is not None:
        for ch in rel:
            if (ch.text or "").strip() in ("1", "true") and _strip_ns(ch.tag).startswith("is"):
                roles.append(_strip_ns(ch.tag))
        title = _text(rel, "officerTitle")
        if title:
            roles.append(title)
    out: list[dict[str, Any]] = []
    for el in root.iter():
        if _strip_ns(el.tag) != "nonDerivativeTransaction":
            continue
        code = _text(el, "transactionCoding/transactionCode")
        shares = _text(el, "transactionAmounts/transactionShares/value")
        price = _text(el, "transactionAmounts/transactionPricePerShare/value")
        ad = _text(el, "transactionAmounts/transactionAcquiredDisposedCode/value")
        out.append({
            "issuer": issuer, "ticker": ticker, "owner": owner, "roles": roles,
            "transaction_date": _text(el, "transactionDate/value"), "code": code,
            "direction": "buy" if code == "P" else "sell" if code == "S" else "other",
            "acquired_disposed": ad,
            "shares": float(shares) if shares else None, "price": float(price) if price else None,
            "open_market": code in ("P", "S"),
            "note": "Only codes P/S are open-market trades; A/M/F/G etc. are awards, exercises, tax or gifts.",
        })
    return out


_ACC_RE = re.compile(r"^\d{10}-\d{2}-\d{6}$")


def accession_path(cik: str, accession: str) -> str:
    """Archive folder path for an accession (validated: never built from raw input)."""
    if not _ACC_RE.match(accession or ""):
        raise ValueError("invalid accession number")
    return f"/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}"

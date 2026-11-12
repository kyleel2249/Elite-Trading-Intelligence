"""
SEC EDGAR public data adapter (read-only).
13F / company filings are HISTORICAL SNAPSHOTS — never live portfolios.
Uses SEC data.sec.gov with a descriptive User-Agent (SEC fair-access expectation).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
import hashlib

import httpx

BASE = "https://data.sec.gov"
UA = "EliteTradingIntelligence/1.0 (research; contact: eti-research@example.com)"


def _aid(*parts: str) -> str:
    return "act_" + hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


class EdgarClient:
    def __init__(self, user_agent: Optional[str] = None):
        self.user_agent = user_agent or UA

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent, "Accept": "application/json"}

    async def health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.get(f"{BASE}/submissions/CIK0000320193.json", headers=self._headers())
            if r.status_code == 200:
                return {
                    "provider": "sec_edgar",
                    "status": "ok",
                    "http_status": 200,
                    "note": "Public EDGAR; 13F = historical snapshot only",
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                }
            return {"provider": "sec_edgar", "status": "error", "http_status": r.status_code}
        except Exception as e:
            return {"provider": "sec_edgar", "status": "error", "error": str(e)}

    async def company_submissions(self, cik: str) -> dict[str, Any]:
        cik_p = str(cik).lstrip("0") or "0"
        cik_padded = cik_p.zfill(10)
        url = f"{BASE}/submissions/CIK{cik_padded}.json"
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, headers=self._headers())
        if r.status_code != 200:
            return {"status": "error", "http_status": r.status_code, "detail": r.text[:300]}
        data = r.json()
        recent = (data.get("filings") or {}).get("recent") or {}
        forms = recent.get("form") or []
        dates = recent.get("filingDate") or []
        accessions = recent.get("accessionNumber") or []
        primary = recent.get("primaryDocument") or []
        periods = recent.get("reportDate") or []
        thirteen_f = []
        for i, form in enumerate(forms):
            if str(form).upper() in ("13F-HR", "13F-HR/A", "13F-NT"):
                thirteen_f.append(
                    {
                        "form": form,
                        "filing_date": dates[i] if i < len(dates) else None,
                        "accession": accessions[i] if i < len(accessions) else None,
                        "primary_document": primary[i] if i < len(primary) else None,
                        "period_of_report": periods[i] if i < len(periods) else None,
                    }
                )
        return {
            "status": "ok",
            "cik": cik_padded,
            "name": data.get("name"),
            "tickers": data.get("tickers") or [],
            "recent_13f_filings": thirteen_f[:20],
            "disclaimer": "13F is a delayed historical snapshot of certain holdings — not a live portfolio",
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def activities_from_13f_index(self, submissions: dict[str, Any]) -> list[dict[str, Any]]:
        if submissions.get("status") != "ok":
            return []
        name = submissions.get("name") or "Unknown filer"
        acts = []
        for f in submissions.get("recent_13f_filings") or []:
            acc = f.get("accession") or ""
            acts.append(
                {
                    "activity_id": _aid("13f", str(submissions.get("cik")), acc),
                    "category": "13f_holding",
                    "investor_name": name,
                    "institution": name,
                    "ticker": None,
                    "direction": "unknown",
                    "transaction_date": None,
                    "filing_or_report_date": f.get("filing_date"),
                    "publication_date": f.get("filing_date"),
                    "amount_or_range": None,
                    "source_provider": "sec_edgar",
                    "verification_status": "HISTORICAL_SNAPSHOT",
                    "significance": "LOW",
                    "is_historical_snapshot": True,
                    "notes": [
                        "13F filing index entry only",
                        "Not a live portfolio",
                        "Holdings detail requires form XML parse (future)",
                        f"Form={f.get('form')}",
                    ],
                    "raw": f,
                }
            )
        return acts


# Public CIKs linked to elite-associated institutions (labels only)
WATCH_CIKS = {
    "0001067983": "Berkshire Hathaway",
    "0001649339": "Scion Asset Management",
}

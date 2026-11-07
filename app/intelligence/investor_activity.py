"""
Investor / disclosure intelligence layer.
- Quiver Quant: congress, contracts, lobbying, insiders (when plan allows)
- Historical elite investor profiles inform watchlist labels only
- 13F / disclosures treated as HISTORICAL SNAPSHOT — never live portfolio
Never auto-executes trades.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
import hashlib

from app.config import Settings, get_settings
from app.integrations.quiver.client import QuiverClient
from app.knowledge.registry import list_traders

# Institutions associated with documented elite investors (labels only)
INSTITUTION_WATCH = [
    {"name": "Berkshire Hathaway", "related_investors": ["Warren Buffett", "Charlie Munger"]},
    {"name": "Bridgewater Associates", "related_investors": ["Ray Dalio"]},
    {"name": "Scion Asset Management", "related_investors": ["Michael Burry"]},
    {"name": "Appaloosa Management", "related_investors": ["David Tepper"]},
    {"name": "Renaissance Technologies", "related_investors": ["Jim Simons"]},
    {"name": "Pershing Square", "related_investors": ["Bill Ackman"]},
    {"name": "Baupost Group", "related_investors": ["Seth Klarman"]},
    {"name": "Elliott Investment Management", "related_investors": []},
    {"name": "Third Point", "related_investors": []},
    {"name": "D. E. Shaw", "related_investors": ["David Shaw"]},
    {"name": "AQR Capital Management", "related_investors": ["Cliff Asness"]},
]


def _activity_id(*parts: str) -> str:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:16]
    return f"act_{h}"


def _normalize_congress_row(row: dict[str, Any]) -> dict[str, Any]:
    ticker = row.get("Ticker") or row.get("ticker") or ""
    rep = row.get("Representative") or row.get("Name") or ""
    txn = row.get("Transaction") or row.get("transaction") or ""
    txn_date = row.get("TransactionDate") or row.get("transaction_date")
    report_date = row.get("ReportDate") or row.get("report_date")
    direction = "buy" if "purchase" in str(txn).lower() or "buy" in str(txn).lower() else (
        "sell" if "sale" in str(txn).lower() or "sell" in str(txn).lower() else "unknown"
    )
    return {
        "activity_id": _activity_id("congress", rep, ticker, str(txn_date), str(txn)),
        "category": "congressional_trade",
        "investor_name": rep,
        "institution": "US Congress",
        "ticker": ticker,
        "direction": direction,
        "transaction_raw": txn,
        "transaction_date": txn_date,
        "filing_or_report_date": report_date,
        "publication_date": report_date,
        "retrieval_timestamp": datetime.now(timezone.utc).isoformat(),
        "amount_or_range": row.get("Range") or row.get("Amount"),
        "source_provider": "quiver_quant",
        "verification_status": "CREDIBLE_SECONDARY_SOURCE",
        "significance": "MODERATE",
        "notes": [
            "Disclosure dates ≠ transaction dates",
            "Reporting delays common",
            "Not automatic trade signal",
        ],
        "raw": row,
    }


class InvestorActivityEngine:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.quiver = QuiverClient(self.settings)

    def watchlist_summary(self) -> dict[str, Any]:
        traders = list_traders()
        return {
            "elite_profiles_count": len(traders),
            "elite_names": [t.get("full_name") for t in traders][:40],
            "institutions_monitored": INSTITUTION_WATCH,
            "note": "Profile watchlist is research context; live activity requires filings/Quiver",
            "desk": {"strategist": "Adrian Cole", "auditor": "Claire Bennett", "risk": "Helena Frost"},
        }

    async def scan_congress(self) -> dict[str, Any]:
        res = await self.quiver.congress_trading_live()
        if res.get("status") != "ok":
            return {
                "status": res.get("status"),
                "activities": [],
                "detail": res.get("detail") or res.get("message"),
                "source": "quiver_quant",
            }
        data = res.get("data") or []
        if not isinstance(data, list):
            data = []
        activities = [_normalize_congress_row(r) for r in data[:100] if isinstance(r, dict)]
        return {
            "status": "ok",
            "count": len(activities),
            "activities": activities,
            "source": "quiver_quant",
            "retrieved_at": res.get("retrieved_at"),
            "disclaimer": "Supporting intelligence only — Helena Frost still gates all orders",
        }

    async def scan_contracts(self) -> dict[str, Any]:
        res = await self.quiver.government_contracts_live()
        if res.get("status") != "ok":
            return {"status": res.get("status"), "activities": [], "detail": res.get("detail")}
        data = res.get("data") or []
        acts = []
        if isinstance(data, list):
            for r in data[:50]:
                if not isinstance(r, dict):
                    continue
                ticker = r.get("Ticker") or r.get("ticker") or ""
                acts.append(
                    {
                        "activity_id": _activity_id("gov", ticker, str(r.get("Date") or r.get("date")), str(r.get("Amount"))),
                        "category": "government_contract",
                        "ticker": ticker,
                        "retrieval_timestamp": datetime.now(timezone.utc).isoformat(),
                        "source_provider": "quiver_quant",
                        "verification_status": "CREDIBLE_SECONDARY_SOURCE",
                        "significance": "INFORMATIONAL",
                        "notes": ["Contract award ≠ guaranteed stock appreciation"],
                        "raw": r,
                    }
                )
        return {"status": "ok", "count": len(acts), "activities": acts}

    async def scan_lobbying(self) -> dict[str, Any]:
        res = await self.quiver.lobbying_live()
        if res.get("status") != "ok":
            return {"status": res.get("status"), "activities": [], "detail": res.get("detail")}
        data = res.get("data") or []
        acts = []
        if isinstance(data, list):
            for r in data[:50]:
                if not isinstance(r, dict):
                    continue
                acts.append(
                    {
                        "activity_id": _activity_id("lobby", str(r.get("Ticker")), str(r.get("Date")), str(r.get("Amount"))),
                        "category": "lobbying",
                        "ticker": r.get("Ticker") or "",
                        "retrieval_timestamp": datetime.now(timezone.utc).isoformat(),
                        "source_provider": "quiver_quant",
                        "verification_status": "CREDIBLE_SECONDARY_SOURCE",
                        "significance": "INFORMATIONAL",
                        "notes": ["Lobbying disclosure is not a directional price signal"],
                        "raw": r,
                    }
                )
        return {"status": "ok", "count": len(acts), "activities": acts}

    async def ticker_context(self, ticker: str) -> dict[str, Any]:
        """Cross-source research context for a ticker — never an order."""
        t = ticker.upper()
        congress = await self.quiver.congress_trading_ticker(t)
        lobbying = await self.quiver.lobbying_ticker(t)
        insiders = await self.quiver.insiders_ticker(t)
        return {
            "ticker": t,
            "congress": {"status": congress.get("status"), "rows": len(congress.get("data") or []) if isinstance(congress.get("data"), list) else 0},
            "lobbying": {"status": lobbying.get("status")},
            "insiders": {"status": insiders.get("status"), "note": "May require Trader plan"},
            "thirteen_f_rule": "13F is a delayed historical snapshot — never treat as live portfolio",
            "execution_rule": "Quiver data cannot independently trigger orders; Helena Frost risk path required",
            "council": {"strategist": "Adrian Cole", "risk_officer": "Helena Frost", "auditor": "Claire Bennett"},
        }

    async def full_scan(self) -> dict[str, Any]:
        congress = await self.scan_congress()
        contracts = await self.scan_contracts()
        lobbying = await self.scan_lobbying()
        return {
            "watchlist": self.watchlist_summary(),
            "congress": congress,
            "government_contracts": contracts,
            "lobbying": lobbying,
            "scanned_at": datetime.now(timezone.utc).isoformat(),
            "auto_trade": False,
        }

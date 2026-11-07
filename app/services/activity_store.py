"""Persist investor activities and intelligence alerts (idempotent by activity_id)."""
from __future__ import annotations

from typing import Any, Optional
import hashlib

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import InvestorActivity, IntelligenceAlert
from app.intelligence.significance import score_significance


def _alert_id(activity_id: str) -> str:
    return "alert_" + hashlib.sha256(activity_id.encode()).hexdigest()[:16]


class ActivityStore:
    def __init__(self, db: Session):
        self.db = db

    def upsert_activity(self, act: dict[str, Any]) -> tuple[InvestorActivity, bool]:
        """Returns (row, created_new)."""
        aid = act.get("activity_id")
        if not aid:
            raise ValueError("activity_id required")
        existing = self.db.query(InvestorActivity).filter(InvestorActivity.activity_id == aid).first()
        sig = act.get("significance") or score_significance(act)
        if existing:
            existing.significance = sig
            existing.verification_status = act.get("verification_status") or existing.verification_status
            existing.payload = act.get("raw") or act.get("payload") or existing.payload
            existing.notes = act.get("notes") or existing.notes
            self.db.commit()
            return existing, False

        row = InvestorActivity(
            activity_id=aid,
            category=act.get("category") or "unknown",
            investor_name=act.get("investor_name"),
            institution=act.get("institution"),
            ticker=(act.get("ticker") or "")[:32] or None,
            direction=act.get("direction"),
            transaction_date=str(act.get("transaction_date") or "")[:64] or None,
            filing_or_report_date=str(act.get("filing_or_report_date") or "")[:64] or None,
            publication_date=str(act.get("publication_date") or "")[:64] or None,
            amount_or_range=str(act.get("amount_or_range") or "")[:128] or None,
            source_provider=act.get("source_provider") or "unknown",
            verification_status=act.get("verification_status") or "UNCONFIRMED",
            significance=sig,
            confidence=float(act.get("confidence") or 0.5),
            notes=act.get("notes"),
            payload=act.get("raw") or act.get("payload"),
            is_historical_snapshot=bool(act.get("is_historical_snapshot")),
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row, True

    def maybe_alert(self, row: InvestorActivity, created_new: bool) -> Optional[IntelligenceAlert]:
        if not created_new:
            return None
        if row.significance not in ("CRITICAL", "HIGH", "MODERATE"):
            return None
        if row.verification_status in ("UNCONFIRMED", "INSUFFICIENT_INFORMATION", "DISPUTED"):
            return None
        aid = _alert_id(row.activity_id)
        if self.db.query(IntelligenceAlert).filter(IntelligenceAlert.alert_id == aid).first():
            return None
        title = f"{row.category}: {row.investor_name or row.institution or 'Unknown'} / {row.ticker or 'N/A'}"
        alert = IntelligenceAlert(
            alert_id=aid,
            activity_id=row.activity_id,
            title=title[:512],
            severity=row.significance,
            ticker=row.ticker,
            investor_name=row.investor_name,
            category=row.category,
            summary=(
                f"Direction={row.direction}; txn={row.transaction_date}; "
                f"report={row.filing_or_report_date}; source={row.source_provider}. "
                f"Research only — not an automatic trade. Helena Frost still gates orders."
            ),
            recommended_action="RESEARCH",
            source_provider=row.source_provider,
            verification_status=row.verification_status,
            payload={"notes": row.notes},
        )
        self.db.add(alert)
        self.db.commit()
        self.db.refresh(alert)
        return alert

    def ingest_many(self, activities: list[dict[str, Any]]) -> dict[str, Any]:
        created = 0
        updated = 0
        alerts = 0
        for act in activities:
            try:
                row, is_new = self.upsert_activity(act)
                if is_new:
                    created += 1
                    if self.maybe_alert(row, True):
                        alerts += 1
                else:
                    updated += 1
            except Exception:
                continue
        return {"created": created, "updated": updated, "alerts_created": alerts}

    def list_activities(
        self,
        limit: int = 50,
        ticker: Optional[str] = None,
        category: Optional[str] = None,
        significance: Optional[str] = None,
        q: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        query = self.db.query(InvestorActivity).order_by(InvestorActivity.created_at.desc())
        if ticker:
            query = query.filter(InvestorActivity.ticker == ticker.upper())
        if category:
            query = query.filter(InvestorActivity.category == category)
        if significance:
            query = query.filter(InvestorActivity.significance == significance)
        if q:
            term = q.strip()
            if term:
                like = f"%{term}%"
                query = query.filter(
                    or_(
                        InvestorActivity.ticker.ilike(like),
                        InvestorActivity.investor_name.ilike(like),
                        InvestorActivity.institution.ilike(like),
                    )
                )
        rows = query.limit(min(limit, 200)).all()
        return [self._act_dict(r) for r in rows]

    def search(
        self,
        q: str,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Search activities + alerts by ticker or person/institution name."""
        term = (q or "").strip()
        if not term:
            return {"query": q, "activities": [], "alerts": [], "count": 0}

        like = f"%{term}%"
        acts = (
            self.db.query(InvestorActivity)
            .filter(
                or_(
                    InvestorActivity.ticker.ilike(like),
                    InvestorActivity.investor_name.ilike(like),
                    InvestorActivity.institution.ilike(like),
                )
            )
            .order_by(InvestorActivity.created_at.desc())
            .limit(min(limit, 200))
            .all()
        )
        alerts = (
            self.db.query(IntelligenceAlert)
            .filter(
                or_(
                    IntelligenceAlert.ticker.ilike(like),
                    IntelligenceAlert.investor_name.ilike(like),
                    IntelligenceAlert.title.ilike(like),
                )
            )
            .order_by(IntelligenceAlert.created_at.desc())
            .limit(min(limit, 100))
            .all()
        )
        act_list = [self._act_dict(r) for r in acts]
        alert_list = [
            {
                "alert_id": a.alert_id,
                "activity_id": a.activity_id,
                "title": a.title,
                "severity": a.severity,
                "ticker": a.ticker,
                "investor_name": a.investor_name,
                "category": a.category,
                "summary": a.summary,
                "recommended_action": a.recommended_action,
                "source_provider": a.source_provider,
                "verification_status": a.verification_status,
                "acknowledged": a.acknowledged,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in alerts
        ]
        return {
            "query": term,
            "activities": act_list,
            "alerts": alert_list,
            "count": len(act_list) + len(alert_list),
            "activities_count": len(act_list),
            "alerts_count": len(alert_list),
        }

    def list_alerts(
        self,
        limit: int = 50,
        unacked_only: bool = False,
        q: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        query = self.db.query(IntelligenceAlert).order_by(IntelligenceAlert.created_at.desc())
        if unacked_only:
            query = query.filter(IntelligenceAlert.acknowledged.is_(False))
        if q:
            term = q.strip()
            if term:
                like = f"%{term}%"
                query = query.filter(
                    or_(
                        IntelligenceAlert.ticker.ilike(like),
                        IntelligenceAlert.investor_name.ilike(like),
                        IntelligenceAlert.title.ilike(like),
                    )
                )
        rows = query.limit(min(limit, 200)).all()
        return [
            {
                "alert_id": a.alert_id,
                "activity_id": a.activity_id,
                "title": a.title,
                "severity": a.severity,
                "ticker": a.ticker,
                "investor_name": a.investor_name,
                "category": a.category,
                "summary": a.summary,
                "recommended_action": a.recommended_action,
                "source_provider": a.source_provider,
                "verification_status": a.verification_status,
                "acknowledged": a.acknowledged,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in rows
        ]

    def acknowledge_alert(self, alert_id: str) -> bool:
        row = self.db.query(IntelligenceAlert).filter(IntelligenceAlert.alert_id == alert_id).first()
        if not row:
            return False
        row.acknowledged = True
        self.db.commit()
        return True

    @staticmethod
    def _act_dict(r: InvestorActivity) -> dict[str, Any]:
        return {
            "activity_id": r.activity_id,
            "category": r.category,
            "investor_name": r.investor_name,
            "institution": r.institution,
            "ticker": r.ticker,
            "direction": r.direction,
            "transaction_date": r.transaction_date,
            "filing_or_report_date": r.filing_or_report_date,
            "publication_date": r.publication_date,
            "amount_or_range": r.amount_or_range,
            "source_provider": r.source_provider,
            "verification_status": r.verification_status,
            "significance": r.significance,
            "confidence": r.confidence,
            "notes": r.notes,
            "is_historical_snapshot": r.is_historical_snapshot,
            "retrieved_at": r.retrieved_at.isoformat() if r.retrieved_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }

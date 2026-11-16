"""Rule-based fraud detection for outgoing value transfers and for account-takeover signals.

Each rule adds to a score; >= REVIEW_AT demands one extra approval signature, >= BLOCK_AT refuses the transfer outright.
Every review/block is stored as an alert for an analyst to resolve. Rules are deterministic and explainable (no model to
poison): new destination, velocity, repeat payment, amount anomaly vs. the median of recent sends, many distinct payees in
an hour (probing/dusting), authentication-failure bursts, a just-activated allowlist entry, and outside-hours activity.
Tunables (env): GOV_FRAUD_VELOCITY_MAX (5/h), GOV_FRAUD_ANOMALY_X (5), GOV_FRAUD_HOURS_UTC ("" or "7-19").
"""
from __future__ import annotations

import json
import os
import statistics
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chain.models import ChainTransaction
from app.governance import allowlist, audit
from app.governance.models import GovAudit, GovFraudAlert, now

REVIEW_AT, BLOCK_AT = 50, 100


@dataclass
class Verdict:
    score: int = 0
    level: str = "clear"                       # clear | review | block
    rules: list[dict] = field(default_factory=list)

    def add(self, rule: str, points: int, why: str) -> None:
        self.score += points
        self.rules.append({"rule": rule, "points": points, "why": why})

    def finish(self) -> "Verdict":
        self.level = "block" if self.score >= BLOCK_AT else "review" if self.score >= REVIEW_AT else "clear"
        return self

    def as_dict(self) -> dict:
        return {"score": self.score, "level": self.level, "rules": self.rules}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _recent(db: Session, network: str, since) -> list[ChainTransaction]:
    return list(db.execute(select(ChainTransaction).where(ChainTransaction.network == network, ChainTransaction.created_at >= since,
                                                          ChainTransaction.status.in_(["signed", "pending", "confirmed"]))).scalars())


def auth_failures(db: Session, minutes: int = 15) -> int:
    cut = (now() - timedelta(minutes=minutes)).isoformat()
    rows = db.execute(select(GovAudit.action).where(GovAudit.ts >= cut, GovAudit.action.in_(["auth.failed", "mfa.failed", "authz.mfa_denied"]))).all()
    return len(rows)


def evaluate_transfer(db: Session, *, network: str, to: str, notional: int, kind: str = "transfer", actor: str = "system") -> Verdict:
    v = Verdict()
    hour_ago, day_ago = now() - timedelta(hours=1), now() - timedelta(days=1)
    if kind == "transfer":
        entry = allowlist.lookup(db, network, to)
        if entry is None:
            v.add("new_destination", 60, "destination has never been approved on the withdrawal allowlist")
        elif entry.activates_at and now() - entry.activates_at < timedelta(hours=24):
            v.add("fresh_allowlist_entry", 20, "destination became usable less than 24 hours ago")
    hour = _recent(db, network, hour_ago)
    cap = _int("GOV_FRAUD_VELOCITY_MAX", 5)
    if len(hour) >= cap:
        v.add("velocity", 50, f"{len(hour)} transfers in the last hour (limit {cap})")
    if any(r.to_address.lower() == to.lower() and abs(int(r.notional_wei) - notional) <= notional // 100 and
           now() - r.created_at < timedelta(minutes=10) for r in hour):
        v.add("rapid_repeat", 30, "same destination and amount within 10 minutes")
    if len({r.to_address.lower() for r in hour}) >= 4 and to.lower() not in {r.to_address.lower() for r in hour}:
        v.add("many_payees", 40, "4 or more different destinations in the last hour (probing/dusting pattern)")
    sample = [int(r.notional_wei) for r in _recent(db, network, now() - timedelta(days=30)) if int(r.notional_wei) > 0]
    mult = _int("GOV_FRAUD_ANOMALY_X", 5)
    if len(sample) >= 5 and notional > mult * statistics.median(sample):
        v.add("amount_anomaly", 50, f"amount is more than {mult}x the median of the last {len(sample)} transfers")
    n_fail = auth_failures(db)
    if n_fail >= 5:
        v.add("auth_failure_burst", 40, f"{n_fail} failed authentication/MFA attempts in the last 15 minutes")
    window = (os.getenv("GOV_FRAUD_HOURS_UTC") or "").strip()
    if "-" in window:
        try:
            a, b = (int(x) for x in window.split("-", 1))
            if not (a <= now().hour < b):
                v.add("off_hours", 20, f"outside the permitted {window} UTC window")
        except ValueError:
            pass
    return v.finish()


def record(db: Session, v: Verdict, actor: str, subject: str) -> Optional[GovFraudAlert]:
    if v.level == "clear":
        return None
    a = GovFraudAlert(verdict=v.level, score=v.score, actor=actor[:64], subject=subject[:128], rules=json.dumps(v.rules))
    db.add(a)
    db.commit()
    audit.append(db, actor, f"fraud.{v.level}", subject, {"score": v.score, "rules": [r["rule"] for r in v.rules], "alert_id": a.id})
    return a


def scan_accounts(db: Session) -> list[dict]:
    """Account-takeover sweep over the audit log: failure bursts, lockouts, recovery-code use and repeated authorization denials."""
    out = []
    if auth_failures(db) >= 5:
        out.append({"signal": "auth_failure_burst", "severity": "high", "detail": "5+ failed authentications in 15 minutes"})
    cut = (now() - timedelta(hours=24)).isoformat()
    for action, sev in (("mfa.locked", "high"), ("mfa.recovery_used", "medium"), ("authz.denied", "medium"), ("approval.mismatch", "high")):
        n = len(db.execute(select(GovAudit.seq).where(GovAudit.action == action, GovAudit.ts >= cut)).all())
        if n:
            out.append({"signal": action, "severity": sev, "detail": f"{n} in the last 24h"})
    return out


def resolve_alert(db: Session, alert_id: int, by: str, resolution: str) -> GovFraudAlert:
    a = db.get(GovFraudAlert, alert_id)
    if a is None:
        raise KeyError("alert not found")
    a.status, a.resolved_by, a.resolution = "resolved", by, resolution[:240]
    db.commit()
    audit.append(db, by, "fraud.resolved", str(a.id), {"resolution": resolution[:240]})
    return a


def alerts(db: Session, status: Optional[str] = None, limit: int = 100) -> list[dict]:
    q = select(GovFraudAlert).order_by(GovFraudAlert.id.desc()).limit(max(1, min(limit, 500)))
    if status:
        q = q.where(GovFraudAlert.status == status)
    return [{"id": a.id, "created_at": a.created_at.isoformat(), "verdict": a.verdict, "score": a.score, "actor": a.actor, "subject": a.subject,
             "rules": json.loads(a.rules), "status": a.status, "resolved_by": a.resolved_by, "resolution": a.resolution}
            for a in db.execute(q).scalars()]

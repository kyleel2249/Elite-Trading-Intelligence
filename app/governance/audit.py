"""Tamper-evident audit log.

Each row's hash = HMAC(audit_key, seq | ts | actor | action | subject | detail | prev_hash | kid). Rows can only be inserted
(ORM guards + DB triggers), the sequence number is the primary key so concurrent writers cannot fork the chain, and
`verify` re-derives every hash so any edit, deletion, reordering or truncation-from-the-middle is reported with the first
broken sequence number. `head()` can be copied to an external system (pager, WORM bucket, ticket) to also catch tail
truncation. Details are scrubbed of credential-looking fields before they are written.
"""
from __future__ import annotations

import hmac
import json
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.execution.vault import scrub
from app.governance import keys
from app.governance.models import GovAudit

GENESIS = "0" * 64


def canon(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def _digest(key: bytes, seq: int, ts: str, actor: str, action: str, subject: str, detail: str, prev: str, key_id: str) -> str:
    body = "\x1f".join([str(seq), ts, actor, action, subject, detail, prev, key_id])
    return hmac.new(key, body.encode(), "sha256").hexdigest()


def append(db: Session, actor: str, action: str, subject: str = "", detail: Optional[dict] = None, *, commit: bool = True) -> GovAudit:
    clean = canon(scrub(detail or {}))[:8000]
    for _ in range(6):
        last = db.execute(select(GovAudit).order_by(GovAudit.seq.desc()).limit(1)).scalar_one_or_none()
        seq = (last.seq if last else 0) + 1
        prev = last.hash if last else GENESIS
        ts = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        key_id = keys.kid()
        row = GovAudit(seq=seq, ts=ts, actor=actor[:64], action=action[:64], subject=subject[:128], detail=clean, prev_hash=prev,
                       hash=_digest(keys.derive("audit"), seq, ts, actor[:64], action[:64], subject[:128], clean, prev, key_id), kid=key_id)
        db.add(row)
        try:
            db.flush()
        except IntegrityError:          # another writer took this sequence number: retry on the new head
            db.rollback()
            continue
        if commit:
            db.commit()
        return row
    raise RuntimeError("audit append failed after repeated sequence conflicts")


def verify_rows(rows: list[dict]) -> dict:
    """Verify an ordered list of audit rows (dicts). Used for the live table and for backups before restore."""
    prev, expect = GENESIS, None
    for r in rows:
        seq = int(r["seq"])
        if expect is not None and seq != expect:
            return {"ok": False, "rows": len(rows), "broken_at": seq, "reason": f"sequence gap: expected {expect}, found {seq}"}
        expect = seq + 1
        key = keys.derive_for_kid("audit", r["kid"])
        if key is None:
            return {"ok": False, "rows": len(rows), "broken_at": seq, "reason": f"no key available for kid {r['kid']}"}
        if r["prev_hash"] != prev:
            return {"ok": False, "rows": len(rows), "broken_at": seq, "reason": "prev_hash does not match the preceding row"}
        want = _digest(key, seq, r["ts"], r["actor"], r["action"], r["subject"], r["detail"], r["prev_hash"], r["kid"])
        if not hmac.compare_digest(want, r["hash"]):
            return {"ok": False, "rows": len(rows), "broken_at": seq, "reason": "row content does not match its hash"}
        prev = r["hash"]
    return {"ok": True, "rows": len(rows), "head": prev, "broken_at": None, "reason": None}


def as_dict(r: GovAudit) -> dict:
    return {"seq": r.seq, "ts": r.ts, "actor": r.actor, "action": r.action, "subject": r.subject, "detail": r.detail,
            "prev_hash": r.prev_hash, "hash": r.hash, "kid": r.kid}


def all_rows(db: Session) -> list[dict]:
    return [as_dict(r) for r in db.execute(select(GovAudit).order_by(GovAudit.seq)).scalars()]


def verify(db: Session) -> dict:
    return verify_rows(all_rows(db))


def head(db: Session) -> dict:
    last = db.execute(select(GovAudit).order_by(GovAudit.seq.desc()).limit(1)).scalar_one_or_none()
    return {"seq": last.seq if last else 0, "hash": last.hash if last else GENESIS, "ts": last.ts if last else None}


def recent(db: Session, limit: int = 100, action: Optional[str] = None, actor: Optional[str] = None) -> list[dict]:
    q = select(GovAudit).order_by(GovAudit.seq.desc()).limit(max(1, min(limit, 1000)))
    if action:
        q = q.where(GovAudit.action == action)
    if actor:
        q = q.where(GovAudit.actor == actor)
    out = []
    for r in db.execute(q).scalars():
        d = as_dict(r)
        d["detail"] = json.loads(d["detail"] or "{}")
        out.append(d)
    return out

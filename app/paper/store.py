"""Persistence for paper accounts. One JSON aggregate per account (+ append-only event log), versioned.

InMemoryPaperStore round-trips through JSON exactly like the SQL store, so restart behaviour is testable.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Optional


class VersionConflict(Exception):
    pass


class InMemoryPaperStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._accounts: dict = {}      # id -> (version, json string)
        self._events: list = []

    def load(self, account_id: str) -> Optional[tuple]:
        with self._lock:
            v = self._accounts.get(account_id)
            return (v[0], json.loads(v[1])) if v else None

    def save(self, account_id: str, state: dict, expected_version: int) -> int:
        with self._lock:
            cur = self._accounts.get(account_id)
            if (cur[0] if cur else 0) != expected_version:
                raise VersionConflict(account_id)
            new = expected_version + 1
            state = dict(state, version=new)
            self._accounts[account_id] = (new, json.dumps(state))
            return new

    def list_accounts(self) -> list:
        with self._lock:
            return sorted(self._accounts)

    def append_events(self, events: list) -> None:
        with self._lock:
            self._events.extend(json.loads(json.dumps(e)) for e in events)

    def list_events(self, account_id: str, limit: int = 200, event: Optional[str] = None) -> list:
        with self._lock:
            rows = [e for e in self._events if e["account_id"] == account_id and (event is None or e["event"] == event)]
            return list(reversed(rows))[:limit]


# ---------------------------------------------------------------------------------------------- SQL
class SqlPaperStore:
    """SQLAlchemy implementation. Tables are declared in app.paper.models (imported by init_db)."""

    def __init__(self, session_factory):
        self._sf = session_factory

    def load(self, account_id: str) -> Optional[tuple]:
        from .models import PaperAccountRow
        with self._sf() as db:
            row = db.get(PaperAccountRow, account_id)
            return (row.version, row.state) if row else None

    def save(self, account_id: str, state: dict, expected_version: int) -> int:
        from sqlalchemy import update
        from sqlalchemy.exc import IntegrityError
        from .models import PaperAccountRow
        new = expected_version + 1
        state = json.loads(json.dumps(dict(state, version=new)))
        now = datetime.now(timezone.utc)
        with self._sf() as db:
            if expected_version == 0:
                db.add(PaperAccountRow(account_id=account_id, version=new, state=state, updated_at=now))
                try:
                    db.commit()
                except IntegrityError:
                    db.rollback()
                    raise VersionConflict(account_id)
                return new
            res = db.execute(update(PaperAccountRow)
                             .where(PaperAccountRow.account_id == account_id, PaperAccountRow.version == expected_version)
                             .values(version=new, state=state, updated_at=now))
            db.commit()
            if res.rowcount != 1:
                raise VersionConflict(account_id)
            return new

    def list_accounts(self) -> list:
        from .models import PaperAccountRow
        with self._sf() as db:
            return [r[0] for r in db.query(PaperAccountRow.account_id).order_by(PaperAccountRow.account_id).all()]

    def append_events(self, events: list) -> None:
        if not events:
            return
        from .models import PaperEventRow
        with self._sf() as db:
            for e in events:
                ts = datetime.fromisoformat(e["ts"]) if e.get("ts") else datetime.now(timezone.utc)
                db.add(PaperEventRow(ts=ts, account_id=e["account_id"], event=e["event"], order_id=e.get("order_id"),
                                     details=json.loads(json.dumps(e.get("details") or {}, default=str))))
            db.commit()

    def list_events(self, account_id: str, limit: int = 200, event: Optional[str] = None) -> list:
        from .models import PaperEventRow
        with self._sf() as db:
            q = db.query(PaperEventRow).filter(PaperEventRow.account_id == account_id)
            if event:
                q = q.filter(PaperEventRow.event == event)
            return [{"ts": (r.ts.replace(tzinfo=timezone.utc) if r.ts.tzinfo is None else r.ts).isoformat(),
                     "account_id": r.account_id, "event": r.event, "order_id": r.order_id, "details": r.details}
                    for r in q.order_by(PaperEventRow.id.desc()).limit(limit).all()]


# File-backed/in-memory stores used by the paper exchange (PaperExchange) live in exchange_store.py; re-exported for existing imports.
from app.paper.exchange_store import JsonFileStore, MemoryStore, PaperStore, StaleStateError  # noqa: E402,F401

"""Persistence contract for paper accounts, with optimistic concurrency, plus in-memory and JSON-file stores."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional, Protocol


class StaleStateError(Exception):
    """Another writer saved this account since it was loaded."""


class PaperStore(Protocol):
    def load(self, account_id: str) -> tuple[Optional[dict], int]: ...
    def save(self, account_id: str, state: dict, audit: list[dict], expected_version: int) -> int: ...
    def audit(self, account_id: str, limit: int = 200) -> list[dict]: ...


class MemoryStore:
    def __init__(self) -> None:
        self._state: dict[str, tuple[dict, int]] = {}
        self._audit: dict[str, list[dict]] = {}
        self._lock = threading.Lock()

    def load(self, account_id):
        with self._lock:
            s = self._state.get(account_id)
            return (json.loads(json.dumps(s[0])), s[1]) if s else (None, 0)

    def save(self, account_id, state, audit, expected_version):
        with self._lock:
            cur = self._state.get(account_id, (None, 0))[1]
            if cur != expected_version:
                raise StaleStateError(account_id)
            self._state[account_id] = (json.loads(json.dumps(state)), cur + 1)
            self._audit.setdefault(account_id, []).extend(json.loads(json.dumps(audit)))
            return cur + 1

    def audit(self, account_id, limit=200):
        return list(self._audit.get(account_id, []))[-limit:][::-1]


class JsonFileStore(MemoryStore):
    """Durable single-process store: atomic file replace. Used for tests of restart persistence and local dev."""

    def __init__(self, directory: str) -> None:
        super().__init__()
        self.dir = Path(directory); self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, account_id: str) -> Path:
        safe = "".join(ch for ch in account_id if ch.isalnum() or ch in "-_") or "default"
        return self.dir / f"{safe}.json"

    def _read(self, account_id):
        p = self._path(account_id)
        return json.loads(p.read_text()) if p.exists() else {"state": None, "version": 0, "audit": []}

    def load(self, account_id):
        with self._lock:
            d = self._read(account_id)
            return d["state"], d["version"]

    def save(self, account_id, state, audit, expected_version):
        with self._lock:
            d = self._read(account_id)
            if d["version"] != expected_version:
                raise StaleStateError(account_id)
            d = {"state": state, "version": d["version"] + 1, "audit": (d["audit"] + audit)[-20000:]}
            fd, tmp = tempfile.mkstemp(dir=self.dir)
            with os.fdopen(fd, "w") as f:
                json.dump(d, f)
            os.replace(tmp, self._path(account_id))
            return d["version"]

    def audit(self, account_id, limit=200):
        with self._lock:
            return self._read(account_id)["audit"][-limit:][::-1]

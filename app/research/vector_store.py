"""Durable vector database on SQLite (stdlib) with the same interface as VectorMemory.

Vectors are stored as float32 blobs next to their text and metadata, writes are transactional (WAL mode, so readers never block the writer and
several processes can share one file), and search is exact cosine similarity over a matrix that is cached and rebuilt only when the table
changes. That is the right trade-off up to a few hundred thousand notes; beyond that a server-side index (pgvector, Qdrant) is the next step and
this class is the interface to keep. Not a server and not an approximate-nearest-neighbour index.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from typing import Any, Callable

import numpy as np

from .vector_memory import Embedder, Entry, HashingEmbedder, Hit

_SCHEMA = """
CREATE TABLE IF NOT EXISTS vectors (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, kind TEXT NOT NULL, meta TEXT NOT NULL,
  created_at REAL NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_kind ON vectors(kind);
CREATE TABLE IF NOT EXISTS store_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class SqliteVectorStore:
    def __init__(self, path: str = ":memory:", embedder: Embedder | None = None) -> None:
        self.embedder: Embedder = embedder or HashingEmbedder()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=30)
        self._lock = threading.RLock()
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        cur = self._db.execute("SELECT v FROM store_meta WHERE k='dim'").fetchone()
        if cur is None:
            self._db.execute("INSERT OR IGNORE INTO store_meta VALUES ('dim', ?)", (str(self.embedder.dim),))
        elif int(cur[0]) != self.embedder.dim:
            raise ValueError(f"store was built with {cur[0]}-dimensional vectors, embedder produces {self.embedder.dim}")
        self._cache: tuple[int, int, list[Entry], np.ndarray] | None = None  # (data_version token, count) -> entries, matrix

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def __len__(self) -> int:
        with self._lock:
            return int(self._db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0])

    def _embed(self, texts: list[str]) -> np.ndarray:
        v = np.asarray(self.embedder(texts), dtype=np.float32)
        if v.ndim != 2 or v.shape != (len(texts), self.embedder.dim):
            raise ValueError("embedder returned an unexpected shape")
        return v

    @staticmethod
    def _entry(row: Any) -> Entry:
        return Entry(id=row[0], text=row[1], kind=row[2], meta=json.loads(row[3]), created_at=row[4])

    def get(self, id: str) -> Entry | None:
        with self._lock:
            row = self._db.execute("SELECT id,text,kind,meta,created_at FROM vectors WHERE id=?", (id,)).fetchone()
        return self._entry(row) if row else None

    def add(self, text: str, *, id: str | None = None, kind: str = "note", meta: dict[str, Any] | None = None, now: float | None = None) -> Entry:
        if not text or not text.strip():
            raise ValueError("text must not be empty")
        id = id or hashlib.sha256(text.encode()).hexdigest()[:16]
        vec = self._embed([text])[0]
        e = Entry(id=id, text=text, kind=kind, meta=dict(meta or {}), created_at=time.time() if now is None else now)
        with self._lock:
            self._cache = None
            self._db.execute(
                "INSERT INTO vectors(id,text,kind,meta,created_at,dim,vec) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET text=excluded.text, kind=excluded.kind, meta=excluded.meta, created_at=excluded.created_at, dim=excluded.dim, vec=excluded.vec",
                (e.id, e.text, e.kind, json.dumps(e.meta, sort_keys=True, default=str), e.created_at, len(vec), vec.astype(np.float32).tobytes()),
            )
        return e

    def add_many(self, items: list[dict[str, Any]]) -> int:
        """Insert several notes in ONE transaction (all or none)."""
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                for it in items:
                    self.add(it["text"], id=it.get("id"), kind=it.get("kind", "note"), meta=it.get("meta"))
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
        return len(items)

    def remove(self, id: str) -> bool:
        with self._lock:
            self._cache = None
            return self._db.execute("DELETE FROM vectors WHERE id=?", (id,)).rowcount > 0

    def _matrix(self) -> tuple[list[Entry], np.ndarray]:
        with self._lock:
            # data_version changes when ANOTHER connection commits; our own writes drop the cache explicitly (see add/remove).
            token = int(self._db.execute("PRAGMA data_version").fetchone()[0])
            if self._cache is not None and self._cache[0] == token:
                return self._cache[2], self._cache[3]
            rows = self._db.execute("SELECT id,text,kind,meta,created_at,vec FROM vectors ORDER BY seq").fetchall()
            entries = [self._entry(r) for r in rows]
            mat = np.vstack([np.frombuffer(r[5], dtype=np.float32) for r in rows]) if rows else np.zeros((0, self.embedder.dim), dtype=np.float32)
            self._cache = (token, len(rows), entries, mat)
            return entries, mat

    def search(self, query: str, k: int = 5, *, kind: str | None = None, where: Callable[[Entry], bool] | None = None, min_score: float = 0.0) -> list[Hit]:
        if not query.strip():
            return []
        entries, mat = self._matrix()
        if not entries:
            return []
        scores = mat @ self._embed([query])[0]
        hits: list[Hit] = []
        for i in np.argsort(-scores, kind="stable"):
            e, s = entries[int(i)], float(scores[i])
            if s < min_score:
                break
            if (kind and e.kind != kind) or (where and not where(e)):
                continue
            hits.append(Hit(e, s))
            if len(hits) >= k:
                break
        return hits

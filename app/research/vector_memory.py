"""Vector memory for trader research and strategy memory.

Embeddings are pluggable (``Embedder`` protocol). The built-in ``HashingEmbedder`` is a deterministic lexical embedder
(word and bigram hashing, L2 normalised): it finds notes that share vocabulary, it does NOT understand meaning the way a
neural model does. Pass any callable ``list[str] -> ndarray`` (for example a hosted embedding model) to get semantic search.
Search is exact cosine similarity over a numpy matrix, appropriate up to roughly 100k entries; beyond that use pgvector.
Persistence is atomic (write temp file, then rename) and versioned.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

import numpy as np

_TOKEN = re.compile(r"[a-z0-9][a-z0-9_.-]*", re.I)
FORMAT_VERSION = 1


class Embedder(Protocol):
    dim: int
    name: str

    def __call__(self, texts: list[str]) -> np.ndarray: ...


class HashingEmbedder:
    def __init__(self, dim: int = 512) -> None:
        if dim < 32:
            raise ValueError("dim must be at least 32")
        self.dim, self.name = dim, f"hashing-{dim}"

    def _features(self, text: str) -> Iterable[str]:
        toks = [t.lower() for t in _TOKEN.findall(text)]
        yield from toks
        for a, b in zip(toks, toks[1:]):
            yield a + " " + b

    def __call__(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            for f in self._features(t):
                h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "big")
                out[i, h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0  # signed hashing reduces collision bias
        return _normalise(out)


def _normalise(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return (m / n).astype(np.float32)


@dataclass
class Entry:
    id: str
    text: str
    kind: str = "note"  # note | strategy | lesson | trade_review | research
    meta: dict[str, Any] = field(default_factory=dict)
    created_at: float = 0.0


@dataclass
class Hit:
    entry: Entry
    score: float


class VectorMemory:
    def __init__(self, embedder: Embedder | None = None) -> None:
        self.embedder: Embedder = embedder or HashingEmbedder()
        self._entries: list[Entry] = []
        self._vecs = np.zeros((0, self.embedder.dim), dtype=np.float32)
        self._index: dict[str, int] = {}

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, id: str) -> Entry | None:
        i = self._index.get(id)
        return self._entries[i] if i is not None else None

    def add(self, text: str, *, id: str | None = None, kind: str = "note", meta: dict[str, Any] | None = None, now: float | None = None) -> Entry:
        """Insert or replace by id. Ids default to a content hash, so adding the same text twice is idempotent."""
        if not text or not text.strip():
            raise ValueError("text must not be empty")
        id = id or hashlib.sha256(text.encode()).hexdigest()[:16]
        vec = self._embed([text])[0]
        e = Entry(id=id, text=text, kind=kind, meta=dict(meta or {}), created_at=time.time() if now is None else now)
        if id in self._index:
            i = self._index[id]
            self._entries[i], self._vecs[i] = e, vec
        else:
            self._index[id] = len(self._entries)
            self._entries.append(e)
            self._vecs = np.vstack([self._vecs, vec[None, :]])
        return e

    def remove(self, id: str) -> bool:
        i = self._index.pop(id, None)
        if i is None:
            return False
        del self._entries[i]
        self._vecs = np.delete(self._vecs, i, axis=0)
        self._index = {e.id: n for n, e in enumerate(self._entries)}
        return True

    def search(self, query: str, k: int = 5, *, kind: str | None = None, where: Callable[[Entry], bool] | None = None, min_score: float = 0.0) -> list[Hit]:
        if not self._entries or not query.strip():
            return []
        scores = self._vecs @ self._embed([query])[0]
        order = np.argsort(-scores, kind="stable")
        hits: list[Hit] = []
        for i in order:
            e = self._entries[int(i)]
            s = float(scores[i])
            if s < min_score:
                break
            if (kind and e.kind != kind) or (where and not where(e)):
                continue
            hits.append(Hit(e, s))
            if len(hits) >= k:
                break
        return hits

    def _embed(self, texts: list[str]) -> np.ndarray:
        v = np.asarray(self.embedder(texts), dtype=np.float32)
        if v.ndim != 2 or v.shape != (len(texts), self.embedder.dim):
            raise ValueError("embedder returned an unexpected shape")
        return _normalise(v)

    def save(self, path: str) -> None:
        payload = {"version": FORMAT_VERSION, "embedder": self.embedder.name, "dim": self.embedder.dim,
                   "entries": [{"id": e.id, "text": e.text, "kind": e.kind, "meta": e.meta, "created_at": e.created_at} for e in self._entries],
                   "vectors": self._vecs.round(6).tolist()}
        d = os.path.dirname(os.path.abspath(path))
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".vm-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(payload, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    @classmethod
    def load(cls, path: str, embedder: Embedder | None = None) -> "VectorMemory":
        with open(path) as f:
            p = json.load(f)
        if p.get("version") != FORMAT_VERSION:
            raise ValueError("unsupported vector memory format")
        m = cls(embedder or HashingEmbedder(int(p["dim"])))
        if m.embedder.name != p["embedder"] or m.embedder.dim != p["dim"]:
            raise ValueError(f"memory was built with embedder {p['embedder']}; got {m.embedder.name}")
        m._entries = [Entry(**e) for e in p["entries"]]
        m._vecs = np.asarray(p["vectors"], dtype=np.float32).reshape(len(m._entries), m.embedder.dim)
        m._index = {e.id: i for i, e in enumerate(m._entries)}
        return m

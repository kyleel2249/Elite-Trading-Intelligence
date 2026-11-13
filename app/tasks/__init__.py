"""Background tasks run by `python -m app.infra.worker`. The queue exists only when REDIS_URL is set; otherwise `get_queue()` returns None
and callers keep working synchronously."""
from __future__ import annotations

import os
from dataclasses import asdict
from typing import Any

from app.infra.cache import locked
from app.infra.redis_client import Redis
from app.infra.taskqueue import Beat, TaskQueue

_queue: TaskQueue | None = None


def register(tq: TaskQueue) -> dict[str, Any]:
    """Register the application's tasks on `tq` and return them by short name."""

    @tq.task("research.forecast", max_retries=2)
    def forecast_task(values: list[float], horizon: int = 5, level: float = 0.9, neural: bool = False) -> dict:
        from app.research.forecast import forecast
        from app.research.neural import with_neural
        return asdict(forecast(values, horizon=horizon, level=level, models=with_neural() if neural else None))

    @tq.task("research.vector_index", max_retries=5, backoff=1.5)
    def vector_index_task(path: str, items: list[dict]) -> dict:
        """Add notes to an on-disk VectorMemory. Serialised by a Redis lock so concurrent workers cannot overwrite each other's save."""
        from app.research.vector_memory import VectorMemory
        with locked(tq.r, "vector:" + path, ttl_ms=60_000) as got:
            if not got:
                raise RuntimeError("vector store busy")  # retried with backoff
            vm = VectorMemory.load(path) if os.path.exists(path) else VectorMemory()
            for it in items:
                vm.add(it["text"], id=it.get("id"), kind=it.get("kind", "note"), meta=it.get("meta"))
            vm.save(path)
            return {"size": len(vm)}

    @tq.task("system.ping")
    def ping_task() -> str:
        return "pong"

    return {"forecast": forecast_task, "vector_index": vector_index_task, "ping": ping_task}


def get_queue() -> TaskQueue | None:
    global _queue
    url = os.environ.get("REDIS_URL", "")  # same variable the Settings field `redis_url` reads, without importing the whole app config
    if not url:
        try:
            from app.config import get_settings
            url = get_settings().redis_url
        except Exception:  # noqa: BLE001 - config unavailable (minimal worker image): treat as not configured
            url = ""
    if not url:
        return None
    if _queue is None:
        _queue = TaskQueue(Redis.from_url(url))
        register(_queue)
    return _queue


def default_beat(tq: TaskQueue) -> Beat:
    b = Beat(tq)
    b.add("heartbeat", "system.ping", every=60)
    return b

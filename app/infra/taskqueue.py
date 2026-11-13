"""Reliable Redis task queue with the semantics people expect from Celery: named tasks, .delay()/.apply_async(countdown|eta), retries with
exponential backoff, a dead-letter list, stored results, crash recovery and a periodic scheduler (Beat).

This is NOT the Celery package (it cannot be installed in this build environment); it is a small, dependency-free queue whose behaviour is
tested against a real redis-server. Delivery is AT-LEAST-ONCE: a worker that dies mid-task has its message re-queued after the visibility
timeout, so tasks must be idempotent.
"""
from __future__ import annotations

import json
import secrets
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any, Callable

from .redis_client import Redis, RedisConnectionError

SUCCESS, FAILURE, RETRY, STARTED = "SUCCESS", "FAILURE", "RETRY", "STARTED"


@dataclass
class TaskSpec:
    name: str
    fn: Callable[..., Any]
    queue: str = "default"
    max_retries: int = 3
    backoff: float = 2.0
    max_backoff: float = 300.0
    result_ttl: int = 3600


class Task:
    def __init__(self, tq: "TaskQueue", spec: TaskSpec) -> None:
        self.tq, self.spec = tq, spec
        self.name = spec.name

    def __call__(self, *a: Any, **kw: Any) -> Any:  # direct, synchronous call
        return self.spec.fn(*a, **kw)

    def delay(self, *a: Any, **kw: Any) -> str:
        return self.apply_async(a, kw)

    def apply_async(self, args: tuple | list = (), kwargs: dict | None = None, countdown: float | None = None, eta: float | None = None, task_id: str | None = None) -> str:
        return self.tq.enqueue(self.spec.name, list(args), kwargs or {}, countdown=countdown, eta=eta, task_id=task_id)


class TaskQueue:
    def __init__(self, r: Redis, namespace: str = "eti", visibility_timeout: float = 900.0) -> None:
        self.r, self.ns, self.visibility = r, namespace, visibility_timeout
        self.registry: dict[str, TaskSpec] = {}
        self._missing_seen: dict[str, float] = {}

    # ---- keys ----
    def _k(self, queue: str, part: str = "") -> str: return f"{self.ns}:q:{queue}" + (f":{part}" if part else "")
    def _rk(self, task_id: str) -> str: return f"{self.ns}:result:{task_id}"

    # ---- registration / producing ----
    def task(self, name: str | None = None, *, queue: str = "default", max_retries: int = 3, backoff: float = 2.0, max_backoff: float = 300.0, result_ttl: int = 3600) -> Callable[[Callable[..., Any]], Task]:
        def deco(fn: Callable[..., Any]) -> Task:
            spec = TaskSpec(name or f"{fn.__module__}.{fn.__name__}", fn, queue, max_retries, backoff, max_backoff, result_ttl)
            self.registry[spec.name] = spec
            return Task(self, spec)
        return deco

    def enqueue(self, name: str, args: list, kwargs: dict, *, countdown: float | None = None, eta: float | None = None, task_id: str | None = None, now: float | None = None) -> str:
        spec = self.registry.get(name)
        if spec is None:
            raise KeyError(f"unknown task {name!r}")
        tid = task_id or secrets.token_hex(12)
        try:
            raw = json.dumps({"id": tid, "task": name, "args": args, "kwargs": kwargs, "attempt": 0}, separators=(",", ":"), sort_keys=True)
        except TypeError as e:
            raise ValueError(f"task arguments must be JSON-serialisable: {e}") from e
        t = now if now is not None else time.time()
        due = eta if eta is not None else (t + countdown if countdown else None)
        if due is not None and due > t:
            self.r.zadd(self._k(spec.queue, "scheduled"), due, raw)
        else:
            self.r.lpush(self._k(spec.queue), raw)
        return tid

    # ---- results ----
    def result(self, task_id: str) -> dict[str, Any]:
        v = self.r.get(self._rk(task_id))
        return json.loads(v) if v else {"state": "PENDING"}

    def wait(self, task_id: str, timeout: float = 10.0, poll: float = 0.05) -> dict[str, Any]:
        end = time.time() + timeout
        while time.time() < end:
            r = self.result(task_id)
            if r["state"] in (SUCCESS, FAILURE):
                return r
            time.sleep(poll)
        return self.result(task_id)

    def stats(self, queue: str = "default") -> dict[str, int]:
        return {"waiting": self.r.llen(self._k(queue)), "scheduled": self.r.zcard(self._k(queue, "scheduled")), "processing": self.r.llen(self._k(queue, "processing")), "dead": self.r.llen(self._k(queue, "dead"))}

    # ---- consuming ----
    def promote_due(self, queue: str, now: float | None = None) -> int:
        t = now if now is not None else time.time()
        n = 0
        for raw in self.r.zrangebyscore(self._k(queue, "scheduled"), "-inf", t, limit=100):
            if self.r.zrem(self._k(queue, "scheduled"), raw) == 1:  # only the worker whose ZREM succeeds promotes it
                self.r.lpush(self._k(queue), raw)
                n += 1
        return n

    def recover(self, queue: str, now: float | None = None, grace: float = 5.0) -> int:
        """Re-queue messages stuck in 'processing' whose worker died (deadline passed, or never recorded for longer than `grace`)."""
        t = now if now is not None else time.time()
        n = 0
        for raw in self.r.lrange(self._k(queue, "processing"), 0, -1):
            dl = self.r.hget(self._k(queue, "inflight"), raw)
            stale = False
            if dl is not None:
                stale = float(dl) < t
                self._missing_seen.pop(raw, None)
            else:
                first = self._missing_seen.setdefault(raw, t)
                stale = t - first >= grace
            if stale and self.r.lrem(self._k(queue, "processing"), 1, raw):
                self.r.lpush(self._k(queue), raw)
                self.r.hdel(self._k(queue, "inflight"), raw)
                self._missing_seen.pop(raw, None)
                n += 1
        return n

    def _store(self, tid: str, ttl: int, **fields: Any) -> None:
        self.r.set(self._rk(tid), json.dumps(fields, default=str, separators=(",", ":")), ex=ttl)

    def run_one(self, queue: str = "default", block: float = 0.0, now: float | None = None) -> bool:
        """Take and execute at most one message. Returns True if a message was handled."""
        self.promote_due(queue, now)
        src, proc = self._k(queue), self._k(queue, "processing")
        raw = self.r.blmove(src, proc, block) if block > 0 else self.r.lmove(src, proc)
        if raw is None:
            return False
        self.r.hset(self._k(queue, "inflight"), raw, (now if now is not None else time.time()) + self.visibility)
        try:
            msg = json.loads(raw)
            spec = self.registry[msg["task"]]
        except (ValueError, KeyError) as e:
            self.r.lpush(self._k(queue, "dead"), raw)
            self._finish(queue, raw)
            tid = None
            try:
                tid = json.loads(raw).get("id")
            except ValueError:
                pass
            if tid:
                self._store(tid, 3600, state=FAILURE, error=f"unknown or malformed task: {e}")
            return True
        tid, attempt = msg["id"], int(msg.get("attempt", 0))
        self._store(tid, spec.result_ttl, state=STARTED, attempt=attempt, started_at=time.time())
        try:
            value = spec.fn(*msg.get("args", []), **msg.get("kwargs", {}))
            self._store(tid, spec.result_ttl, state=SUCCESS, result=value, attempt=attempt, finished_at=time.time())
        except Exception as e:  # noqa: BLE001 - a task may raise anything
            err = f"{type(e).__name__}: {e}"
            if attempt < spec.max_retries:
                nxt = dict(msg, attempt=attempt + 1)
                delay = min(spec.max_backoff, spec.backoff ** (attempt + 1))
                self.r.zadd(self._k(spec.queue, "scheduled"), (now if now is not None else time.time()) + delay, json.dumps(nxt, separators=(",", ":"), sort_keys=True))
                self._store(tid, spec.result_ttl, state=RETRY, error=err, attempt=attempt + 1, retry_in=delay)
            else:
                self.r.lpush(self._k(queue, "dead"), raw)
                self._store(tid, spec.result_ttl, state=FAILURE, error=err, traceback=traceback.format_exc(limit=5), attempt=attempt, finished_at=time.time())
        self._finish(queue, raw)  # only after the retry/dead/result writes, so a crash here duplicates rather than loses
        return True

    def _finish(self, queue: str, raw: str) -> None:
        self.r.lrem(self._k(queue, "processing"), 1, raw)
        self.r.hdel(self._k(queue, "inflight"), raw)

    def run_forever(self, queues: list[str], stop: threading.Event | None = None, poll: float = 1.0, recover_every: float = 30.0) -> None:
        stop = stop or threading.Event()
        last_recover = 0.0
        while not stop.is_set():
            try:
                if time.time() - last_recover >= recover_every:
                    for q in queues:
                        self.recover(q)
                    last_recover = time.time()
                busy = False
                for q in queues:
                    busy = self.run_one(q) or busy
                if not busy:
                    stop.wait(poll)
            except RedisConnectionError:
                stop.wait(min(30.0, poll * 5))  # Redis is down: back off and keep trying; in-flight messages are recovered on return


@dataclass
class BeatEntry:
    name: str
    task: str
    every: float
    args: list
    kwargs: dict


class Beat:
    """Periodic scheduler. Several Beat processes can run at once: a per-entry Redis lock (TTL = interval) lets exactly one enqueue per period."""
    def __init__(self, tq: TaskQueue) -> None:
        self.tq = tq
        self.entries: list[BeatEntry] = []

    def add(self, name: str, task: str, every: float, args: list | None = None, kwargs: dict | None = None) -> None:
        if every < 1:
            raise ValueError("interval must be at least 1 second")
        if task not in self.tq.registry:
            raise KeyError(f"unknown task {task!r}")
        self.entries.append(BeatEntry(name, task, every, args or [], kwargs or {}))

    def tick(self) -> list[str]:
        fired = []
        for e in self.entries:
            if self.tq.r.set(f"{self.tq.ns}:beat:{e.name}", "1", px=int(e.every * 1000), nx=True):
                self.tq.enqueue(e.task, e.args, e.kwargs)
                fired.append(e.name)
        return fired

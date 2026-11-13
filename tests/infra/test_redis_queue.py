import json
import os
import subprocess
import sys
import threading
import time

import pytest

from app.infra.cache import Lock, RedisCache, locked, rate_limit
from app.infra.redis_client import Redis, RedisConnectionError, RedisError
from app.infra.taskqueue import Beat, TaskQueue


def test_client_basics_and_errors(r):
    assert r.ping() and r.set("a", "1") and r.get("a") == "1" and r.get("missing") is None
    assert r.set("n", "x", nx=True) and not r.set("n", "y", nx=True) and r.get("n") == "x"
    assert r.incr("c") == 1 and r.incr("c") == 2
    r.set("big", "é" * 100_000)
    assert r.get("big") == "é" * 100_000  # multi-byte, larger than one socket read
    with pytest.raises(RedisError):
        r.lpush("a", "x")  # WRONGTYPE
    assert r.hgetall("none") == {}
    r.hset("h", "f", "v")
    assert r.hgetall("h") == {"f": "v"}
    assert Redis.from_url("redis://:pw@example.com:6380/2").port == 6380


def test_connection_failures_are_reported_and_recovered(redis_server):
    dead = Redis("127.0.0.1", 1, timeout=0.5)
    with pytest.raises(RedisConnectionError):
        dead.get("x")
    c = Redis("127.0.0.1", redis_server)
    assert c.ping()
    c.execute("CLIENT", "KILL", "TYPE", "normal", "SKIPME", "no")  # server drops us
    assert c.get("nothing") is None  # idempotent read transparently reconnects


def test_cache_lock_ratelimit(r):
    c = RedisCache(r)
    assert c.get("k") is None
    assert c.set("k", {"a": [1, 2]}, ttl=60) and c.get("k") == {"a": [1, 2]}
    calls = []
    assert c.get_or_set("g", lambda: calls.append(1) or {"v": 1}) == {"v": 1} and c.get_or_set("g", lambda: calls.append(1)) == {"v": 1} and len(calls) == 1
    a, b = Lock(r, "x", 5000), Lock(r, "x", 5000)
    assert a.acquire() and not b.acquire()
    assert not b.release() and a.extend(8000) and a.release() and b.acquire()
    b.release()
    with locked(r, "y") as got1:
        with locked(r, "y") as got2:
            assert got1 and not got2
    assert [rate_limit(r, "u", 3, 60, now=1000.0)[0] for _ in range(5)] == [True, True, True, False, False]
    assert rate_limit(r, "u", 3, 60, now=1061.0)[0]  # next window
    assert rate_limit(Redis("127.0.0.1", 1, timeout=0.3), "u", 3, 60) == (True, -1)  # fail-open
    assert RedisCache(Redis("127.0.0.1", 1, timeout=0.3)).get("k") is None  # cache outage is a miss, not an error


def make_tq(r):
    tq = TaskQueue(r, visibility_timeout=30)
    state = {"fail_times": 0, "seen": []}

    @tq.task("add")
    def add(a, b):
        return a + b

    @tq.task("flaky", max_retries=2, backoff=0.01)
    def flaky(x):
        state["seen"].append(x)
        if len(state["seen"]) <= state["fail_times"]:
            raise RuntimeError("boom")
        return x

    return tq, add, flaky, state


def test_task_runs_and_stores_result(r):
    tq, add, _, _ = make_tq(r)
    assert add(2, 3) == 5  # direct call
    tid = add.delay(2, 3)
    assert tq.result(tid) == {"state": "PENDING"} and tq.stats()["waiting"] == 1
    assert tq.run_one() and tq.result(tid)["state"] == "SUCCESS" and tq.result(tid)["result"] == 5
    assert tq.stats() == {"waiting": 0, "scheduled": 0, "processing": 0, "dead": 0} and not tq.run_one()
    with pytest.raises(ValueError):
        add.delay(object(), 1)
    with pytest.raises(KeyError):
        tq.enqueue("nope", [], {})


def test_fifo_and_scheduling(r):
    tq, add, _, _ = make_tq(r)
    ids = [add.delay(i, 0) for i in range(3)]
    for _ in range(3):
        tq.run_one()
    assert [tq.result(i)["result"] for i in ids] == [0, 1, 2]
    now = 1_000_000.0
    tid = add.apply_async((1, 1), countdown=30)
    tq.enqueue("add", [5, 5], {}, countdown=30, now=now, task_id="later")
    assert not tq.run_one(now=now) and tq.stats()["scheduled"] == 2
    assert tq.run_one(now=now + 31)  # "later" is due; the real-clock one is not
    assert tq.result("later")["result"] == 10 and tq.result(tid)["state"] == "PENDING"


def test_retry_with_backoff_then_success_and_dead_letter(r):
    tq, _, flaky, st = make_tq(r)
    st["fail_times"] = 2
    tid = flaky.delay(7)
    now = time.time()
    assert tq.run_one(now=now) and tq.result(tid)["state"] == "RETRY" and tq.result(tid)["attempt"] == 1 and tq.stats()["scheduled"] == 1
    assert tq.run_one(now=now + 5) and tq.result(tid)["state"] == "RETRY" and tq.result(tid)["attempt"] == 2
    assert tq.run_one(now=now + 10) and tq.result(tid)["state"] == "SUCCESS" and tq.result(tid)["attempt"] == 2
    st["seen"].clear(); st["fail_times"] = 99
    tid2 = flaky.delay(8)
    for step in range(3):
        assert tq.run_one(now=time.time() + step * 10)
    res = tq.result(tid2)
    assert res["state"] == "FAILURE" and "RuntimeError: boom" in res["error"] and tq.stats()["dead"] == 1 and tq.stats()["processing"] == 0


def test_crash_recovery_requeues_and_runs_once_more(r):
    tq, add, _, _ = make_tq(r)
    tid = add.delay(4, 4)
    raw = r.lmove(tq._k("default"), tq._k("default", "processing"))  # a worker took it and then died
    assert raw and tq.stats() == {"waiting": 0, "scheduled": 0, "processing": 1, "dead": 0}
    assert tq.recover("default") == 0  # no deadline recorded yet: wait out the grace period
    assert tq.recover("default", now=time.time() + 6) == 1
    assert tq.run_one() and tq.result(tid)["result"] == 8
    tid2 = add.delay(1, 1)
    raw = r.lmove(tq._k("default"), tq._k("default", "processing"))
    r.hset(tq._k("default", "inflight"), raw, time.time() + 1000)  # a live worker with a future deadline
    assert tq.recover("default") == 0 and tq.recover("default", now=time.time() + 2000) == 1
    assert tq.run_one() and tq.result(tid2)["result"] == 2


def test_unknown_task_goes_to_dead_letter(r):
    tq, _, _, _ = make_tq(r)
    r.lpush(tq._k("default"), json.dumps({"id": "zz", "task": "ghost", "args": [], "kwargs": {}, "attempt": 0}))
    assert tq.run_one() and tq.stats()["dead"] == 1 and tq.result("zz")["state"] == "FAILURE"
    r.lpush(tq._k("default"), "not json")
    assert tq.run_one() and tq.stats()["dead"] == 2


def test_concurrent_workers_run_each_task_exactly_once(redis_server, r):
    tq0, add, _, _ = make_tq(r)
    ids = [add.delay(i, i) for i in range(60)]
    done = threading.Event()
    counts: list[int] = []

    def worker():
        tq, _, _, _ = make_tq(Redis("127.0.0.1", redis_server))
        n = 0
        while not done.is_set():
            if tq.run_one():
                n += 1
            elif tq.r.llen(tq._k("default")) == 0:
                break
        counts.append(n)

    ts = [threading.Thread(target=worker) for _ in range(4)]
    [t.start() for t in ts]
    [t.join(20) for t in ts]
    assert sum(counts) == 60 and all(tq0.result(i)["result"] == k * 2 for k, i in enumerate(ids))


def test_beat_fires_once_per_period_even_with_two_schedulers(r):
    tq, add, _, _ = make_tq(r)
    b1, b2 = Beat(tq), Beat(tq)
    for b in (b1, b2):
        b.add("every", "add", every=60, args=[1, 2])
    assert b1.tick() == ["every"] and b2.tick() == [] and b1.tick() == [] and tq.stats()["waiting"] == 1
    with pytest.raises(ValueError):
        b1.add("x", "add", every=0.1)
    with pytest.raises(KeyError):
        b1.add("x", "ghost", every=5)


def test_application_tasks_end_to_end(r, tmp_path):
    from app.tasks import register
    tq = TaskQueue(r)
    t = register(tq)
    series = [100 + i * 0.5 + (i % 5) for i in range(120)]
    fid = t["forecast"].delay(series, horizon=3)
    nid = t["forecast"].delay(series, horizon=2, neural=True)
    vid = t["vector_index"].delay(str(tmp_path / "vm.npz"), [{"id": "a", "text": "bitcoin halving supply shock"}, {"id": "b", "text": "ethereum staking yield"}])
    while tq.run_one():
        pass
    f, v = tq.result(fid), tq.result(vid)
    assert f["state"] == "SUCCESS" and len(f["result"]["point"]) == 3 and f["result"]["horizon"] == 3
    assert tq.result(nid)["state"] == "SUCCESS" and any(s["name"] == "mlp8" for s in tq.result(nid)["result"]["scores"])
    assert v["state"] == "SUCCESS" and v["result"]["size"] == 2
    from app.research.vector_memory import VectorMemory
    assert VectorMemory.load(str(tmp_path / "vm.npz")).search("bitcoin supply", k=1)[0].entry.id == "a"
    lk = Lock(r, "vector:" + str(tmp_path / "vm.npz"), 60_000)
    assert lk.acquire()  # held by someone else => the task retries instead of corrupting the file
    vid2 = t["vector_index"].delay(str(tmp_path / "vm.npz"), [{"id": "c", "text": "x"}])
    tq.run_one()
    assert tq.result(vid2)["state"] == "RETRY" and "busy" in tq.result(vid2)["error"]


def test_worker_process_consumes_from_a_real_redis(redis_server, r):
    env = dict(os.environ, REDIS_URL=f"redis://127.0.0.1:{redis_server}/0", PYTHONPATH=os.getcwd())
    from app.tasks import register
    tq = TaskQueue(r)
    t = register(tq)
    proc = subprocess.Popen([sys.executable, "-m", "app.infra.worker", "--poll", "0.05"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        tid = t["ping"].delay()
        res = tq.wait(tid, timeout=15)
        assert res["state"] == "SUCCESS" and res["result"] == "pong"
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    assert subprocess.run([sys.executable, "-m", "app.infra.worker"], env=dict(env, REDIS_URL=""), capture_output=True).returncode == 2

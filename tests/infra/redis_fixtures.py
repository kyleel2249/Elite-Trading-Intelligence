"""Starts a throwaway real redis-server on a free port for the infra tests; skips them if the binary is missing."""
import shutil
import socket
import subprocess
import time

import pytest

from app.infra.redis_client import Redis


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="session")
def redis_server():
    exe = shutil.which("redis-server")
    if not exe:
        pytest.skip("redis-server binary not available")
    port = _free_port()
    proc = subprocess.Popen([exe, "--port", str(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = Redis("127.0.0.1", port)
    for _ in range(100):
        try:
            if r.ping():
                break
        except Exception:
            time.sleep(0.05)
    else:
        proc.kill()
        pytest.fail("redis-server did not start")
    yield port
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture()
def r(redis_server):
    c = Redis("127.0.0.1", redis_server)
    c.flushdb()
    yield c
    c.close()

"""Worker entry point:  REDIS_URL=redis://host:6379/0 python -m app.infra.worker --queues default [--beat]"""
from __future__ import annotations

import argparse
import signal
import sys
import threading

from app.tasks import default_beat, get_queue


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ETI task worker")
    ap.add_argument("--queues", default="default", help="comma-separated queue names")
    ap.add_argument("--beat", action="store_true", help="also run the periodic scheduler")
    ap.add_argument("--poll", type=float, default=1.0)
    a = ap.parse_args(argv)
    tq = get_queue()
    if tq is None:
        print("REDIS_URL is not set; nothing to do.", file=sys.stderr)
        return 2
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    if a.beat:
        beat = default_beat(tq)

        def beat_loop() -> None:
            while not stop.is_set():
                try:
                    beat.tick()
                except Exception as e:  # noqa: BLE001 - the scheduler must survive a Redis blip
                    print(f"beat error: {e}", file=sys.stderr, flush=True)
                stop.wait(1.0)

        threading.Thread(target=beat_loop, daemon=True).start()
    print(f"worker started on {a.queues}", flush=True)
    tq.run_forever([q.strip() for q in a.queues.split(",") if q.strip()], stop=stop, poll=a.poll)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

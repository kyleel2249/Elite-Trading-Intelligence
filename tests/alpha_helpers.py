import random
from datetime import datetime, timezone


def make_bars(n=300, seed=1, drift=0.002, vol=0.015, start=100.0, volume=1000.0, now_aligned=True):
    random.seed(seed)
    p, bars = start, []
    end_ms = datetime.now(timezone.utc).timestamp() * 1000 if now_aligned else 1.6e12
    for i in range(n):
        p *= 1 + random.gauss(drift, vol)
        o = p * (1 + random.gauss(0, 0.003))
        t = end_ms - (n - i) * 86_400_000
        bars.append({"open_time": t, "close_time": t + 86_399_000, "open": o, "high": max(o, p) * 1.006, "low": min(o, p) * 0.994,
                     "close": p, "volume": volume * (1 + random.random() * 0.5)})
    return bars


def accumulation_bars():
    """Prior advance, 20% decline, then a quiet base with rising up-volume: accumulation below the high."""
    closes = [100 + 40 * i / 100 for i in range(100)]
    closes += [140 - 28 * i / 50 for i in range(1, 51)]
    p = closes[-1]
    vols = [1000.0] * len(closes)
    for i in range(50):
        up = i % 2 == 0
        p *= 1.005 if up else 0.997
        closes.append(p)
        vols.append(2200.0 if up else 700.0)
    bars, prev = [], closes[0]
    end_ms = datetime.now(timezone.utc).timestamp() * 1000
    for i, (c, v) in enumerate(zip(closes, vols)):
        t = end_ms - (len(closes) - i) * 86_400_000
        bars.append({"open_time": t, "close_time": t + 86_399_000, "open": prev, "high": max(prev, c) * 1.002, "low": min(prev, c) * 0.998,
                     "close": c, "volume": v})
        prev = c
    return bars

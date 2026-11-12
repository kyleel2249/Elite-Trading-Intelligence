"""Deterministic synthetic series used ONLY to exercise strategy code paths in tests.
They are never reported as strategy performance."""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.strategies.types import Bars  # noqa: E402


def synth(n=1200, seed=7, drift=0.0002, vol=0.012):
    """Deterministic synthetic OHLCV with regime changes. For EXERCISING CODE ONLY."""
    rng = random.Random(seed); c = [100.0]; o = [100.0]; h = [100.5]; l = [99.5]; v = [1000.0]
    for i in range(1, n):
        reg = (i // 300) % 4
        mu = [drift * 4, 0.0, -drift * 3, drift][reg]; sg = vol * [1, 0.6, 1.6, 0.9][reg]
        r = rng.gauss(mu, sg); op = c[-1] * (1 + rng.gauss(0, sg * 0.2)); cl = c[-1] * (1 + r)
        hi = max(op, cl) * (1 + abs(rng.gauss(0, sg * 0.4))); lo = min(op, cl) * (1 - abs(rng.gauss(0, sg * 0.4)))
        o.append(op); c.append(cl); h.append(hi); l.append(lo); v.append(1000 * (1 + abs(r) / sg) * rng.uniform(0.6, 1.4))
    return Bars(c=c, o=o, h=h, l=l, v=v, t=list(range(n)), symbol="SYNTH", interval="1h")


def synth_pair(b, seed=11):
    rng = random.Random(seed); x = [100.0]
    for i in range(1, len(b)):
        x.append(x[-1] * (1 + 0.5 * (b.c[i] / b.c[i - 1] - 1) + rng.gauss(0, 0.004)))
    return x

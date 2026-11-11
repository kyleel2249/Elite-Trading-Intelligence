"""Run standalone: python -m pytest --noconftest tests/research -q  (no web stack needed)."""
import os
import sys
import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from app.research.vector_memory import HashingEmbedder, VectorMemory
from app.research.forecast import MODELS, forecast, walk_forward, naive


def test_search_ranks_relevant_note_first_and_filters():
    m = VectorMemory()
    m.add("Breakout above the 20 day high with rising volume works in trending regimes", id="a", kind="strategy")
    m.add("Mean reversion fades overbought RSI in choppy range markets", id="b", kind="strategy")
    m.add("Lesson: moved stop loss wider after entry and took a larger loss", id="c", kind="lesson")
    top = m.search("volume breakout trend", k=3)
    assert top[0].entry.id == "a" and top[0].score > top[-1].score
    assert [h.entry.id for h in m.search("stop loss", kind="lesson")] == ["c"]
    assert m.search("   ") == [] and VectorMemory().search("x") == []
    assert all(h.entry.kind == "strategy" for h in m.search("range", kind="strategy"))
    assert m.search("zzzz unrelated", min_score=0.5) == []


def test_add_is_idempotent_replace_and_remove():
    m = VectorMemory()
    m.add("same text"); m.add("same text")
    assert len(m) == 1
    m.add("v1", id="x"); m.add("completely new body", id="x")
    assert m.get("x").text == "completely new body" and len(m) == 2
    assert m.remove("x") and not m.remove("x") and len(m) == 1
    with pytest.raises(ValueError):
        m.add("  ")


def test_persistence_roundtrip_atomic_and_embedder_guard(tmp_path):
    m = VectorMemory()
    m.add("liquidity sweep then reclaim", id="p", meta={"symbol": "BTCUSDT"}, now=1.0)
    path = str(tmp_path / "mem.json")
    m.save(path)
    assert not [f for f in os.listdir(tmp_path) if f.endswith(".tmp")]
    r = VectorMemory.load(path)
    assert r.get("p").meta == {"symbol": "BTCUSDT"} and r.search("liquidity sweep")[0].entry.id == "p"
    with pytest.raises(ValueError):
        VectorMemory.load(path, HashingEmbedder(256))


def test_custom_embedder_shape_is_checked():
    class Bad:
        dim, name = 64, "bad"
        def __call__(self, texts): return np.zeros((1, 3))
    with pytest.raises(ValueError):
        VectorMemory(Bad()).add("x")


def _ar_series(n=400, seed=1):
    r = np.random.default_rng(seed); y = np.zeros(n)
    for t in range(2, n):
        y[t] = 0.6 * y[t - 1] - 0.3 * y[t - 2] + r.normal(0, 1)
    return y + 100


def test_walk_forward_uses_no_future_data():
    y = _ar_series(); seen = []
    def spy(hist, h):
        seen.append(len(hist)); return naive(hist, h)
    a, p, _ = walk_forward(y, spy, h=3, min_train=60)
    assert seen[0] == 60 and max(seen) <= len(y) - 3 and np.array_equal(a[:2], y[62:64])
    y2 = y.copy(); y2[300:] += 1000  # changing the future must not change earlier predictions
    _, p2, _ = walk_forward(y2, naive, h=3, min_train=60)
    _, p1, _ = walk_forward(y, naive, h=3, min_train=60)
    assert np.array_equal(p1[:230], p2[:230])


def test_forecast_beats_naive_on_ar_and_not_on_random_walk():
    f = forecast(_ar_series(), horizon=3)
    assert f.beats_naive and f.model != "naive" and all(l <= p <= u for l, p, u in zip(f.lower, f.point, f.upper))
    rw = np.cumsum(np.random.default_rng(5).normal(0, 1, 500)) + 100
    g = forecast(rw, horizon=3)
    assert g.scores[0].mase > 0.95 or not g.beats_naive or g.model in ("naive", "drift", "ewma")  # a random walk is not predictable
    assert len(g.point) == 3 and set(s.name for s in g.scores) == set(MODELS)


def test_forecast_validation():
    with pytest.raises(ValueError):
        forecast([1.0] * 10)
    with pytest.raises(ValueError):
        forecast(np.array([1.0, np.nan] * 100))
    with pytest.raises(ValueError):
        forecast(_ar_series(), horizon=0)
    with pytest.raises(ValueError):
        forecast(_ar_series(), level=1.2)

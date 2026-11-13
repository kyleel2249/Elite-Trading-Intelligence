import numpy as np

from app.research.forecast import forecast
from app.research.neural import Net, init_net, loss_and_grads, mlp, train, with_neural


def test_backprop_matches_finite_differences():
    rng = np.random.default_rng(1)
    X, t = rng.normal(size=(30, 5)), rng.normal(size=30)
    net = init_net(5, 7, rng)
    net.b1 += rng.normal(size=7) * 0.1
    net.b2 += 0.3
    _, grads = loss_and_grads(net, X, t, wd=1e-2)
    for p, g in zip([net.W1, net.b1, net.W2, net.b2], grads):
        flat, gflat = p.reshape(-1), g.reshape(-1)
        for i in rng.choice(len(flat), size=min(6, len(flat)), replace=False):
            old = flat[i]
            flat[i] = old + 1e-6; lp, _ = loss_and_grads(net, X, t, 1e-2)
            flat[i] = old - 1e-6; lm, _ = loss_and_grads(net, X, t, 1e-2)
            flat[i] = old
            assert abs((lp - lm) / 2e-6 - gflat[i]) < 1e-6 * max(1.0, abs(gflat[i]))


def test_training_reduces_error_and_is_deterministic():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(300, 4))
    t = np.tanh(X[:, 0] - 0.5 * X[:, 1]) + 0.05 * rng.normal(size=300)
    n1, n2 = train(X, t, seed=3), train(X, t, seed=3)
    assert np.allclose(n1.W1, n2.W1) and np.allclose(n1.predict(X), n2.predict(X))
    assert np.mean((n1.predict(X) - t) ** 2) < 0.5 * np.var(t)


def _walk(kind, n=400, seed=5):
    rng = np.random.default_rng(seed)
    if kind == "random_walk":
        return 100 + np.cumsum(rng.normal(size=n))
    # a genuinely predictable series: mean-reverting differences with a nonlinear component
    d = np.zeros(n)
    for i in range(2, n):
        d[i] = 0.6 * np.sin(2.0 * d[i - 1]) - 0.3 * d[i - 2] + 0.15 * rng.normal()
    return 100 + np.cumsum(d)


def test_beats_naive_on_predictable_series_but_not_on_a_random_walk():
    s = {x.name: x for x in forecast(_walk("predictable"), horizon=1, models=with_neural()).scores}
    assert s["mlp8"].mase < 0.9, s["mlp8"]
    rw = forecast(_walk("random_walk"), horizon=1, models=with_neural())
    s2 = {x.name: x for x in rw.scores}
    assert s2["mlp8"].mase > 0.97, "a random walk must not look predictable"  # honest: no edge claimed where none exists
    assert s2["mlp8"].directional_accuracy < 0.6


def test_short_series_falls_back_and_output_is_finite():
    m = mlp()
    y = np.linspace(100, 101, 20)
    assert np.allclose(m(y, 3), 101.0)  # naive fallback
    out = m(_walk("predictable"), 5)
    assert out.shape == (5,) and np.all(np.isfinite(out))

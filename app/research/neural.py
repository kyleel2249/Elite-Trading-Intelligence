"""Small neural forecaster implemented directly on numpy (PyTorch is not installable in this build environment).

A one-hidden-layer tanh network predicts the next first-difference from the previous `lags` differences (all standardised), trained with Adam,
L2 weight decay and early stopping on a held-out tail. Multi-step forecasts are recursive. Training is deterministic (seeded) and the model is
re-trained only every `retrain_every` calls so walk-forward scoring stays fast. It plugs into app.research.forecast as an ordinary Model, so it
is judged by the same leak-free walk-forward MASE as every other candidate and is only reported as useful if it beats naive.

Backpropagation is verified against finite differences in tests/research/test_neural.py.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .forecast import MODELS, Model, naive


@dataclass
class Net:
    W1: np.ndarray
    b1: np.ndarray
    W2: np.ndarray
    b2: np.ndarray

    def forward(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        a = np.tanh(X @ self.W1 + self.b1)
        return a, (a @ self.W2 + self.b2)[:, 0]

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self.forward(X)[1]


def init_net(n_in: int, hidden: int, rng: np.random.Generator) -> Net:
    return Net(rng.normal(0, np.sqrt(1.0 / n_in), (n_in, hidden)), np.zeros(hidden), rng.normal(0, np.sqrt(1.0 / hidden), (hidden, 1)), np.zeros(1))


def loss_and_grads(net: Net, X: np.ndarray, t: np.ndarray, wd: float) -> tuple[float, list[np.ndarray]]:
    a, yhat = net.forward(X)
    n = len(t)
    err = yhat - t
    loss = float(np.mean(err ** 2) + wd * (np.sum(net.W1 ** 2) + np.sum(net.W2 ** 2)))
    dY = (2.0 / n) * err[:, None]
    gW2 = a.T @ dY + 2 * wd * net.W2
    gb2 = dY.sum(axis=0)
    dZ = (dY @ net.W2.T) * (1 - a ** 2)
    gW1 = X.T @ dZ + 2 * wd * net.W1
    gb1 = dZ.sum(axis=0)
    return loss, [gW1, gb1, gW2, gb2]


def train(X: np.ndarray, t: np.ndarray, hidden: int = 12, epochs: int = 200, lr: float = 0.01, wd: float = 1e-3, seed: int = 0, val_frac: float = 0.15) -> Net:
    rng = np.random.default_rng(seed)
    n_val = max(1, int(len(t) * val_frac)) if len(t) >= 20 else 0
    Xtr, ttr = (X[:-n_val], t[:-n_val]) if n_val else (X, t)
    Xva, tva = (X[-n_val:], t[-n_val:]) if n_val else (X, t)
    net = init_net(X.shape[1], hidden, rng)
    params = [net.W1, net.b1, net.W2, net.b2]
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]
    best, best_val, stall = [p.copy() for p in params], np.inf, 0
    for step in range(1, epochs + 1):
        _, g = loss_and_grads(net, Xtr, ttr, wd)
        for i, p in enumerate(params):
            m[i] = 0.9 * m[i] + 0.1 * g[i]
            v[i] = 0.999 * v[i] + 0.001 * g[i] ** 2
            p -= lr * (m[i] / (1 - 0.9 ** step)) / (np.sqrt(v[i] / (1 - 0.999 ** step)) + 1e-8)
        val = float(np.mean((net.predict(Xva) - tva) ** 2))
        if val < best_val - 1e-9:
            best_val, best, stall = val, [p.copy() for p in params], 0
        else:
            stall += 1
            if stall >= 25:
                break
    for p, b in zip(params, best):
        p[...] = b
    return net


def mlp(lags: int = 8, hidden: int = 12, epochs: int = 200, retrain_every: int = 10, seed: int = 0) -> Model:
    """Return a forecast Model(y, h). State (the trained network) is kept in the closure and refreshed every `retrain_every` new observations."""
    state: dict = {"net": None, "n": -10 ** 9, "mu": 0.0, "sd": 1.0}

    def f(y: np.ndarray, h: int) -> np.ndarray:
        d = np.diff(y)
        if len(d) < lags + 25:
            return naive(y, h)
        if state["net"] is None or len(y) - state["n"] >= retrain_every or len(y) < state["n"]:
            mu, sd = float(d.mean()), float(d.std()) or 1.0
            z = (d - mu) / sd
            X = np.column_stack([z[i:len(z) - lags + i] for i in range(lags)])
            state.update(net=train(X, z[lags:], hidden, epochs, seed=seed), n=len(y), mu=mu, sd=sd)
        net, mu, sd = state["net"], state["mu"], state["sd"]
        buf = list(((d - mu) / sd)[-lags:])
        level, out = float(y[-1]), []
        for _ in range(h):
            nxt = float(net.predict(np.asarray(buf[-lags:])[None, :])[0])
            buf.append(nxt)
            level += nxt * sd + mu
            out.append(level)
        return np.asarray(out)

    return f


def with_neural(models: dict[str, Model] | None = None) -> dict[str, Model]:
    """The default candidate set plus the neural model, for forecast(..., models=with_neural())."""
    out = dict(models or MODELS)
    out["mlp8"] = mlp(8)
    return out

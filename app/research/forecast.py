"""Walk-forward time-series forecasting on numpy.

Candidates: naive, drift, EWMA, Holt (damped trend), and an AR(p) fit by least squares. Every model is scored with
expanding-window walk-forward evaluation, so each forecast uses only data available at that time (no look-ahead).
The best model by MASE (error relative to the naive forecast) is refit on all data and returns point forecasts with
prediction intervals from out-of-sample residuals. Reported honestly: if no model beats naive, ``beats_naive`` is False and
the caller should not trade on the forecast.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

Model = Callable[[np.ndarray, int], np.ndarray]  # (history, horizon) -> forecasts


def naive(y: np.ndarray, h: int) -> np.ndarray:
    return np.repeat(y[-1], h)


def drift(y: np.ndarray, h: int) -> np.ndarray:
    slope = (y[-1] - y[0]) / max(len(y) - 1, 1)
    return y[-1] + slope * np.arange(1, h + 1)


def ewma(alpha: float = 0.3) -> Model:
    def f(y: np.ndarray, h: int) -> np.ndarray:
        lvl = y[0]
        for v in y[1:]:
            lvl = alpha * v + (1 - alpha) * lvl
        return np.repeat(lvl, h)
    return f


def holt(alpha: float = 0.4, beta: float = 0.1, phi: float = 0.9) -> Model:
    def f(y: np.ndarray, h: int) -> np.ndarray:
        lvl, tr = y[0], (y[1] - y[0]) if len(y) > 1 else 0.0
        for v in y[1:]:
            prev = lvl
            lvl = alpha * v + (1 - alpha) * (lvl + phi * tr)
            tr = beta * (lvl - prev) + (1 - beta) * phi * tr
        damp = np.cumsum(phi ** np.arange(1, h + 1))
        return lvl + damp * tr
    return f


def ar(p: int = 5, ridge: float = 1e-6) -> Model:
    def f(y: np.ndarray, h: int) -> np.ndarray:
        if len(y) <= p + 2:
            return naive(y, h)
        mu = y.mean()
        z = y - mu
        X = np.column_stack([z[i:len(z) - p + i] for i in range(p)])
        t = z[p:]
        w = np.linalg.solve(X.T @ X + ridge * np.eye(p), X.T @ t)
        buf = list(z[-p:])
        out = []
        for _ in range(h):
            nxt = float(np.dot(w, buf[-p:]))
            out.append(nxt)
            buf.append(nxt)
        return np.asarray(out) + mu
    return f


MODELS: dict[str, Model] = {"naive": naive, "drift": drift, "ewma": ewma(), "holt": holt(), "ar5": ar(5), "ar10": ar(10)}


@dataclass
class Score:
    name: str
    mae: float
    rmse: float
    mase: float
    directional_accuracy: float
    n: int


@dataclass
class Forecast:
    model: str
    horizon: int
    point: list[float]
    lower: list[float]
    upper: list[float]
    scores: list[Score]
    beats_naive: bool
    level: float


def walk_forward(y: np.ndarray, model: Model, h: int = 1, min_train: int = 60, step: int = 1) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (actual, predicted, origin_value) at horizon h from expanding-window origins. Uses only y[:t] to predict y[t+h-1]."""
    act, pred, base = [], [], []
    for t in range(min_train, len(y) - h + 1, step):
        pred.append(model(y[:t], h)[-1]); act.append(y[t + h - 1]); base.append(y[t - 1])
    return np.asarray(act), np.asarray(pred), np.asarray(base)


def _score(name: str, y: np.ndarray, model: Model, h: int, min_train: int) -> Score:
    a, p, b = walk_forward(y, model, h, min_train)
    n_a, n_p, _ = walk_forward(y, naive, h, min_train)
    err = a - p
    naive_mae = float(np.mean(np.abs(n_a - n_p))) or 1e-12
    mae = float(np.mean(np.abs(err)))
    return Score(name, mae, float(np.sqrt(np.mean(err ** 2))), mae / naive_mae, float(np.mean(np.sign(p - b) == np.sign(a - b))), len(a))


def forecast(y_in, horizon: int = 5, *, level: float = 0.9, min_train: int = 60, models: dict[str, Model] | None = None) -> Forecast:
    y = np.asarray(y_in, dtype=float)
    if y.ndim != 1 or not np.all(np.isfinite(y)):
        raise ValueError("series must be one-dimensional and finite")
    if horizon < 1 or not 0.5 <= level < 1:
        raise ValueError("horizon must be >= 1 and level in [0.5, 1)")
    if len(y) < min_train + horizon + 20:
        raise ValueError(f"need at least {min_train + horizon + 20} observations")
    cands = models or MODELS
    scores = sorted((_score(n, y, m, horizon, min_train) for n, m in cands.items()), key=lambda s: s.mase)
    best = scores[0]
    a, p, _ = walk_forward(y, cands[best.name], horizon, min_train)
    resid = a - p
    lo_q, hi_q = np.quantile(resid, [(1 - level) / 2, 1 - (1 - level) / 2])
    pt = cands[best.name](y, horizon)
    widen = np.sqrt(np.arange(1, horizon + 1) / horizon)  # uncertainty grows with distance within the horizon
    return Forecast(best.name, horizon, pt.tolist(), (pt + lo_q * widen).tolist(), (pt + hi_q * widen).tolist(), scores, best.mase < 1.0, level)

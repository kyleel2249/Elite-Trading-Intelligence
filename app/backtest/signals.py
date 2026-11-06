"""Module-specific signal features: VCP, Wyckoff heuristics, breakout, SMA."""
from __future__ import annotations

from typing import Sequence


def sma_trend_signals(closes: Sequence[float], lookback: int) -> list[int]:
    sig = [0] * len(closes)
    for i in range(lookback, len(closes)):
        sma = sum(closes[i - lookback : i]) / lookback
        if closes[i] > sma:
            sig[i] = 1
        elif closes[i] < sma:
            sig[i] = -1
    return sig


def breakout_signals(closes: Sequence[float], lookback: int) -> list[int]:
    sig = [0] * len(closes)
    for i in range(lookback, len(closes)):
        window = closes[i - lookback : i]
        hi, lo = max(window), min(window)
        if closes[i] > hi:
            sig[i] = 1
        elif closes[i] < lo:
            sig[i] = -1
    return sig


def vcp_signals(closes: Sequence[float], lookback: int = 30) -> list[int]:
    """
    Volatility Contraction Pattern proxy (Minervini-inspired educational heuristic).
    Detects contracting ranges then breakout. Not a commercial SEPA replica.
    """
    sig = [0] * len(closes)
    if len(closes) < lookback + 5:
        return sig
    for i in range(lookback, len(closes)):
        segment = closes[i - lookback : i]
        # Split into thirds — ranges should contract
        n = lookback // 3
        if n < 3:
            continue
        r1 = max(segment[:n]) - min(segment[:n])
        r2 = max(segment[n : 2 * n]) - min(segment[n : 2 * n])
        r3 = max(segment[2 * n :]) - min(segment[2 * n :])
        contracted = r1 > 0 and r3 < r2 < r1 * 0.85
        pivot = max(segment)
        if contracted and closes[i] > pivot:
            sig[i] = 1
        # Exit if close below recent contraction midpoint
        mid = (max(segment[2 * n :]) + min(segment[2 * n :])) / 2
        if closes[i] < mid and closes[i - 1] >= mid:
            sig[i] = -1
    return sig


def wyckoff_signals(closes: Sequence[float], volumes: Sequence[float] | None = None, lookback: int = 40) -> list[int]:
    """
    Simplified Wyckoff-inspired heuristic:
    - Prolonged range (cause)
    - Spring: brief break of range low then recovery
    - Markup: break of range high after spring-like event
    Volume optional; if absent, price-only.
    """
    sig = [0] * len(closes)
    if len(closes) < lookback + 5:
        return sig
    for i in range(lookback, len(closes)):
        window = closes[i - lookback : i]
        hi, lo = max(window), min(window)
        rng = hi - lo
        if rng <= 0:
            continue
        # Range-bound if recent volatility fraction of range is moderate
        # Spring: recent low below lo then close back inside
        recent = closes[i - 5 : i + 1]
        spring = min(recent) < lo and closes[i] > lo
        if spring:
            # Prefer higher volume on spring if available
            if volumes and len(volumes) == len(closes):
                vol_win = volumes[i - 5 : i + 1]
                if vol_win[-1] < sum(vol_win[:-1]) / max(len(vol_win) - 1, 1):
                    pass  # weak volume spring — still mark cautious long bias
            sig[i] = 1
        elif closes[i] > hi:
            sig[i] = 1  # markup / SOS proxy
        elif closes[i] < lo:
            sig[i] = -1  # breakdown / SOW proxy
    return sig

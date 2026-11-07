"""Module-specific signal features: VCP (+volume), Wyckoff, breakout, SMA."""
from __future__ import annotations

from typing import Optional, Sequence


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


def vcp_signals(
    closes: Sequence[float],
    lookback: int = 30,
    volumes: Optional[Sequence[float]] = None,
    require_volume: bool = True,
) -> list[int]:
    """
    VCP proxy with optional volume confirmation on breakout.
    Volume rule: breakout bar volume > average volume of contraction segment.
    """
    sig = [0] * len(closes)
    if len(closes) < lookback + 5:
        return sig
    for i in range(lookback, len(closes)):
        segment = closes[i - lookback : i]
        n = lookback // 3
        if n < 3:
            continue
        r1 = max(segment[:n]) - min(segment[:n])
        r2 = max(segment[n : 2 * n]) - min(segment[n : 2 * n])
        r3 = max(segment[2 * n :]) - min(segment[2 * n :])
        contracted = r1 > 0 and r3 < r2 < r1 * 0.85
        pivot = max(segment)
        vol_ok = True
        if require_volume and volumes is not None and len(volumes) == len(closes):
            avg_vol = sum(volumes[i - lookback : i]) / lookback
            vol_ok = volumes[i] > avg_vol * 1.1
        if contracted and closes[i] > pivot and vol_ok:
            sig[i] = 1
        mid = (max(segment[2 * n :]) + min(segment[2 * n :])) / 2
        if closes[i] < mid and closes[i - 1] >= mid:
            sig[i] = -1
    return sig


def wyckoff_signals(
    closes: Sequence[float],
    volumes: Optional[Sequence[float]] = None,
    lookback: int = 40,
) -> list[int]:
    sig = [0] * len(closes)
    if len(closes) < lookback + 5:
        return sig
    for i in range(lookback, len(closes)):
        window = closes[i - lookback : i]
        hi, lo = max(window), min(window)
        if hi - lo <= 0:
            continue
        recent = closes[i - 5 : i + 1]
        spring = min(recent) < lo and closes[i] > lo
        if spring:
            sig[i] = 1
        elif closes[i] > hi:
            if volumes is not None and len(volumes) == len(closes):
                avg_vol = sum(volumes[i - lookback : i]) / lookback
                if volumes[i] >= avg_vol:
                    sig[i] = 1
            else:
                sig[i] = 1
        elif closes[i] < lo:
            sig[i] = -1
    return sig

"""ETI CAPITAL PROTECTION SYSTEM — policy.

The policy is immutable and is built only from server configuration. No request
body, language-model output or signal engine can construct or modify it. Every
limit is clamped to a hard ceiling so that a misconfiguration (for example
``CPS_MAX_LEVERAGE=100``) cannot silently remove capital protection.

This module is deliberately dependency-free (standard library only).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Optional

# name -> (lower bound, hard ceiling). Values outside are clamped, never accepted.
HARD_LIMITS: dict[str, tuple[float, float]] = {
    "max_risk_per_trade_pct": (0.01, 2.0),
    "max_daily_loss_pct": (0.1, 5.0),
    "max_weekly_loss_pct": (0.1, 10.0),
    "max_drawdown_pct": (0.5, 25.0),
    "max_open_positions": (1, 20),
    "max_correlated_exposure_pct": (1.0, 50.0),
    "max_leverage": (0.1, 3.0),
    "max_position_notional_pct": (0.1, 25.0),
    "max_consecutive_losses": (1, 10),
    "consecutive_loss_cooldown_minutes": (1, 7 * 24 * 60),
    "emergency_drawdown_pct": (1.0, 30.0),
    "emergency_daily_loss_pct": (0.2, 10.0),
    "target_volatility_pct": (0.1, 10.0),
    "extreme_volatility_pct": (1.0, 30.0),
    "min_stop_distance_pct": (0.01, 5.0),
    "max_stop_distance_pct": (0.5, 25.0),
    "equity_session_buffer_minutes": (0, 120),
    "news_blackout_before_minutes": (0, 24 * 60),
    "news_blackout_after_minutes": (0, 24 * 60),
}

INT_FIELDS = {
    "max_open_positions", "max_consecutive_losses", "consecutive_loss_cooldown_minutes",
    "equity_session_buffer_minutes", "news_blackout_before_minutes", "news_blackout_after_minutes",
}


@dataclass(frozen=True)
class ProtectionPolicy:
    max_risk_per_trade_pct: float = 0.5
    max_daily_loss_pct: float = 2.0
    max_weekly_loss_pct: float = 5.0
    max_drawdown_pct: float = 10.0
    max_open_positions: int = 5
    max_correlated_exposure_pct: float = 20.0
    max_leverage: float = 1.0
    max_position_notional_pct: float = 6.0
    max_consecutive_losses: int = 3
    consecutive_loss_cooldown_minutes: int = 240
    emergency_drawdown_pct: float = 12.0
    emergency_daily_loss_pct: float = 4.0
    target_volatility_pct: float = 2.0
    extreme_volatility_pct: float = 12.0
    min_stop_distance_pct: float = 0.1
    max_stop_distance_pct: float = 10.0
    # A stop may not be tighter than this multiple of the instrument's ATR%.
    min_stop_atr_multiple: float = 0.5
    # Size multiplier applied when volatility is unknown / after a loss streak.
    missing_volatility_scale: float = 0.5
    loss_streak_scale: float = 0.5
    min_volatility_scale: float = 0.1
    session_restrictions_enabled: bool = True
    equity_session_buffer_minutes: int = 15
    blocked_windows_utc: tuple[str, ...] = ()
    news_blackout_before_minutes: int = 30
    news_blackout_after_minutes: int = 30
    news_calendar_required_for_live: bool = True
    require_strategy_attribution_live: bool = True
    auto_liquidate_on_stop_breach: bool = True
    auto_liquidate_on_emergency: bool = True
    # Informational: which values were clamped when the policy was built.
    clamped: tuple[str, ...] = field(default=(), compare=False)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["blocked_windows_utc"] = list(self.blocked_windows_utc)
        d["clamped"] = list(self.clamped)
        return d

    @property
    def fingerprint(self) -> str:
        """Stable hash recorded on every decision so a tampered policy is detectable."""
        payload = {k: v for k, v in self.to_dict().items() if k != "clamped"}
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _coerce(name: str, value: Any, default: Any) -> tuple[Any, bool]:
    """Return (safe_value, clamped). Non-numeric / non-finite input falls back to the default."""
    lo, hi = HARD_LIMITS[name]
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default, True
    if num != num or num in (float("inf"), float("-inf")):
        return default, True
    clamped = False
    if num < lo:
        num, clamped = lo, True
    if num > hi:
        num, clamped = hi, True
    if name in INT_FIELDS:
        return int(num), clamped
    return num, clamped


def parse_windows(raw: Optional[str]) -> tuple[str, ...]:
    out: list[str] = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            a, b = part.split("-")
            for hhmm in (a, b):
                h, m = hhmm.split(":")
                if not (0 <= int(h) <= 23 and 0 <= int(m) <= 59):
                    raise ValueError
        except ValueError:
            continue  # malformed windows are ignored (and reported by the status endpoint)
        out.append(part)
    return tuple(out)


def policy_from_settings(settings: Any) -> ProtectionPolicy:
    """Build the policy from Settings (``cps_*`` fields); unknown/invalid values fall back safely."""
    defaults = ProtectionPolicy()
    values: dict[str, Any] = {}
    clamped: list[str] = []
    for name in HARD_LIMITS:
        raw = getattr(settings, f"cps_{name}", getattr(defaults, name))
        value, was_clamped = _coerce(name, raw, getattr(defaults, name))
        values[name] = value
        if was_clamped:
            clamped.append(name)
    # The emergency thresholds may never sit below the ordinary halt thresholds.
    if values["emergency_drawdown_pct"] < values["max_drawdown_pct"]:
        values["emergency_drawdown_pct"] = values["max_drawdown_pct"]
        clamped.append("emergency_drawdown_pct")
    if values["emergency_daily_loss_pct"] < values["max_daily_loss_pct"]:
        values["emergency_daily_loss_pct"] = values["max_daily_loss_pct"]
        clamped.append("emergency_daily_loss_pct")
    if values["min_stop_distance_pct"] >= values["max_stop_distance_pct"]:
        values["min_stop_distance_pct"] = defaults.min_stop_distance_pct
        values["max_stop_distance_pct"] = defaults.max_stop_distance_pct
        clamped.append("stop_distance_bounds")
    for flag in (
        "session_restrictions_enabled", "news_calendar_required_for_live",
        "require_strategy_attribution_live", "auto_liquidate_on_stop_breach",
        "auto_liquidate_on_emergency",
    ):
        values[flag] = bool(getattr(settings, f"cps_{flag}", getattr(defaults, flag)))
    values["blocked_windows_utc"] = parse_windows(getattr(settings, "cps_blocked_windows_utc", ""))
    allowed = {f.name for f in fields(ProtectionPolicy)}
    return ProtectionPolicy(**{k: v for k, v in values.items() if k in allowed}, clamped=tuple(clamped))

"""ETI CAPITAL PROTECTION SYSTEM — decision core.

Capital preservation is mandatory. This module is the final, independent veto on
every order that could add risk. It is pure (standard library only, no I/O, no
database, no network) so it is deterministic and unit-testable.

Independence guarantees (enforced by tests/test_capital_protection_independence.py):
- It imports nothing from the language-model council, the signal engines or the
  adaptive-edge package, so those components cannot influence or replace it.
- The policy comes only from server configuration (see protection_policy.py).
- Order intents carry no override field; anything in a request's free-form
  metadata is ignored here.
- Any internal error results in a refusal (fail closed).
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, time, timedelta, timezone
from enum import Enum
from typing import Any, Iterable, Mapping, Optional

from app.risk.protection_policy import ProtectionPolicy

SYSTEM_NAME = "ETI CAPITAL PROTECTION SYSTEM"
EPS = 1e-9


class Rule(str, Enum):
    INVALID_INPUT = "INVALID_INPUT"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    HALTED = "HALTED"
    EQUITY_UNKNOWN = "EQUITY_UNKNOWN"
    STOP_LOSS_REQUIRED = "STOP_LOSS_REQUIRED"
    STOP_LOSS_INVALID = "STOP_LOSS_INVALID"
    TAKE_PROFIT_INVALID = "TAKE_PROFIT_INVALID"
    RISK_PER_TRADE = "RISK_PER_TRADE"
    POSITION_NOTIONAL = "POSITION_NOTIONAL"
    LEVERAGE = "LEVERAGE"
    CORRELATED_EXPOSURE = "CORRELATED_EXPOSURE"
    MAX_OPEN_POSITIONS = "MAX_OPEN_POSITIONS"
    DAILY_LOSS = "DAILY_LOSS"
    WEEKLY_LOSS = "WEEKLY_LOSS"
    DRAWDOWN = "DRAWDOWN"
    CONSECUTIVE_LOSSES = "CONSECUTIVE_LOSSES"
    EXTREME_VOLATILITY = "EXTREME_VOLATILITY"
    SESSION_RESTRICTED = "SESSION_RESTRICTED"
    NEWS_BLACKOUT = "NEWS_BLACKOUT"
    NEWS_CALENDAR_UNAVAILABLE = "NEWS_CALENDAR_UNAVAILABLE"
    STRATEGY_QUARANTINED = "STRATEGY_QUARANTINED"
    STRATEGY_UNREGISTERED = "STRATEGY_UNREGISTERED"
    STRATEGY_ATTRIBUTION_REQUIRED = "STRATEGY_ATTRIBUTION_REQUIRED"
    ORDER_FLIPS_POSITION = "ORDER_FLIPS_POSITION"
    ACCOUNT_STATE_UNAVAILABLE = "ACCOUNT_STATE_UNAVAILABLE"


# --------------------------------------------------------------------------- inputs
@dataclass(frozen=True)
class OpenPosition:
    provider: str
    symbol: str
    side: str  # long | short
    qty: float
    price: float  # latest mark, else entry
    avg_entry: float = 0.0
    stop_loss: Optional[float] = None
    strategy_id: Optional[str] = None

    @property
    def notional(self) -> float:
        return abs(self.qty) * abs(self.price)

    @property
    def signed_notional(self) -> float:
        return self.notional if self.side == "long" else -self.notional


@dataclass(frozen=True)
class AccountSnapshot:
    equity: float
    peak_equity: float
    daily_pnl_pct: float = 0.0
    weekly_pnl_pct: float = 0.0
    drawdown_pct: float = 0.0
    positions: tuple[OpenPosition, ...] = ()
    consecutive_losses: int = 0
    last_loss_at: Optional[datetime] = None
    halted: bool = False
    halt_reason: str = ""
    source: str = "database"  # database | caller


@dataclass(frozen=True)
class OrderIntent:
    provider: str
    environment: str  # paper | testnet | live
    symbol: str
    side: str  # buy | sell
    qty: float
    price: Optional[float] = None  # limit price, else reference (last quote)
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    strategy_id: Optional[str] = None
    atr_pct: Optional[float] = None  # ATR as % of price on the strategy timeframe
    order_type: str = "market"
    source: str = "api"  # informational only; never relaxes a rule


@dataclass(frozen=True)
class NewsEvent:
    title: str
    at: datetime
    impact: str = "high"  # high | medium | low
    scope: tuple[str, ...] = ("*",)


@dataclass(frozen=True)
class NewsContext:
    status: str = "not_configured"  # ok | stale | unavailable | not_configured
    events: tuple[NewsEvent, ...] = ()


@dataclass(frozen=True)
class StrategyGate:
    """Status per registered strategy id (ACTIVE / QUARANTINED / UNDER_REVIEW / REVALIDATING)."""

    statuses: Mapping[str, str] = field(default_factory=dict)

    def status_of(self, strategy_id: str) -> Optional[str]:
        return self.statuses.get(strategy_id)


# --------------------------------------------------------------------------- outputs
@dataclass
class ProtectionVerdict:
    approved: bool
    mode: str  # NORMAL | REDUCE_ONLY | HALTED
    reasons: list[str]
    violations: list[str]
    reduces_exposure: bool
    max_allowed_qty: Optional[float]
    sizing: dict[str, Any]
    metrics: dict[str, Any]
    policy_fingerprint: str
    evaluated_at: str
    system: str = SYSTEM_NAME

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EmergencyAssessment:
    triggered: bool
    reasons: list[str]
    codes: list[str]


# --------------------------------------------------------------------------- symbols / groups
_QUOTES = ("FDUSD", "USDT", "USDC", "BUSD", "TUSD", "USD", "EUR", "GBP", "BTC", "ETH", "BNB")

_EQUITY_GROUPS: dict[str, frozenset[str]] = {
    "us_mega_cap_tech": frozenset({"AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NFLX", "TSLA", "ORCL", "CRM", "ADBE"}),
    "us_semiconductors": frozenset({"NVDA", "AMD", "AVGO", "INTC", "TSM", "QCOM", "MU", "ASML", "AMAT", "LRCX", "SMH", "SOXX"}),
    "us_banks": frozenset({"JPM", "BAC", "WFC", "C", "GS", "MS", "XLF", "KRE"}),
    "us_energy": frozenset({"XOM", "CVX", "COP", "OXY", "SLB", "XLE", "USO"}),
    "us_broad_index": frozenset({"SPY", "VOO", "IVV", "QQQ", "IWM", "DIA", "VTI"}),
    "precious_metals": frozenset({"GLD", "IAU", "SLV", "GDX"}),
}


def normalize_symbol(symbol: str) -> str:
    return "".join(ch for ch in (symbol or "").upper() if ch.isalnum())


def split_symbol(symbol: str) -> tuple[str, str]:
    """Best-effort (base, quote). 'BTCUSDT' -> ('BTC','USDT'); 'BTC/USD' -> ('BTC','USD'); 'AAPL' -> ('AAPL','')."""
    raw = (symbol or "").upper().strip()
    for sep in ("/", "-", "_"):
        if sep in raw:
            base, _, quote = raw.partition(sep)
            return normalize_symbol(base), normalize_symbol(quote)
    s = normalize_symbol(raw)
    for q in _QUOTES:
        if s.endswith(q) and len(s) - len(q) >= 2:
            return s[: -len(q)], q
    return s, ""


def asset_class(provider: str, symbol: str) -> str:
    provider = (provider or "").lower()
    if provider == "oanda":
        return "forex"
    if provider == "binance":
        return "crypto"
    base, quote = split_symbol(symbol)
    if "/" in (symbol or "") and quote in ("USD", "USDT", "USDC", "BTC", "EUR"):
        return "crypto"
    return "equity"


def correlation_group(provider: str, symbol: str, extra: Optional[Mapping[str, Iterable[str]]] = None) -> str:
    """Static correlation buckets. Every crypto pair shares one bucket: crypto assets move together in stress.

    This is a heuristic, not a computed correlation matrix; unknown equities form their own bucket.
    """
    base, _ = split_symbol(symbol)
    if (provider or "").lower() == "oanda":
        return f"forex:{base}"  # a currency's exposure is netted across its pairs by base currency
    for group, members in (extra or {}).items():
        if base in {m.upper() for m in members}:
            return group
    if asset_class(provider, symbol) == "crypto":
        return "crypto"
    for group, members in _EQUITY_GROUPS.items():
        if base in members:
            return group
    return f"equity:{base}"


# --------------------------------------------------------------------------- helpers
def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def volatility_scale(atr_pct: Optional[float], policy: ProtectionPolicy) -> float:
    """Risk multiplier in (0,1]: calm markets keep full risk, volatile markets shrink it."""
    if atr_pct is None or not _finite(atr_pct) or atr_pct <= 0:
        return policy.missing_volatility_scale
    return max(policy.min_volatility_scale, min(1.0, policy.target_volatility_pct / atr_pct))


def streak_scale(account: AccountSnapshot, policy: ProtectionPolicy) -> float:
    n = policy.max_consecutive_losses
    if n > 1 and account.consecutive_losses >= n - 1:
        return policy.loss_streak_scale
    return 1.0


def _in_window(now_utc: datetime, window: str) -> bool:
    a, b = window.split("-")
    ah, am = (int(x) for x in a.split(":"))
    bh, bm = (int(x) for x in b.split(":"))
    t = now_utc.time()
    start, end = time(ah, am), time(bh, bm)
    if start <= end:
        return start <= t < end
    return t >= start or t < end  # wraps midnight


def session_violation(intent_asset: str, now: datetime, policy: ProtectionPolicy) -> Optional[str]:
    if not policy.session_restrictions_enabled:
        return None
    now_utc = _aware(now).astimezone(timezone.utc)
    for window in policy.blocked_windows_utc:
        if _in_window(now_utc, window):
            return f"Trading blocked in configured window {window} UTC"
    if intent_asset == "equity":
        try:
            from zoneinfo import ZoneInfo

            ny = now_utc.astimezone(ZoneInfo("America/New_York"))
        except Exception:  # tzdata unavailable -> fail closed for equities
            return "Equity session calendar unavailable (timezone data missing)"
        if ny.weekday() >= 5:
            return "US equity market closed (weekend)"
        buf = timedelta(minutes=policy.equity_session_buffer_minutes)
        day = ny.replace(hour=0, minute=0, second=0, microsecond=0)
        open_at = day + timedelta(hours=9, minutes=30) + buf
        close_at = day + timedelta(hours=16) - buf
        if not (open_at <= ny < close_at):
            return (
                f"Outside US equity session ({open_at.strftime('%H:%M')}-{close_at.strftime('%H:%M')} ET, "
                f"{policy.equity_session_buffer_minutes} min buffer after open / before close)"
            )
    return None


def news_violation(intent: OrderIntent, now: datetime, news: NewsContext, policy: ProtectionPolicy) -> Optional[tuple[Rule, str]]:
    env = intent.environment.lower()
    if env == "live" and policy.news_calendar_required_for_live and news.status != "ok":
        return Rule.NEWS_CALENDAR_UNAVAILABLE, f"News calendar status is '{news.status}'; live orders require a fresh calendar"
    base, quote = split_symbol(intent.symbol)
    tokens = {base, quote, normalize_symbol(intent.symbol), asset_class(intent.provider, intent.symbol).upper()} - {""}
    now_utc = _aware(now)
    before = timedelta(minutes=policy.news_blackout_before_minutes)
    after = timedelta(minutes=policy.news_blackout_after_minutes)
    for ev in news.events:
        if ev.impact.lower() != "high":
            continue
        scope = {s.upper() for s in ev.scope}
        if "*" not in scope and not (scope & tokens):
            continue
        at = _aware(ev.at)
        if at - before <= now_utc <= at + after:
            return Rule.NEWS_BLACKOUT, f"High-impact news blackout: '{ev.title}' at {at.isoformat()}"
    return None


# --------------------------------------------------------------------------- sizing
def size_position(
    *,
    intent: OrderIntent,
    price: float,
    account: AccountSnapshot,
    policy: ProtectionPolicy,
    groups: Optional[Mapping[str, Iterable[str]]] = None,
) -> dict[str, Any]:
    """Largest quantity the policy allows for a new entry (volatility-adjusted fixed-fractional sizing).

    Returns the binding constraint so callers can see why the size is what it is.
    """
    equity = account.equity
    out: dict[str, Any] = {"max_qty": 0.0, "binding_constraint": None, "components": {}}
    if equity <= 0 or price <= 0 or intent.stop_loss is None:
        return out
    stop_distance = abs(price - intent.stop_loss)
    v_scale = volatility_scale(intent.atr_pct, policy)
    s_scale = streak_scale(account, policy)
    effective_risk_pct = policy.max_risk_per_trade_pct * v_scale * s_scale
    comps: dict[str, float] = {}
    if stop_distance > 0:
        comps["risk"] = equity * effective_risk_pct / 100.0 / stop_distance
    sym = normalize_symbol(intent.symbol)
    same_dir_existing = sum(
        p.notional for p in account.positions
        if normalize_symbol(p.symbol) == sym and (p.side == "long") == (intent.side == "buy")
    )
    comps["notional"] = max(0.0, equity * policy.max_position_notional_pct / 100.0 - same_dir_existing) / price
    gross = sum(p.notional for p in account.positions)
    comps["leverage"] = max(0.0, equity * policy.max_leverage - gross) / price
    grp = correlation_group(intent.provider, intent.symbol, groups)
    net = sum(p.signed_notional for p in account.positions if correlation_group(p.provider, p.symbol, groups) == grp)
    cap = equity * policy.max_correlated_exposure_pct / 100.0
    headroom = (cap - net) if intent.side == "buy" else (cap + net)
    comps["correlation"] = max(0.0, headroom) / price
    binding = min(comps, key=lambda k: comps[k]) if comps else None
    out.update(
        max_qty=max(0.0, comps[binding]) if binding else 0.0,
        binding_constraint=binding,
        components={k: round(v, 10) for k, v in comps.items()},
        volatility_scale=round(v_scale, 4),
        loss_streak_scale=s_scale,
        effective_max_risk_pct=round(effective_risk_pct, 6),
        correlation_group=grp,
    )
    return out


# --------------------------------------------------------------------------- core evaluation
def _refuse(policy: ProtectionPolicy, now: datetime, code: Rule, reason: str, **extra: Any) -> ProtectionVerdict:
    return ProtectionVerdict(
        approved=False, mode=extra.get("mode", "NORMAL"), reasons=[reason], violations=[code.value],
        reduces_exposure=False, max_allowed_qty=0.0, sizing={}, metrics=extra.get("metrics", {}),
        policy_fingerprint=policy.fingerprint, evaluated_at=_aware(now).isoformat(),
    )


def evaluate_order(
    intent: OrderIntent,
    account: AccountSnapshot,
    policy: ProtectionPolicy,
    *,
    now: Optional[datetime] = None,
    news: Optional[NewsContext] = None,
    strategies: Optional[StrategyGate] = None,
    groups: Optional[Mapping[str, Iterable[str]]] = None,
) -> ProtectionVerdict:
    now = _aware(now or datetime.now(timezone.utc))
    news = news or NewsContext()
    strategies = strategies or StrategyGate()

    # ---- 0. input sanity (fail closed on anything non-finite / malformed)
    if intent.side not in ("buy", "sell"):
        return _refuse(policy, now, Rule.INVALID_INPUT, "Side must be buy or sell")
    if not _finite(intent.qty) or intent.qty <= 0:
        return _refuse(policy, now, Rule.INVALID_INPUT, "Quantity must be a positive finite number")
    if intent.environment.lower() not in ("paper", "testnet", "live"):
        return _refuse(policy, now, Rule.INVALID_INPUT, "Environment must be paper, testnet or live")
    for name in ("price", "stop_loss", "take_profit", "atr_pct"):
        v = getattr(intent, name)
        if v is not None and (not _finite(v) or v <= 0):
            return _refuse(policy, now, Rule.INVALID_INPUT, f"{name} must be a positive finite number when provided")

    sym = normalize_symbol(intent.symbol)
    price = intent.price
    existing = next(
        (p for p in account.positions
         if normalize_symbol(p.symbol) == sym and p.provider.lower() == intent.provider.lower()),
        None,
    )
    opposite = existing is not None and ((existing.side == "long") == (intent.side == "sell"))
    reduces = bool(opposite and intent.qty <= existing.qty + EPS)
    metrics: dict[str, Any] = {
        "equity": account.equity, "peak_equity": account.peak_equity,
        "daily_pnl_pct": round(account.daily_pnl_pct, 4), "weekly_pnl_pct": round(account.weekly_pnl_pct, 4),
        "drawdown_pct": round(account.drawdown_pct, 4), "open_positions": len({normalize_symbol(p.symbol) for p in account.positions}),
        "consecutive_losses": account.consecutive_losses, "account_state_source": account.source,
    }

    # ---- 1. exits that genuinely reduce an existing position are always allowed
    if reduces:
        return ProtectionVerdict(
            approved=True, mode="HALTED" if account.halted else "REDUCE_ONLY",
            reasons=["Order reduces an existing position; exit orders are never blocked by capital protection"],
            violations=[], reduces_exposure=True, max_allowed_qty=existing.qty, sizing={}, metrics=metrics,
            policy_fingerprint=policy.fingerprint, evaluated_at=now.isoformat(),
        )

    violations: list[tuple[Rule, str]] = []

    if opposite and not reduces:
        violations.append((Rule.ORDER_FLIPS_POSITION, "Order is larger than the open opposite position; submit a close and a new entry separately"))

    # ---- 2. latched halt
    if account.halted:
        violations.append((Rule.HALTED, f"Trading halted by capital protection: {account.halt_reason or 'emergency'}; only exits are permitted"))

    if account.source == "unavailable":
        violations.append((Rule.ACCOUNT_STATE_UNAVAILABLE, "Account state could not be determined"))

    equity = account.equity
    if not _finite(equity) or equity <= 0:
        violations.append((Rule.EQUITY_UNKNOWN, "Account equity unknown or non-positive; cannot size risk"))

    # ---- 3. loss / drawdown limits (entries only)
    if account.daily_pnl_pct <= -policy.max_daily_loss_pct + EPS:
        violations.append((Rule.DAILY_LOSS, f"Daily loss limit reached ({account.daily_pnl_pct:.2f}% <= -{policy.max_daily_loss_pct}%)"))
    if account.weekly_pnl_pct <= -policy.max_weekly_loss_pct + EPS:
        violations.append((Rule.WEEKLY_LOSS, f"Weekly loss limit reached ({account.weekly_pnl_pct:.2f}% <= -{policy.max_weekly_loss_pct}%)"))
    if account.drawdown_pct >= policy.max_drawdown_pct - EPS:
        violations.append((Rule.DRAWDOWN, f"Portfolio drawdown limit reached ({account.drawdown_pct:.2f}% >= {policy.max_drawdown_pct}%)"))

    # ---- 4. consecutive-loss protection
    if account.consecutive_losses >= policy.max_consecutive_losses and account.last_loss_at is not None:
        resume = _aware(account.last_loss_at) + timedelta(minutes=policy.consecutive_loss_cooldown_minutes)
        if now < resume:
            violations.append((
                Rule.CONSECUTIVE_LOSSES,
                f"{account.consecutive_losses} consecutive losses; cooling off until {resume.isoformat()}",
            ))

    # ---- 5. position count
    open_symbols = {normalize_symbol(p.symbol) for p in account.positions}
    if existing is None and len(open_symbols) >= policy.max_open_positions:
        violations.append((Rule.MAX_OPEN_POSITIONS, f"Max open positions reached ({len(open_symbols)}/{policy.max_open_positions})"))

    # ---- 6. price, stop-loss enforcement, volatility
    if price is None:
        violations.append((Rule.INVALID_INPUT, "A reference or limit price is required to measure risk"))
    sizing: dict[str, Any] = {}
    if price is not None:
        if intent.stop_loss is None:
            violations.append((Rule.STOP_LOSS_REQUIRED, "Every new position requires a stop-loss"))
        else:
            long_side = intent.side == "buy"
            if (long_side and intent.stop_loss >= price) or (not long_side and intent.stop_loss <= price):
                violations.append((Rule.STOP_LOSS_INVALID, "Stop-loss must be below entry for longs and above entry for shorts"))
            else:
                dist_pct = abs(price - intent.stop_loss) / price * 100.0
                metrics["stop_distance_pct"] = round(dist_pct, 4)
                if dist_pct < policy.min_stop_distance_pct:
                    violations.append((Rule.STOP_LOSS_INVALID, f"Stop distance {dist_pct:.3f}% below minimum {policy.min_stop_distance_pct}%"))
                if dist_pct > policy.max_stop_distance_pct:
                    violations.append((Rule.STOP_LOSS_INVALID, f"Stop distance {dist_pct:.2f}% exceeds maximum {policy.max_stop_distance_pct}%"))
                if intent.atr_pct and dist_pct < policy.min_stop_atr_multiple * intent.atr_pct:
                    violations.append((Rule.STOP_LOSS_INVALID, f"Stop is inside normal noise ({dist_pct:.2f}% < {policy.min_stop_atr_multiple}x ATR {intent.atr_pct:.2f}%)"))
        if intent.take_profit is not None:
            ok = intent.take_profit > price if intent.side == "buy" else intent.take_profit < price
            if not ok:
                violations.append((Rule.TAKE_PROFIT_INVALID, "Take-profit must be on the profit side of entry"))
        if intent.atr_pct is not None and intent.atr_pct >= policy.extreme_volatility_pct:
            violations.append((Rule.EXTREME_VOLATILITY, f"Volatility {intent.atr_pct:.2f}% >= extreme threshold {policy.extreme_volatility_pct}%; no new entries"))

    # ---- 7. exposure and risk sizing (needs equity, price and a usable stop)
    if _finite(equity) and equity > 0 and price is not None:
        notional = intent.qty * price
        same_dir_existing = sum(
            p.notional for p in account.positions
            if normalize_symbol(p.symbol) == sym and (p.side == "long") == (intent.side == "buy")
        )
        symbol_pct = (notional + same_dir_existing) / equity * 100.0
        metrics["symbol_notional_pct_after"] = round(symbol_pct, 4)
        if symbol_pct > policy.max_position_notional_pct + EPS:
            violations.append((Rule.POSITION_NOTIONAL, f"Position notional {symbol_pct:.2f}% exceeds max {policy.max_position_notional_pct}% of equity"))
        gross_after = sum(p.notional for p in account.positions) + notional
        leverage_after = gross_after / equity
        metrics["leverage_after"] = round(leverage_after, 4)
        if leverage_after > policy.max_leverage + EPS:
            violations.append((Rule.LEVERAGE, f"Leverage {leverage_after:.2f}x would exceed max {policy.max_leverage}x"))
        grp = correlation_group(intent.provider, intent.symbol, groups)
        net = sum(p.signed_notional for p in account.positions if correlation_group(p.provider, p.symbol, groups) == grp)
        delta = notional if intent.side == "buy" else -notional
        net_after_pct = abs(net + delta) / equity * 100.0
        metrics["correlated_group"] = grp
        metrics["correlated_exposure_pct_after"] = round(net_after_pct, 4)
        if net_after_pct > policy.max_correlated_exposure_pct + EPS and abs(net + delta) > abs(net) + EPS:
            violations.append((Rule.CORRELATED_EXPOSURE, f"Correlated exposure in '{grp}' would be {net_after_pct:.2f}% (max {policy.max_correlated_exposure_pct}%)"))
        if intent.stop_loss is not None and intent.stop_loss > 0:
            sizing = size_position(intent=intent, price=price, account=account, policy=policy, groups=groups)
            risk_pct = intent.qty * abs(price - intent.stop_loss) / equity * 100.0
            metrics["risk_per_trade_pct"] = round(risk_pct, 6)
            allowed = sizing.get("effective_max_risk_pct", policy.max_risk_per_trade_pct)
            if risk_pct > allowed + EPS:
                violations.append((Rule.RISK_PER_TRADE, f"Risk per trade {risk_pct:.3f}% exceeds volatility-adjusted limit {allowed:.3f}%"))

    # ---- 8. session and news restrictions
    sv = session_violation(asset_class(intent.provider, intent.symbol), now, policy)
    if sv:
        violations.append((Rule.SESSION_RESTRICTED, sv))
    nv = news_violation(intent, now, news, policy)
    if nv:
        violations.append(nv)

    # ---- 9. strategy attribution and quarantine
    if intent.strategy_id:
        status = strategies.status_of(intent.strategy_id)
        if status is None:
            # Unregistered strategies have no validated expectations: never live. Paper/testnet is allowed so
            # that the evidence needed to register them can be collected.
            if intent.environment.lower() == "live":
                violations.append((Rule.STRATEGY_UNREGISTERED, f"Strategy '{intent.strategy_id}' is not registered with capital protection; live trading requires registration"))
        elif status == "REVALIDATING" and intent.environment.lower() in ("paper", "testnet"):
            pass  # human-approved revalidation may collect evidence on paper/testnet only, never live
        elif status != "ACTIVE":
            violations.append((Rule.STRATEGY_QUARANTINED, f"Strategy '{intent.strategy_id}' is {status}; it may not open positions until reviewed and revalidated"))
    elif intent.environment.lower() == "live" and policy.require_strategy_attribution_live:
        violations.append((Rule.STRATEGY_ATTRIBUTION_REQUIRED, "Live orders must name a registered, active strategy"))

    approved = not violations
    max_qty = sizing.get("max_qty") if sizing else None
    return ProtectionVerdict(
        approved=approved,
        mode="HALTED" if account.halted else "NORMAL",
        reasons=["All capital-protection checks passed"] if approved else [r for _, r in violations],
        violations=[c.value for c, _ in violations],
        reduces_exposure=False,
        max_allowed_qty=max_qty,
        sizing=sizing,
        metrics=metrics,
        policy_fingerprint=policy.fingerprint,
        evaluated_at=now.isoformat(),
    )


def evaluate_order_safe(*args: Any, **kwargs: Any) -> ProtectionVerdict:
    """Fail-closed wrapper: any unexpected exception becomes a refusal, never an approval."""
    policy = kwargs.get("policy") or (args[2] if len(args) > 2 else None) or ProtectionPolicy()
    now = kwargs.get("now") or datetime.now(timezone.utc)
    try:
        return evaluate_order(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 — deliberate: capital protection must never approve on error
        return _refuse(policy, now, Rule.INTERNAL_ERROR, f"Capital protection error ({type(exc).__name__}); order refused")


# --------------------------------------------------------------------------- emergency rules
def assess_emergency(account: AccountSnapshot, policy: ProtectionPolicy) -> EmergencyAssessment:
    reasons: list[str] = []
    codes: list[str] = []
    if account.equity <= 0 and account.source != "unavailable":
        reasons.append("Account equity is zero or negative")
        codes.append("EQUITY_DEPLETED")
    if account.drawdown_pct >= policy.emergency_drawdown_pct - EPS:
        reasons.append(f"Drawdown {account.drawdown_pct:.2f}% >= emergency threshold {policy.emergency_drawdown_pct}%")
        codes.append("EMERGENCY_DRAWDOWN")
    if account.daily_pnl_pct <= -policy.emergency_daily_loss_pct + EPS:
        reasons.append(f"Daily loss {account.daily_pnl_pct:.2f}% <= -{policy.emergency_daily_loss_pct}% emergency threshold")
        codes.append("EMERGENCY_DAILY_LOSS")
    return EmergencyAssessment(bool(codes), reasons, codes)


def find_stop_breaches(positions: Iterable[OpenPosition]) -> list[OpenPosition]:
    out = []
    for p in positions:
        if p.stop_loss is None or p.qty <= 0 or not _finite(p.price):
            continue
        if (p.side == "long" and p.price <= p.stop_loss) or (p.side == "short" and p.price >= p.stop_loss):
            out.append(p)
    return out


def find_unprotected(positions: Iterable[OpenPosition]) -> list[OpenPosition]:
    return [p for p in positions if p.stop_loss is None and p.qty > 0]


def default_stop_for(position: OpenPosition, policy: ProtectionPolicy) -> float:
    """Protective stop for a legacy position that has none: max allowed stop distance from entry."""
    entry = position.avg_entry or position.price
    frac = policy.max_stop_distance_pct / 100.0
    return entry * (1 - frac) if position.side == "long" else entry * (1 + frac)


def liquidation_intents(
    positions: Iterable[OpenPosition], environment: str, *, source: str = "system"
) -> list[OrderIntent]:
    """Reduce-only exit orders that flatten the given positions (market orders, closing side)."""
    out = []
    for p in positions:
        if p.qty <= 0:
            continue
        out.append(OrderIntent(
            provider=p.provider, environment=environment, symbol=p.symbol,
            side="sell" if p.side == "long" else "buy", qty=p.qty, price=p.price,
            strategy_id=p.strategy_id, order_type="market", source=source,
        ))
    return out

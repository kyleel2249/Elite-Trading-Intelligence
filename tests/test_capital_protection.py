"""ETI CAPITAL PROTECTION SYSTEM — decision core (pure logic, no database)."""
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.risk.protection import (
    AccountSnapshot, NewsContext, NewsEvent, OpenPosition, OrderIntent, Rule, StrategyGate,
    assess_emergency, default_stop_for, evaluate_order, evaluate_order_safe, find_stop_breaches,
    find_unprotected, liquidation_intents, size_position, volatility_scale,
)
from app.risk.protection_policy import HARD_LIMITS, ProtectionPolicy, policy_from_settings

POLICY = ProtectionPolicy()
WED_1500 = datetime(2026, 11, 11, 15, 0, tzinfo=timezone.utc)  # 10:00 ET (EST)


def acct(**kw):
    base = dict(equity=10_000.0, peak_equity=10_000.0)
    base.update(kw)
    return AccountSnapshot(**base)


def buy(**kw):
    base = dict(provider="binance", environment="paper", symbol="BTCUSDT", side="buy", qty=5.0,
                price=100.0, stop_loss=98.0, atr_pct=2.0)
    base.update(kw)
    return OrderIntent(**base)


def pos(symbol="ETHUSDT", qty=15.0, price=100.0, side="long", provider="binance", stop=90.0, **kw):
    return OpenPosition(provider=provider, symbol=symbol, side=side, qty=qty, price=price,
                        avg_entry=price, stop_loss=stop, **kw)


def run(intent, account=None, policy=POLICY, **kw):
    kw.setdefault("now", WED_1500)
    return evaluate_order(intent, account or acct(), policy, **kw)


def codes(v):
    return set(v.violations)


# ------------------------------------------------------------------ baseline / refusal
def test_conservative_entry_is_approved():
    v = run(buy())
    assert v.approved and v.violations == [] and v.mode == "NORMAL"
    assert v.policy_fingerprint == POLICY.fingerprint


def test_default_limits_are_conservative():
    p = ProtectionPolicy()
    assert p.max_risk_per_trade_pct <= 0.5 and p.max_daily_loss_pct <= 2.0 and p.max_weekly_loss_pct <= 5.0
    assert p.max_drawdown_pct <= 10.0 and p.max_open_positions <= 5 and p.max_leverage == 1.0
    assert p.max_consecutive_losses == 3 and p.auto_liquidate_on_stop_breach and p.auto_liquidate_on_emergency


@pytest.mark.parametrize("bad", [
    dict(qty=0), dict(qty=-1), dict(qty=float("nan")), dict(qty=float("inf")), dict(side="hold"),
    dict(environment="mainnet"), dict(price=-5.0), dict(stop_loss=float("nan")),
])
def test_malformed_orders_are_refused(bad):
    v = run(buy(**bad))
    assert not v.approved and Rule.INVALID_INPUT.value in codes(v)


def test_internal_error_fails_closed():
    v = evaluate_order_safe(buy(), None, POLICY, now=WED_1500)  # account=None blows up inside
    assert not v.approved and codes(v) == {Rule.INTERNAL_ERROR.value}


# ------------------------------------------------------------------ per-trade risk, notional, sizing
def test_notional_cap_binds_before_risk():
    assert run(buy(qty=6.0)).approved
    v = run(buy(qty=6.01))
    assert Rule.POSITION_NOTIONAL.value in codes(v) and not v.approved


def test_risk_per_trade_is_volatility_adjusted():
    # 8% ATR -> risk scale 0.25 -> 0.125% allowed = $12.5; stop distance $8 -> max 1.5625 units
    base = dict(price=100.0, stop_loss=92.0, atr_pct=8.0)
    assert run(buy(qty=1.5, **base)).approved
    v = run(buy(qty=1.7, **base))
    assert Rule.RISK_PER_TRADE.value in codes(v)
    s = size_position(intent=buy(**base), price=100.0, account=acct(), policy=POLICY)
    assert s["binding_constraint"] == "risk" and s["max_qty"] == pytest.approx(1.5625)


def test_sizing_without_volatility_is_halved():
    assert volatility_scale(None, POLICY) == POLICY.missing_volatility_scale == 0.5
    assert volatility_scale(1.0, POLICY) == 1.0          # calm markets never scale above 1
    assert volatility_scale(100.0, POLICY) == POLICY.min_volatility_scale


def test_extreme_volatility_blocks_entries():
    v = run(buy(atr_pct=15.0, stop_loss=90.0))
    assert Rule.EXTREME_VOLATILITY.value in codes(v)


# ------------------------------------------------------------------ stop-loss enforcement
def test_stop_loss_is_mandatory():
    v = run(buy(stop_loss=None))
    assert codes(v) >= {Rule.STOP_LOSS_REQUIRED.value} and not v.approved


@pytest.mark.parametrize("stop", [101.0, 99.95, 80.0])
def test_invalid_stops_refused(stop):
    assert Rule.STOP_LOSS_INVALID.value in codes(run(buy(stop_loss=stop)))


def test_stop_inside_atr_noise_refused():
    assert Rule.STOP_LOSS_INVALID.value in codes(run(buy(stop_loss=99.0, atr_pct=4.0)))


def test_short_entry_needs_stop_above_price():
    ok = run(buy(side="sell", stop_loss=102.0))
    assert ok.approved
    assert Rule.STOP_LOSS_INVALID.value in codes(run(buy(side="sell", stop_loss=98.0)))


def test_take_profit_must_be_on_profit_side():
    assert Rule.TAKE_PROFIT_INVALID.value in codes(run(buy(take_profit=95.0)))
    assert run(buy(take_profit=110.0)).approved


# ------------------------------------------------------------------ loss limits
def test_daily_loss_limit():
    assert run(buy(), acct(daily_pnl_pct=-1.99)).approved
    assert Rule.DAILY_LOSS.value in codes(run(buy(), acct(daily_pnl_pct=-2.0)))


def test_weekly_loss_limit():
    assert Rule.WEEKLY_LOSS.value in codes(run(buy(), acct(weekly_pnl_pct=-5.0)))


def test_drawdown_limit():
    assert run(buy(), acct(drawdown_pct=9.9)).approved
    assert Rule.DRAWDOWN.value in codes(run(buy(), acct(drawdown_pct=10.0)))


# ------------------------------------------------------------------ consecutive losses
def test_consecutive_loss_cooldown():
    a = acct(consecutive_losses=3, last_loss_at=WED_1500 - timedelta(hours=1))
    v = run(buy(), a)
    assert Rule.CONSECUTIVE_LOSSES.value in codes(v)
    later = acct(consecutive_losses=3, last_loss_at=WED_1500 - timedelta(hours=5))
    assert run(buy(), later).approved  # cooldown (240 min) has elapsed, size is still halved


def test_loss_streak_halves_allowed_risk():
    s = size_position(intent=buy(stop_loss=92.0, atr_pct=2.0), price=100.0,
                      account=acct(consecutive_losses=2), policy=POLICY)
    assert s["loss_streak_scale"] == 0.5 and s["effective_max_risk_pct"] == pytest.approx(0.25)


# ------------------------------------------------------------------ positions / leverage / correlation
def test_max_open_positions():
    five = tuple(pos(symbol=f"AAA{i}", provider="alpaca", qty=1.0) for i in range(5))
    v = run(buy(), acct(positions=five))
    assert Rule.MAX_OPEN_POSITIONS.value in codes(v)
    assert Rule.MAX_OPEN_POSITIONS.value not in codes(run(buy(symbol="AAA0", provider="alpaca"), acct(positions=five)))


def test_leverage_cap():
    big = tuple(pos(symbol=s, provider="alpaca", qty=33.0) for s in ("AAPL", "JPM", "XOM"))  # $9,900 gross
    v = run(buy(), acct(positions=big))
    assert Rule.LEVERAGE.value in codes(v)


def test_correlated_crypto_exposure_cap():
    eth = (pos(symbol="ETHUSDT", qty=15.0),)  # 15% of equity in the crypto bucket
    assert run(buy(qty=5.0), acct(positions=eth)).approved           # exactly 20%
    v = run(buy(qty=5.5), acct(positions=eth))
    assert Rule.CORRELATED_EXPOSURE.value in codes(v)


def test_hedging_reduces_correlated_exposure():
    eth = (pos(symbol="ETHUSDT", qty=15.0),)
    v = run(buy(side="sell", stop_loss=102.0, qty=5.0), acct(positions=eth))
    assert Rule.CORRELATED_EXPOSURE.value not in codes(v)


# ------------------------------------------------------------------ halt and exits
def test_halt_blocks_entries_but_never_exits():
    held = (pos(symbol="BTCUSDT", qty=0.5),)
    a = acct(halted=True, halt_reason="drawdown", positions=held, daily_pnl_pct=-9.0, drawdown_pct=15.0)
    assert Rule.HALTED.value in codes(run(buy(), a))
    exit_v = run(buy(side="sell", qty=0.5, stop_loss=None, atr_pct=None), a)
    assert exit_v.approved and exit_v.reduces_exposure and exit_v.mode == "HALTED"


def test_partial_exit_allowed_flip_refused():
    held = (pos(symbol="BTCUSDT", qty=1.0),)
    assert run(buy(side="sell", qty=0.4, stop_loss=None), acct(positions=held)).reduces_exposure
    flip = run(buy(side="sell", qty=2.0, stop_loss=102.0), acct(positions=held))
    assert Rule.ORDER_FLIPS_POSITION.value in codes(flip) and not flip.approved


def test_unknown_account_state_refused():
    v = run(buy(), AccountSnapshot(equity=0.0, peak_equity=0.0, source="unavailable"))
    assert {Rule.ACCOUNT_STATE_UNAVAILABLE.value, Rule.EQUITY_UNKNOWN.value} <= codes(v)


# ------------------------------------------------------------------ sessions
def test_equity_session_and_weekend():
    aapl = dict(provider="alpaca", symbol="AAPL")
    assert run(buy(**aapl)).approved                                                   # 10:00 ET
    assert Rule.SESSION_RESTRICTED.value in codes(run(buy(**aapl), now=WED_1500.replace(hour=14, minute=40)))  # buffer after open
    assert Rule.SESSION_RESTRICTED.value in codes(run(buy(**aapl), now=WED_1500.replace(hour=21, minute=50)))  # buffer before close
    sat = datetime(2026, 11, 14, 15, 0, tzinfo=timezone.utc)
    assert Rule.SESSION_RESTRICTED.value in codes(run(buy(**aapl), now=sat))
    assert run(buy(), now=sat).approved  # crypto trades on weekends


def test_configured_blocked_windows_including_midnight_wrap():
    p = ProtectionPolicy(blocked_windows_utc=("14:00-15:30", "23:55-00:05"))
    assert Rule.SESSION_RESTRICTED.value in codes(run(buy(), policy=p))
    assert Rule.SESSION_RESTRICTED.value in codes(run(buy(), policy=p, now=WED_1500.replace(hour=0, minute=2)))
    assert run(buy(), policy=p, now=WED_1500.replace(hour=16)).approved


# ------------------------------------------------------------------ news
def test_high_impact_news_blackout():
    ev = NewsEvent("FOMC decision", WED_1500 + timedelta(minutes=10), "high", ("*",))
    news = NewsContext("ok", (ev,))
    assert Rule.NEWS_BLACKOUT.value in codes(run(buy(), news=news))
    after = NewsContext("ok", (NewsEvent("FOMC", WED_1500 - timedelta(minutes=45)),))
    assert run(buy(), news=after).approved
    low = NewsContext("ok", (NewsEvent("minor", WED_1500, "low"),))
    assert run(buy(), news=low).approved
    scoped = NewsContext("ok", (NewsEvent("AAPL earnings", WED_1500, "high", ("AAPL",)),))
    assert run(buy(), news=scoped).approved                           # does not touch BTC
    assert Rule.NEWS_BLACKOUT.value in codes(run(buy(provider="alpaca", symbol="AAPL"), news=scoped))


def test_live_requires_fresh_news_calendar():
    live = buy(environment="live", strategy_id="s1")
    gate = StrategyGate({"s1": "ACTIVE"})
    for status in ("not_configured", "stale", "unavailable"):
        v = run(live, news=NewsContext(status), strategies=gate)
        assert Rule.NEWS_CALENDAR_UNAVAILABLE.value in codes(v)
    assert run(live, news=NewsContext("ok"), strategies=gate).approved


# ------------------------------------------------------------------ strategy gate
def test_quarantined_strategy_cannot_open_positions():
    for status in ("QUARANTINED", "UNDER_REVIEW"):
        v = run(buy(strategy_id="s1"), strategies=StrategyGate({"s1": status}))
        assert Rule.STRATEGY_QUARANTINED.value in codes(v)
    assert run(buy(strategy_id="s1"), strategies=StrategyGate({"s1": "ACTIVE"})).approved


def test_revalidating_strategy_is_paper_only():
    gate = StrategyGate({"s1": "REVALIDATING"})
    assert run(buy(strategy_id="s1"), strategies=gate).approved
    live = buy(strategy_id="s1", environment="live")
    assert Rule.STRATEGY_QUARANTINED.value in codes(run(live, news=NewsContext("ok"), strategies=gate))


def test_unregistered_and_unattributed_live_orders_refused():
    ok_news = NewsContext("ok")
    assert Rule.STRATEGY_UNREGISTERED.value in codes(run(buy(environment="live", strategy_id="ghost"), news=ok_news))
    assert Rule.STRATEGY_ATTRIBUTION_REQUIRED.value in codes(run(buy(environment="live"), news=ok_news))
    assert run(buy(strategy_id="ghost")).approved  # paper evidence gathering is allowed


def test_quarantined_strategy_exit_still_allowed():
    held = (pos(symbol="BTCUSDT", qty=1.0),)
    v = run(buy(side="sell", qty=1.0, stop_loss=None, strategy_id="s1"), acct(positions=held),
            strategies=StrategyGate({"s1": "QUARANTINED"}))
    assert v.approved and v.reduces_exposure


# ------------------------------------------------------------------ emergency + stops
def test_emergency_rules():
    assert not assess_emergency(acct(drawdown_pct=11.9, daily_pnl_pct=-3.9), POLICY).triggered
    a = assess_emergency(acct(drawdown_pct=12.0), POLICY)
    assert a.triggered and "EMERGENCY_DRAWDOWN" in a.codes
    assert "EMERGENCY_DAILY_LOSS" in assess_emergency(acct(daily_pnl_pct=-4.0), POLICY).codes
    assert "EQUITY_DEPLETED" in assess_emergency(AccountSnapshot(equity=0.0, peak_equity=100.0), POLICY).codes


def test_stop_breach_detection_and_liquidation_intents():
    longp = pos(symbol="BTCUSDT", price=89.0, stop=90.0)
    shortp = pos(symbol="ETHUSDT", side="short", price=111.0, stop=110.0)
    safe = pos(symbol="SOLUSDT", price=100.0, stop=90.0)
    nostop = pos(symbol="XRPUSDT", stop=None)
    assert [p.symbol for p in find_stop_breaches([longp, shortp, safe, nostop])] == ["BTCUSDT", "ETHUSDT"]
    assert [p.symbol for p in find_unprotected([longp, nostop])] == ["XRPUSDT"]
    intents = liquidation_intents([longp, shortp], "paper")
    assert [(i.symbol, i.side, i.qty) for i in intents] == [("BTCUSDT", "sell", 15.0), ("ETHUSDT", "buy", 15.0)]


def test_default_stop_for_legacy_positions():
    assert default_stop_for(pos(side="long", price=100.0), POLICY) == pytest.approx(90.0)
    assert default_stop_for(pos(side="short", price=100.0), POLICY) == pytest.approx(110.0)


# ------------------------------------------------------------------ policy hardening
def test_policy_is_immutable_and_clamped():
    with pytest.raises(FrozenInstanceError):
        POLICY.max_leverage = 50.0  # type: ignore[misc]
    s = SimpleNamespace(cps_max_leverage=100, cps_max_risk_per_trade_pct=50, cps_max_open_positions=10**6,
                        cps_max_daily_loss_pct=float("nan"), cps_max_drawdown_pct=-4, cps_max_weekly_loss_pct="abc")
    p = policy_from_settings(s)
    assert p.max_leverage == HARD_LIMITS["max_leverage"][1] == 3.0
    assert p.max_risk_per_trade_pct == 2.0 and p.max_open_positions == 20
    assert p.max_daily_loss_pct == ProtectionPolicy().max_daily_loss_pct  # NaN falls back to the default
    assert p.max_drawdown_pct == HARD_LIMITS["max_drawdown_pct"][0]
    assert {"max_leverage", "max_risk_per_trade_pct", "max_open_positions"} <= set(p.clamped)


def test_emergency_thresholds_never_below_halt_thresholds():
    p = policy_from_settings(SimpleNamespace(cps_max_drawdown_pct=20.0, cps_emergency_drawdown_pct=5.0))
    assert p.emergency_drawdown_pct >= p.max_drawdown_pct


def test_policy_fingerprint_detects_change():
    assert ProtectionPolicy().fingerprint == ProtectionPolicy().fingerprint
    assert ProtectionPolicy().fingerprint != ProtectionPolicy(max_leverage=2.0).fingerprint


def test_blocked_window_parsing_ignores_malformed():
    p = policy_from_settings(SimpleNamespace(cps_blocked_windows_utc="23:55-00:05, junk, 25:00-26:00, 14:00-15:00"))
    assert p.blocked_windows_utc == ("23:55-00:05", "14:00-15:00")

"""ETI CAPITAL PROTECTION SYSTEM — database, TradingService and API integration."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.config import Settings, get_settings
from app.database import SessionLocal, init_db
from app.main import app
from app.models import (
    JournalEntry, OrderRecord, Position, ProtectionAuditRecord, ProtectionNewsEvent, ProtectionStateRecord,
    StrategyQuarantineRecord, StrategyTradeLog,
)
from app.risk.protection import OrderIntent
from app.risk.protection_service import CapitalProtectionService, authorize_admin
from app.risk.quarantine import HumanAuthorization, StrategyExpectations
from app.trading.protection_runner import run_protection_sweep
from app.trading.service import TradingService

ADMIN_KEY = "a-very-long-admin-secret-0123456789"
API_KEY = "a-different-general-api-key-9876543210"
EXP = StrategyExpectations(win_rate=0.55, profit_factor=1.6, expected_max_drawdown_pct=6.0,
                           max_drawdown_threshold_pct=10.0, validation_evidence="walk-forward report 2026-10-30")
TABLES = (ProtectionStateRecord, ProtectionNewsEvent, StrategyQuarantineRecord, StrategyTradeLog,
          ProtectionAuditRecord, Position, JournalEntry, OrderRecord)


@pytest.fixture
def settings():
    return Settings(paper_starting_equity=10_000.0, cps_admin_key=ADMIN_KEY, api_key=None,
                    kill_switch=False, live_trading_enabled=False)


@pytest.fixture
def db():
    init_db()
    session = SessionLocal()
    for model in TABLES:
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    for model in TABLES:
        session.query(model).delete()
    session.commit()
    session.close()


@pytest.fixture
def human(settings):
    auth = authorize_admin(settings, ADMIN_KEY)
    assert auth is not None
    return auth


async def order(svc, *, side="buy", symbol="BTCUSDT", qty=0.05, price=100.0, stop=98.0, strategy=None, atr=2.0):
    return await svc.place_order(
        provider="binance", environment="paper", symbol=symbol, side=side, qty=qty, equity=10_000.0,
        data_status="fresh", data_age_seconds=1, fill_price_hint=price, reference_price=price,
        stop_loss=stop, atr_pct=atr, strategy_id=strategy,
    )


def add_position(db, symbol="BTCUSDT", qty=1.0, entry=100.0, mark=100.0, stop=90.0, side="long", env="paper", strategy=None):
    meta = {}
    if stop is not None:
        meta["stop_loss"] = stop
    if strategy:
        meta["strategy_id"] = strategy
    pnl = (mark - entry) * qty if side == "long" else (entry - mark) * qty
    db.add(Position(provider="binance", environment=env, symbol=symbol, side=side, qty=qty, avg_entry=entry,
                    mark_price=mark, unrealized_pnl=pnl, status="open", meta=meta or None))
    db.commit()


def add_closed(db, pnl, strategy=None, env="paper", at=None):
    entry = JournalEntry(provider="binance", environment=env, symbol="BTCUSDT", side="sell", qty=1.0, price=100.0,
                         event="closed", pnl=pnl, payload={"strategy_id": strategy} if strategy else None)
    if at is not None:
        entry.created_at = at.astimezone(timezone.utc).replace(tzinfo=None)
    db.add(entry)
    db.commit()


# ------------------------------------------------------------------ admin authority
def test_authorize_admin_rules():
    s = Settings(cps_admin_key="k" * 20, api_key="a" * 20)
    assert authorize_admin(s, "k" * 20) is not None
    assert authorize_admin(s, "w" * 20) is None
    assert authorize_admin(s, None) is None
    assert authorize_admin(Settings(cps_admin_key=None), "x" * 20) is None          # not configured
    assert authorize_admin(Settings(cps_admin_key="short"), "short") is None        # too short
    assert authorize_admin(Settings(cps_admin_key="s" * 20, api_key="s" * 20), "s" * 20) is None  # same as API key


# ------------------------------------------------------------------ TradingService gate
@pytest.mark.asyncio
async def test_order_needs_a_stop_and_the_stop_is_persisted(db, settings):
    svc = TradingService(settings, db=db)
    refused = await order(svc, stop=None)
    assert refused["status"] == "rejected"
    assert "STOP_LOSS_REQUIRED" in refused["capital_protection"]["violations"]
    assert db.query(Position).count() == 0

    ok = await order(svc, strategy=None)
    assert ok["status"] == "submitted" and ok["capital_protection"]["approved"]
    pos = db.query(Position).one()
    assert pos.meta["stop_loss"] == 98.0 and pos.status == "open"


@pytest.mark.asyncio
async def test_refusals_are_audited_and_chain_verifies(db, settings):
    await order(TradingService(settings, db=db), stop=None)
    p = CapitalProtectionService(db, settings)
    assert p.verify_audit_chain() == {"ok": True, "records": 1}
    row = db.query(ProtectionAuditRecord).one()
    assert row.event_type == "ORDER_REFUSED"
    row.detail = {"tampered": True}
    db.commit()
    assert p.verify_audit_chain()["ok"] is False


@pytest.mark.asyncio
async def test_quarantined_strategy_cannot_trade_but_can_exit(db, settings, human):
    p = CapitalProtectionService(db, settings)
    p.register_strategy("momo_v1", EXP, human)
    svc = TradingService(settings, db=db)
    assert (await order(svc, strategy="momo_v1"))["status"] == "submitted"

    assert p.quarantine("momo_v1", [{"reason": "MANUAL", "detail": "unit test"}]) is True
    assert p.quarantine("momo_v1", [{"reason": "MANUAL", "detail": "again"}]) is False  # idempotent
    refused = await order(svc, symbol="ETHUSDT", strategy="momo_v1")
    assert refused["status"] == "rejected" and "STRATEGY_QUARANTINED" in refused["capital_protection"]["violations"]

    exit_ = await order(svc, side="sell", strategy="momo_v1", stop=None, atr=None)
    assert exit_["status"] == "submitted" and exit_["capital_protection"]["reduces_exposure"]
    assert db.query(Position).filter(Position.symbol == "BTCUSDT").one().status == "closed"


@pytest.mark.asyncio
async def test_halt_blocks_entries_allows_exits_and_needs_a_human_to_release(db, settings, human):
    p = CapitalProtectionService(db, settings)
    svc = TradingService(settings, db=db)
    assert (await order(svc))["status"] == "submitted"
    p.halt("paper", "unit test halt")
    refused = await order(svc, symbol="ETHUSDT")
    assert refused["status"] == "rejected" and "HALTED" in refused["capital_protection"]["violations"]
    assert (await order(svc, side="sell", stop=None, atr=None))["status"] == "submitted"

    with pytest.raises(PermissionError):
        p.reset_halt("paper", HumanAuthorization(reviewer="bot", actor_type="agent"), "released by an agent")
    with pytest.raises(ValueError):
        p.reset_halt("paper", human, "short")
    assert p.halt_state("paper")["halted"] is True
    p.reset_halt("paper", human, "Reviewed the incident and re-based the high-water mark.")
    assert p.halt_state("paper")["halted"] is False
    assert (await order(svc, symbol="ETHUSDT"))["status"] == "submitted"


@pytest.mark.asyncio
async def test_consecutive_losses_pause_entries(db, settings):
    for _ in range(3):
        add_closed(db, -10.0)
    p = CapitalProtectionService(db, settings)
    snap = p.build_account_snapshot("paper")
    assert snap.consecutive_losses == 3 and snap.last_loss_at is not None
    refused = await order(TradingService(settings, db=db))
    assert "CONSECUTIVE_LOSSES" in refused["capital_protection"]["violations"]


@pytest.mark.asyncio
async def test_daily_loss_limit_uses_database_not_caller(db, settings):
    add_closed(db, -250.0)  # 2.5% of $10k realised today
    refused = await order(TradingService(settings, db=db))
    assert "DAILY_LOSS" in refused["capital_protection"]["violations"]


# ------------------------------------------------------------------ sweep: stops and emergencies
@pytest.mark.asyncio
async def test_stop_loss_breach_is_liquidated(db, settings):
    add_position(db, qty=1.0, entry=100.0, mark=89.0, stop=90.0)
    report = CapitalProtectionService(db, settings).sweep("paper")
    assert report.stop_breaches == ["BTCUSDT"] and len(report.liquidations) == 1

    out = await run_protection_sweep(db, settings, ("paper",))
    assert out[0]["executed"][0]["status"] == "submitted"
    pos = db.query(Position).one()
    assert pos.status == "closed" and pos.realized_pnl == pytest.approx(-11.0)


@pytest.mark.asyncio
async def test_legacy_position_without_stop_gets_a_protective_stop(db, settings):
    add_position(db, symbol="ETHUSDT", stop=None)
    report = CapitalProtectionService(db, settings).sweep("paper")
    assert report.default_stops_attached == ["ETHUSDT"]
    assert db.query(Position).one().meta["stop_loss"] == pytest.approx(90.0)  # max stop distance (10%) below entry


@pytest.mark.asyncio
async def test_emergency_halts_and_flattens(db, settings):
    add_position(db, qty=10.0, entry=100.0, mark=60.0, stop=50.0)  # -$400 open loss = -4.2% of equity
    out = await run_protection_sweep(db, settings, ("paper",))
    assert out[0]["emergency"] is True and out[0]["halted"] is True
    assert out[0]["executed"][0]["status"] == "submitted"
    assert db.query(Position).one().status == "closed"
    p = CapitalProtectionService(db, settings)
    assert p.halt_state("paper")["halted"] is True
    assert any(r.event_type == "EMERGENCY_LIQUIDATION" for r in db.query(ProtectionAuditRecord).all())


@pytest.mark.asyncio
async def test_live_without_equity_baseline_does_not_trip_a_false_emergency(db, settings):
    out = await run_protection_sweep(db, settings, ("live",))
    assert out[0]["emergency"] is False and out[0]["halted"] is False


# ------------------------------------------------------------------ news
def test_news_calendar_blackout_and_freshness(db, settings, human):
    p = CapitalProtectionService(db, settings)
    assert p.news_context().status == "not_configured"
    soon = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    assert p.replace_news_calendar([{"title": "CPI", "at": soon, "impact": "high", "scope": ["*"]}], human) == 1
    assert p.news_context().status == "ok"
    intent = OrderIntent(provider="binance", environment="paper", symbol="BTCUSDT", side="buy", qty=0.05,
                         price=100.0, stop_loss=98.0, atr_pct=2.0)
    assert "NEWS_BLACKOUT" in p.check_order(intent).violations
    with pytest.raises(PermissionError):
        p.replace_news_calendar([], HumanAuthorization(reviewer="bot", actor_type="agent"))


# ------------------------------------------------------------------ strategy lifecycle
def test_drawdown_breach_quarantines_from_journal_evidence(db, settings, human):
    p = CapitalProtectionService(db, settings)
    p.register_strategy("s_dd", EXP, human)
    for _ in range(3):
        add_closed(db, -500.0, strategy="s_dd")
    result = p.evaluate_strategy("s_dd")
    assert result["quarantined_now"] and result["status"] == "QUARANTINED"
    assert any(f["reason"] == "DRAWDOWN_BREACH" for f in result["findings"])


def test_execution_quality_quarantine_from_trade_log(db, settings, human):
    p = CapitalProtectionService(db, settings)
    p.register_strategy("s_exec", EXP, human)
    for _ in range(12):
        p.log_attempt(strategy_id="s_exec", environment="paper", provider="binance", symbol="BTCUSDT", side="buy",
                      qty=1.0, reference_price=100.0, fill_price=100.5, outcome="filled", client_order_id=None)  # 50 bps
    assert p.evaluate_strategy("s_exec")["status"] == "QUARANTINED"


def test_data_integrity_observation_quarantines(db, settings, human):
    p = CapitalProtectionService(db, settings)
    p.register_strategy("s_data", EXP, human)
    p.observe("s_data", integrity_flags=["stale_data"])
    assert p.evaluate_strategy("s_data")["status"] == "QUARANTINED"


def test_full_review_and_revalidation_workflow(db, settings, human):
    p = CapitalProtectionService(db, settings)
    p.register_strategy("s_life", EXP, human)
    p.quarantine("s_life", [{"reason": "MANUAL", "detail": "unit test"}])
    bot = HumanAuthorization(reviewer="bot", actor_type="agent")

    with pytest.raises(PermissionError):
        p.begin_review("s_life", bot)
    with pytest.raises(ValueError):
        p.complete_revalidation("s_life", human)                      # not yet REVALIDATING
    with pytest.raises(ValueError):
        p.register_strategy("s_life", EXP, human)                      # cannot be re-registered around the gate
    p.begin_review("s_life", human)
    with pytest.raises(ValueError):
        p.approve_revalidation("s_life", human, "too short", "too short")
    p.approve_revalidation("s_life", human, "Slippage spike traced to a thin venue; routing was changed.",
                           "Re-run on paper for 30 trades before any live use.")
    assert p.strategy_view("s_life")["status"] == "REVALIDATING"

    # not enough evidence and no cooling-off yet -> stays in revalidation
    early = p.complete_revalidation("s_life", human)
    assert early["released"] is False and p.strategy_view("s_life")["status"] == "REVALIDATING"

    # fresh paper evidence after the quarantine, with the cooling-off period elapsed
    rec = db.query(StrategyQuarantineRecord).one()
    rec.quarantined_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=48)
    db.commit()
    for i in range(36):
        add_closed(db, 1.0 if i % 3 else -0.8, strategy="s_life")
    done = p.complete_revalidation("s_life", human)
    assert done["released"] is True and p.strategy_view("s_life")["status"] == "ACTIVE"
    assert p.strategy_view("s_life")["baseline_at"] is not None
    # monitoring restarts from fresh evidence: old pre-release trades must not re-trigger a quarantine
    assert p.evaluate_strategy("s_life")["quarantined_now"] is False


def test_revalidating_strategy_is_paper_only(db, settings, human):
    p = CapitalProtectionService(db, settings)
    p.register_strategy("s_rv", EXP, human)
    p.quarantine("s_rv", [{"reason": "MANUAL", "detail": "x"}])
    p.begin_review("s_rv", human)
    p.approve_revalidation("s_rv", human, "Root cause identified and fixed in code.", "Collect paper evidence only.")
    base = dict(provider="binance", symbol="BTCUSDT", side="buy", qty=0.05, price=100.0, stop_loss=98.0, atr_pct=2.0,
                strategy_id="s_rv")
    assert p.check_order(OrderIntent(environment="paper", **base)).approved
    assert "STRATEGY_QUARANTINED" in p.check_order(OrderIntent(environment="live", **base)).violations


# ------------------------------------------------------------------ API
@pytest.fixture
def client(settings, db, monkeypatch):
    class _Market:
        def __init__(self, s):
            pass

        async def get_snapshot(self, provider, symbol):
            return {"provider": provider, "symbol": symbol, "price": 100.0, "data_status": "fresh",
                    "ts_utc": datetime.now(timezone.utc).isoformat()}

    monkeypatch.setattr(main_module, "MarketService", _Market)
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def _register_body(sid="api_strat"):
    return {"strategy_id": sid, "expectations": EXP.to_dict() | {"validated_regimes": [], "validated_atr_pct_range": None}}


def test_api_status_is_public_and_reports_policy(client):
    r = client.get("/api/capital-protection/status")
    assert r.status_code == 200
    body = r.json()
    assert body["system"] == "ETI CAPITAL PROTECTION SYSTEM" and body["policy"]["max_leverage"] == 1.0
    assert body["admin_release_configured"] is True and body["audit_chain"]["ok"] is True


def test_api_loosening_routes_reject_missing_wrong_and_general_keys(client):
    url = "/api/capital-protection/strategies"
    assert client.post(url, json=_register_body()).status_code == 403
    assert client.post(url, json=_register_body(), headers={"X-CPS-Admin-Key": "wrong-" * 5}).status_code == 403
    assert client.post(url, json=_register_body(), headers={"X-API-Key": API_KEY}).status_code == 403
    assert client.post("/api/capital-protection/halt/reset?environment=paper", json={"note": "x" * 12}).status_code == 403
    ok = client.post(url, json=_register_body(), headers={"X-CPS-Admin-Key": ADMIN_KEY})
    assert ok.status_code == 200 and ok.json()["status"] == "ACTIVE"


def test_api_admin_routes_are_disabled_without_admin_key(db, client):
    app.dependency_overrides[get_settings] = lambda: Settings(paper_starting_equity=10_000.0, cps_admin_key=None)
    r = client.post("/api/capital-protection/strategies", json=_register_body(), headers={"X-CPS-Admin-Key": ADMIN_KEY})
    assert r.status_code == 503


def test_api_tightening_is_open_to_general_key_but_cannot_release(client):
    h = client.post("/api/capital-protection/halt?environment=paper", json={"reason": "operator pressed stop"})
    assert h.status_code == 200 and h.json()["halted"] is True
    assert client.post("/api/capital-protection/halt/reset?environment=paper", json={"note": "agent says resume"}).status_code == 403
    reset = client.post("/api/capital-protection/halt/reset?environment=paper", json={"note": "Reviewed with the desk lead."},
                        headers={"X-CPS-Admin-Key": ADMIN_KEY})
    assert reset.status_code == 200 and reset.json()["halted"] is False


def test_api_dry_run_evaluate_and_size(client):
    base = {"provider": "binance", "environment": "paper", "symbol": "BTCUSDT", "side": "buy", "quantity": 0.05, "price": 100.0}
    refused = client.post("/api/capital-protection/evaluate", json=base).json()
    assert refused["approved"] is False and refused["submits_order"] is False and "STOP_LOSS_REQUIRED" in refused["violations"]
    ok = client.post("/api/capital-protection/evaluate", json=base | {"stop_loss": 98.0, "atr_pct": 2.0}).json()
    assert ok["approved"] is True
    size = client.post("/api/capital-protection/size", json=base | {"stop_loss": 98.0, "atr_pct": 2.0}).json()
    assert size["max_qty"] == pytest.approx(6.0) and size["binding_constraint"] == "notional"
    assert client.post("/api/capital-protection/size", json=base).status_code == 422


def test_api_order_endpoint_enforces_the_gate_and_ignores_client_overrides(client, db):
    body = {"provider": "binance", "environment": "paper", "symbol": "BTCUSDT", "side": "buy", "qty": 0.05,
            "limit_price": 100.0, "equity": 1e12, "data_status": "fresh"}
    refused = client.post("/api/trading/order", json=body).json()
    assert refused["status"] == "rejected" and "STOP_LOSS_REQUIRED" in refused["capital_protection"]["violations"]
    ok = client.post("/api/trading/order", json=body | {"stop_loss": 98.0, "atr_pct": 2.0}).json()
    assert ok["status"] == "submitted"
    oversize = client.post("/api/trading/order", json=body | {"qty": 50.0, "stop_loss": 98.0, "atr_pct": 2.0}).json()
    assert oversize["status"] == "rejected" and "POSITION_NOTIONAL" in oversize["capital_protection"]["violations"]


def test_api_strategy_quarantine_endpoint_and_listing(client, db, human):
    CapitalProtectionService(db, Settings(cps_admin_key=ADMIN_KEY)).register_strategy("api_q", EXP, human)
    q = client.post("/api/capital-protection/strategies/api_q/quarantine", json={"reason": "operator concern"})
    assert q.status_code == 200 and q.json()["status"] == "QUARANTINED"
    assert client.get("/api/capital-protection/strategies/api_q").json()["status"] == "QUARANTINED"
    assert client.post("/api/capital-protection/strategies/nope/quarantine", json={"reason": "operator concern"}).status_code == 404
    listing = client.get("/api/capital-protection/strategies").json()["strategies"]
    assert [s["strategy_id"] for s in listing] == ["api_q"]
    assert client.get("/api/capital-protection/audit").json()["chain"]["ok"] is True

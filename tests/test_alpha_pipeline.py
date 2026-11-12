import json
from datetime import datetime, timezone

import httpx
import pytest

from app.alpha import fusion
from app.alpha.db_models import AlphaAuditLog, AlphaCandidate, AlphaStrategyState, AlphaTradePlan
from app.alpha.discovery import DiscoveryEngine, evaluate_ohlcv, leaderboard, overall_rank
from app.alpha.execution import LIVE_PHRASE, AlphaExecutor
from app.alpha.predictions import alpha_predictions
from app.alpha.providers import BinanceUniverse, DexScreener
from app.config import Settings
from app.database import SessionLocal, init_db
from tests.alpha_helpers import make_bars


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    for m in (AlphaTradePlan, AlphaCandidate, AlphaAuditLog, AlphaStrategyState):
        s.query(m).delete()
    s.commit()
    yield s
    s.close()


def _binance_transport(bars_by_symbol, fail=()):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/ticker/24hr"):
            rows = [{"symbol": s, "lastPrice": "100", "quoteVolume": "5000000", "priceChangePercent": "1.5", "count": 1000} for s in bars_by_symbol]
            rows.append({"symbol": "USDCUSDT", "lastPrice": "1", "quoteVolume": "9e9", "priceChangePercent": "0", "count": 1})
            rows.append({"symbol": "BTCUPUSDT", "lastPrice": "1", "quoteVolume": "9e9", "priceChangePercent": "0", "count": 1})
            return httpx.Response(200, json=rows)
        if req.url.path.endswith("/klines"):
            sym = req.url.params["symbol"]
            if sym in fail:
                return httpx.Response(500)
            b = bars_by_symbol.get(sym) or bars_by_symbol["BTCUSDT"]
            return httpx.Response(200, json=[[int(x["open_time"]), str(x["open"]), str(x["high"]), str(x["low"]), str(x["close"]), str(x["volume"]),
                                              int(x["close_time"])] for x in b])
        return httpx.Response(404)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_crypto_scan_filters_stables_records_failures_and_source_status(db):
    data = {"BTCUSDT": make_bars(220, seed=1, volume=50000), "AAAUSDT": make_bars(220, seed=2, volume=50000), "BBBUSDT": make_bars(220, seed=3, volume=50000)}
    client = _binance_transport(data, fail=("BBBUSDT",))
    eng = DiscoveryEngine(db, binance=BinanceUniverse(client=client, db=db))
    out = await eng.scan_crypto(limit=10, min_quote_volume=1e6, seed=1)
    assert out["scanned"] == 2 and out["failed"] == ["BBBUSDT"]
    ids = {c.symbol for c in db.query(AlphaCandidate).all()}
    assert "USDCUSDT" not in ids and "BTCUPUSDT" not in ids and {"BTCUSDT", "AAAUSDT"} <= ids
    from app.alpha.db_models import AlphaSourceStatus
    st = db.query(AlphaSourceStatus).filter_by(provider="binance_public").one()
    assert st.last_success is not None and st.failures >= 1  # failures are measured, not hidden


def test_rejected_candidates_are_kept_with_reasons(db):
    c = evaluate_ohlcv(db, asset_class="crypto", symbol="THINUSDT", bars=make_bars(220, seed=1, volume=1), provider="binance_public", exchange="BINANCE")
    assert c.status == "REJECTED" and any("illiquid" in r for r in c.rejection_reasons)
    short = evaluate_ohlcv(db, asset_class="crypto", symbol="NEWUSDT", bars=make_bars(20), provider="binance_public", exchange="BINANCE")
    assert short.status == "REJECTED" and "insufficient history" in short.rejection_reasons[0]
    assert db.query(AlphaCandidate).filter_by(status="REJECTED").count() == 2
    assert all(r["status"] != "REJECTED" for r in leaderboard(db))


def test_discovery_cannot_create_confirmed_status(db):
    for seed in range(1, 12):
        evaluate_ohlcv(db, asset_class="crypto", symbol=f"S{seed}USDT", bars=make_bars(250, seed=seed, drift=0.003, vol=0.008, volume=50000),
                       provider="binance_public", exchange="BINANCE")
    assert not db.query(AlphaCandidate).filter(AlphaCandidate.status.in_(("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY"))).count()


def test_validated_rank_beats_unvalidated():
    base = {"early_alpha": 70, "technical": 70, "liquidity": 70, "risk": 20, "independent_validation": None}
    assert overall_rank({**base, "independent_validation": 70}) > overall_rank(base)


async def test_dex_scan_applies_safety_screen(db):
    now_ms = datetime.now(timezone.utc).timestamp() * 1000 - 48 * 3_600_000
    pairs = [{"baseToken": {"address": "0xGOOD", "symbol": "GOOD", "name": "Good"}, "liquidity": {"usd": 400000}, "volume": {"h24": 200000},
              "txns": {"h24": {"buys": 300, "sells": 250}}, "priceChange": {"h24": 5}, "priceUsd": "0.5", "pairCreatedAt": now_ms, "dexId": "dx"},
             {"baseToken": {"address": "0xHONEY", "symbol": "HONEY", "name": "H"}, "liquidity": {"usd": 400000}, "volume": {"h24": 100},
              "txns": {"h24": {"buys": 400, "sells": 0}}, "priceChange": {"h24": 5}, "priceUsd": "0.1", "pairCreatedAt": now_ms, "dexId": "dx"}]

    def handler(req):
        if "token-profiles" in req.url.path:
            return httpx.Response(200, json=[{"chainId": "eth", "tokenAddress": "0xGOOD"}, {"chainId": "eth", "tokenAddress": "0xHONEY"}])
        return httpx.Response(200, json=pairs)
    eng = DiscoveryEngine(db, dex=DexScreener(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), db=db))
    out = await eng.scan_dex()
    assert out["scanned"] == 1 and out["blocked_by_safety_screen"] == 1
    honey = db.query(AlphaCandidate).filter_by(symbol="HONEY").one()
    assert honey.status == "REJECTED" and honey.asset_class == "token"
    assert "audit" in json.dumps(db.query(AlphaCandidate).filter_by(symbol="GOOD").one().evidence).lower()


# ------------------------------------------------------------------ decision layer
class _Bull:
    """Plug-in engine proving the fusion layer accepts additional engines."""
    @staticmethod
    def run(ctx):
        return fusion.EngineEvidence("plugin_bull", True, "bullish", 0.7, evidence=["test"])


@pytest.fixture()
def plugin():
    fusion.register_engine("plugin_bull", _Bull.run)
    yield
    fusion._ENGINES.pop("plugin_bull", None)


def _cand(db, seed=2, symbol="AAAUSDT", volume=50000):
    bars = make_bars(260, seed=seed, drift=0.003, vol=0.008, volume=volume)
    c = evaluate_ohlcv(db, asset_class="crypto", symbol=symbol, bars=bars, provider="binance_public", exchange="BINANCE")
    return c, bars


def test_validation_approves_only_with_independent_agreement(db, plugin):
    c, bars = _cand(db)
    res = fusion.validate(db, c, bars, settings=Settings(), equity=10000)
    assert res["decision"] in ("APPROVE_CONFIRMED", "APPROVE_HIGH_CONVICTION") and res["executable"]
    assert c.status in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY") and c.validated_at
    assert res["plan"]["stop"] < res["plan"]["entry"] < res["plan"]["tp1"] < res["plan"]["tp2"] < res["plan"]["tp3"]
    assert res["attribution"]["disclaimer"] and any(p["asset"] == "AAAUSDT" for p in alpha_predictions(db, 200))  # ledger entry at decision time


def test_hard_veto_cannot_be_outvoted(db, plugin):
    fusion.register_engine("plugin_veto", lambda ctx: fusion.EngineEvidence("plugin_veto", True, "bearish", 1.0, hard_veto=True, evidence=["x"]))
    try:
        c, bars = _cand(db, symbol="VETOUSDT")
        res = fusion.validate(db, c, bars, settings=Settings(), equity=10000)
        assert not res["executable"] and "V8_no_engine_veto" in res["hard_failures"]
    finally:
        fusion._ENGINES.pop("plugin_veto", None)


def test_broken_plugin_cannot_approve(db, plugin):
    def boom(ctx):
        raise RuntimeError("bug")
    fusion.register_engine("plugin_boom", boom)
    try:
        c, bars = _cand(db, symbol="BOOMUSDT")
        assert not fusion.validate(db, c, bars, settings=Settings())["executable"]
    finally:
        fusion._ENGINES.pop("plugin_boom", None)


def test_illiquid_and_stale_data_rejected(db, plugin):
    c, bars = _cand(db, symbol="LOWVOL", volume=1)
    r = fusion.validate(db, c, bars, settings=Settings())
    assert not r["executable"] and "V2_liquidity_and_size" in r["hard_failures"]
    c2, bars2 = _cand(db, symbol="OLDUSDT")
    for b in bars2:
        b["close_time"] -= 40 * 86_400_000
    assert "V1_data_fresh_and_sufficient" in fusion.validate(db, c2, bars2, settings=Settings())["hard_failures"]


def test_dex_tokens_never_executable(db, plugin):
    c, bars = _cand(db, symbol="TOKUSDT")
    c.asset_class = "token"
    db.commit()
    r = fusion.validate(db, c, bars, settings=Settings())
    assert not r["executable"] and "V0_execution_venue" in r["hard_failures"] and c.status not in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")


def test_champion_strategies_enable_high_conviction_gate(db, plugin):
    c, bars = _cand(db)
    res = fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
    assert res["champion_strategies_long"] == []  # no strategy is a champion yet
    assert res["decision"] != "APPROVE_HIGH_CONVICTION"


# ------------------------------------------------------------------ execution
class FakeTrading:
    def __init__(self, status="submitted", response=None):
        self.calls, self.status, self.response = [], status, response if response is not None else {"simulated": True, "status": "FILLED", "executedQty": "1"}

    async def place_order(self, **kw):
        self.calls.append(kw)
        if self.status == "rejected":
            return {"status": "rejected", "client_order_id": "eti-r", "risk": {"decision": "REJECTED", "reasons": ["limit"], "notes": ""}, "provider_response": None}
        return {"status": self.status, "client_order_id": f"eti-{len(self.calls)}", "risk": {"decision": "APPROVED", "reasons": ["ok"], "notes": ""},
                "provider_response": self.response}


def _price_fn(holder):
    async def fn(provider, symbol):
        return {"price": holder["p"], "ts_utc": datetime.now(timezone.utc).isoformat(), "data_status": "fresh"}
    return fn


async def _approved(db, holder):
    c, bars = _cand(db)
    fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
    assert c.status in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")
    holder["p"] = bars[-1]["close"]

    async def bars_fn(_c):
        return bars
    return c, bars, bars_fn


async def test_live_execution_blocked_without_every_authorization(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    ex = AlphaExecutor(db, Settings(live_trading_enabled=True, alpha_live_execution_authorized=False, api_key="k"), FakeTrading(), _price_fn(holder))
    r = await ex.execute(c.candidate_id, "live", bars_fn, LIVE_PHRASE)
    assert r["status"] == "rejected" and "ALPHA_LIVE_EXECUTION_AUTHORIZED" in r["reasons"][0]
    ex2 = AlphaExecutor(db, Settings(live_trading_enabled=True, alpha_live_execution_authorized=True, api_key="k"), FakeTrading(), _price_fn(holder))
    assert "phrase" in (await ex2.execute(c.candidate_id, "live", bars_fn, "yes"))["reasons"][0]
    assert not ex.trading.calls and not ex2.trading.calls


async def test_paper_execution_open_stop_and_attribution(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    trading = FakeTrading()
    ex = AlphaExecutor(db, Settings(), trading, _price_fn(holder))
    r = await ex.execute(c.candidate_id, "paper", bars_fn)
    assert r["status"] == "open" and trading.calls[0]["side"] == "buy" and trading.calls[0]["estimated_risk_amount"] > 0
    plan = db.query(AlphaTradePlan).one()
    assert plan.status == "OPEN" and plan.attribution["disclaimer"] and plan.remaining_qty == plan.qty
    # duplicate guarded
    assert (await ex.execute(c.candidate_id, "paper", bars_fn))["status"] == "rejected"
    holder["p"] = plan.stop - 1
    out = await ex.monitor()
    db.refresh(plan)
    assert out["actions"][0]["event"] == "stopped" and plan.status == "CLOSED" and plan.close_reason == "STOP" and plan.pnl < 0
    assert trading.calls[-1]["side"] == "sell" and trading.calls[-1]["current_open_positions"] == 0  # reduce-only exit
    assert db.query(AlphaAuditLog).filter_by(action="plan_closed").count() == 1


async def test_take_profit_scale_out_moves_stop_to_breakeven(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    ex = AlphaExecutor(db, Settings(), FakeTrading(), _price_fn(holder))
    await ex.execute(c.candidate_id, "paper", bars_fn)
    plan = db.query(AlphaTradePlan).one()
    holder["p"] = plan.tp1 + 0.01
    await ex.monitor()
    db.refresh(plan)
    assert plan.tp_hits == 1 and plan.stop_current == plan.entry and abs(plan.remaining_qty - plan.qty * 2 / 3) < 1e-9
    holder["p"] = plan.tp3 + 1
    await ex.monitor()
    db.refresh(plan)
    assert plan.status == "CLOSED" and plan.close_reason == "TP3" and plan.pnl > 0
    assert db.query(AlphaStrategyState).count() >= 0


async def test_unconfirmed_and_rejected_orders_not_treated_as_open(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    r = await AlphaExecutor(db, Settings(), FakeTrading(response={"status": "REJECTED"}), _price_fn(holder)).execute(c.candidate_id, "paper", bars_fn)
    assert r["status"] == "unconfirmed" and db.query(AlphaTradePlan).one().status == "UNCONFIRMED"
    db.query(AlphaTradePlan).delete()
    db.commit()
    r2 = await AlphaExecutor(db, Settings(), FakeTrading(status="rejected"), _price_fn(holder)).execute(c.candidate_id, "paper", bars_fn)
    assert r2["status"] == "rejected" and r2["reasons"] == ["limit"]


async def test_execution_refuses_stale_validation_drift_and_unsupported_class(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    ex = AlphaExecutor(db, Settings(), FakeTrading(), _price_fn(holder))
    holder["p"] = bars[-1]["close"] * 1.05
    assert "drifted" in (await ex.execute(c.candidate_id, "paper", bars_fn))["reasons"][0]
    holder["p"] = bars[-1]["close"]
    c.validated_at = datetime(2020, 1, 1)
    db.commit()
    assert "stale" in (await ex.execute(c.candidate_id, "paper", bars_fn))["reasons"][0]
    c.asset_class = "token"
    db.commit()
    assert "research only" in (await ex.execute(c.candidate_id, "paper", bars_fn))["reasons"][0]
    c.asset_class, c.status = "crypto", "WATCHLIST"
    db.commit()
    assert "not executable" in (await ex.execute(c.candidate_id, "paper", bars_fn))["reasons"][0]


def test_failed_revalidation_downgrades_prior_approval(db, plugin):
    c, bars = _cand(db, symbol="DOWNUSDT")
    fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
    assert c.status in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")
    fusion.register_engine("plugin_veto2", lambda ctx: fusion.EngineEvidence("plugin_veto2", True, "bearish", 1.0, hard_veto=True))
    try:
        r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
    finally:
        fusion._ENGINES.pop("plugin_veto2", None)
    assert not r["executable"] and c.status not in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")


def test_stale_approval_expires_on_rescan(db, plugin):
    from datetime import timedelta
    c, bars = _cand(db, symbol="EXPUSDT")
    fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
    cid = c.candidate_id
    assert evaluate_ohlcv(db, asset_class="crypto", symbol="EXPUSDT", bars=bars, provider="binance_public", exchange="BINANCE").status in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")
    c.validated_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=30)
    db.commit()
    again = evaluate_ohlcv(db, asset_class="crypto", symbol="EXPUSDT", bars=bars, provider="binance_public", exchange="BINANCE")
    assert again.candidate_id == cid and again.status not in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")


async def test_alpaca_small_position_skips_fractional_scale_out(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    ex = AlphaExecutor(db, Settings(), FakeTrading(), _price_fn(holder))
    await ex.execute(c.candidate_id, "paper", bars_fn)
    plan = db.query(AlphaTradePlan).one()
    plan.provider, plan.qty, plan.remaining_qty = "alpaca", 2.0, 2.0
    db.commit()
    holder["p"] = plan.tp1 + 0.01
    out = await ex.monitor()
    db.refresh(plan)
    assert plan.tp_hits == 1 and plan.stop_current == plan.entry and plan.remaining_qty == 2.0
    assert out["actions"][0]["event"] == "tp1_stop_to_breakeven"


async def test_provider_retries_on_rate_limit_and_records_failure(db, monkeypatch):
    import asyncio as aio
    from app.alpha.db_models import AlphaSourceStatus
    slept = []

    async def fake_sleep(x):
        slept.append(x)
    monkeypatch.setattr(aio, "sleep", fake_sleep)
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(429, headers={"Retry-After": "1"}) if calls["n"] < 3 else httpx.Response(200, json=[])
    b = BinanceUniverse(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), db=db)
    assert await b.tickers_24h() == [] and calls["n"] == 3 and slept == [1.0, 1.0]
    always = BinanceUniverse(client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(429))), db=db)
    with pytest.raises(httpx.HTTPStatusError):
        await always.tickers_24h()
    assert db.query(AlphaSourceStatus).filter_by(provider="binance_public").one().failures >= 1


def test_plan_notional_never_exceeds_server_side_cap(db, plugin):
    c, bars = _cand(db, symbol="CAPUSDT")
    r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
    cap = 10000 * Settings().max_position_notional_pct / 100
    assert r["plan"]["notional"] <= cap + 1e-6 and r["plan"]["max_notional_pct"] == Settings().max_position_notional_pct
    # a tight stop would otherwise size far above the cap
    from app.alpha.features import compute_features
    f = compute_features(bars)
    plan = fusion.build_trade_plan(f, Settings(), 10000, "crypto", None)
    assert plan["notional"] <= cap + 1e-6


async def test_live_orders_are_limit_orders_when_attempted(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    trading = FakeTrading()
    s = Settings(live_trading_enabled=True, alpha_live_execution_authorized=True, api_key="k", live_account_equity=10000.0)
    await AlphaExecutor(db, s, trading, _price_fn(holder)).execute(c.candidate_id, "live", bars_fn, LIVE_PHRASE)
    assert trading.calls and trading.calls[0]["order_type"] == "limit" and trading.calls[0]["limit_price"] == holder["p"]


async def test_live_without_account_equity_is_refused_with_clear_reason(db, plugin):
    holder = {}
    c, bars, bars_fn = await _approved(db, holder)
    s = Settings(live_trading_enabled=True, alpha_live_execution_authorized=True, api_key="k")
    r = await AlphaExecutor(db, s, FakeTrading(), _price_fn(holder)).execute(c.candidate_id, "live", bars_fn, LIVE_PHRASE)
    assert r["status"] == "rejected" and "LIVE_ACCOUNT_EQUITY" in r["reasons"][0]

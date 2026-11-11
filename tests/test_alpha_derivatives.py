from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.alpha import fusion
from app.alpha.context import gather_context
from app.alpha.db_models import AlphaAuditLog, AlphaCandidate, AlphaKnownAsset, AlphaStrategyState, AlphaTradePlan
from app.alpha.derivatives import FUNDING_ELEVATED, FUNDING_EXTREME, derivatives_view, detect_new_listings, load_derivatives, recent_listings
from app.alpha.discovery import DiscoveryEngine
from app.alpha.providers import BinanceFutures, BinanceUniverse
from app.config import Settings
from app.database import SessionLocal, init_db
from tests.alpha_helpers import make_bars
from tests.test_alpha_pipeline import _binance_transport, _cand


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    for m in (AlphaTradePlan, AlphaCandidate, AlphaAuditLog, AlphaStrategyState, AlphaKnownAsset):
        s.query(m).delete()
    s.commit()
    yield s
    s.close()


def oi(a, b):
    return [{"ts": 1.0, "oi_value": a}, {"ts": 2.0, "oi_value": b}]


def test_derivatives_view_states_and_unknowns():
    assert derivatives_view(None, [])["state"] == "UNKNOWN"
    assert derivatives_view(0.0001, oi(100, 105))["state"] == "NEUTRAL"
    assert derivatives_view(FUNDING_ELEVATED, oi(100, 130))["state"] == "CROWDED_LONG_RISK"          # elevated funding AND rising OI
    assert derivatives_view(FUNDING_ELEVATED, oi(100, 105))["state"] == "NEUTRAL"                   # elevated funding alone is not enough
    ex = derivatives_view(FUNDING_EXTREME, [])
    assert ex["state"] == "CROWDED_LONG_RISK" and ex["extreme"] is True                              # extreme funding alone is
    assert derivatives_view(-FUNDING_ELEVATED, oi(100, 100))["state"] == "SHORTS_CROWDED"
    assert "positioning evidence only" in derivatives_view(0.0001, [])["note"]


def _fut_client(funding=None, oi_rows=None, status=200):
    def handler(req: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status, json={"code": -1121})
        if req.url.path.endswith("premiumIndex"):
            return httpx.Response(200, json={"lastFundingRate": str(funding), "markPrice": "100", "nextFundingTime": 1}) if funding is not None else httpx.Response(200, json={})
        return httpx.Response(200, json=oi_rows or [])
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_load_derivatives_reads_funding_and_oi_and_degrades_for_spot_only(db):
    rows = [{"timestamp": 1, "sumOpenInterestValue": "100"}, {"timestamp": 2, "sumOpenInterestValue": "140"}]
    ok = await load_derivatives(BinanceFutures(client=_fut_client(0.0007, rows), db=db), "ABCUSDT")
    assert ok["state"] == "CROWDED_LONG_RISK" and ok["oi_change_pct"] == 40.0
    assert (await load_derivatives(BinanceFutures(client=_fut_client(status=400), db=db), "SPOTONLYUSDT"))["state"] == "UNKNOWN"
    assert (await load_derivatives(BinanceFutures(client=_fut_client(None), db=db), "NOFUNDUSDT"))["state"] == "UNKNOWN"


def test_crowded_long_is_soft_evidence_and_a_soft_check_never_a_veto(db):
    c, bars = _cand(db, symbol="CROWDUSDT")
    fusion.register_engine("plugin_b3", lambda ctx: fusion.EngineEvidence("plugin_b3", True, "bullish", 0.7))
    try:
        crowded = {"state": "CROWDED_LONG_RISK", "evidence": ["funding 0.0800% per 8h"], "extreme": False}
        r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, derivatives=crowded, record=False)
        chk = next(x for x in r["checks"] if x["id"] == "V11_derivatives_crowding")
        eng = next(e for e in r["engines"] if e["engine"] == "derivatives")
        assert chk["pass"] is False and chk["hard"] is False and eng["bias"] == "bearish" and not eng["hard_veto"]
        assert "V11_derivatives_crowding" not in r["hard_failures"] and r["executable"]  # lowers the score, cannot block alone
        calm = fusion.validate(db, c, bars, settings=Settings(), equity=10000, derivatives={"state": "NEUTRAL", "evidence": []}, record=False)
        assert calm["validation_score"] > r["validation_score"]
        none = fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)
        assert next(x for x in none["checks"] if x["id"] == "V11_derivatives_crowding")["detail"].startswith("not assessed")
        assert not next(e for e in none["engines"] if e["engine"] == "derivatives")["available"]
    finally:
        fusion._ENGINES.pop("plugin_b3", None)


async def test_gather_context_loads_derivatives_for_crypto_only(db):
    c, bars = _cand(db, symbol="CTXDUSDT")

    async def derivs(sym):
        return {"state": "NEUTRAL", "evidence": [sym]}

    async def no_macro(s):
        return {"status": "not_configured"}
    ctx = await gather_context(db, Settings(), c, bars, derivatives_fn=derivs, macro_fn=no_macro)
    assert ctx["derivatives"]["evidence"] == ["CTXDUSDT"]
    c.asset_class = "equity"

    async def no_fund(*a, **k):
        return None
    eq = await gather_context(db, Settings(), c, bars, derivatives_fn=derivs, macro_fn=no_macro, fundamentals_fn=no_fund)
    assert eq["derivatives"] is None


def test_new_listings_first_sweep_seeds_baseline_then_flags_only_new(db):
    now = datetime.now(timezone.utc)
    first = detect_new_listings(db, "binance_public", ["AAAUSDT", "BBBUSDT"], now)
    assert first == {"baseline_seeded": 2, "new": []}  # the first sweep never calls anything "new"
    assert detect_new_listings(db, "binance_public", ["AAAUSDT", "BBBUSDT"], now)["new"] == []
    second = detect_new_listings(db, "binance_public", ["AAAUSDT", "BBBUSDT", "NEWUSDT"], now)
    assert second["new"] == ["NEWUSDT"] and detect_new_listings(db, "binance_public", ["NEWUSDT", "AAAUSDT"], now)["new"] == []  # reported once
    rec = recent_listings(db, "binance_public", 30, now)
    assert [r["symbol"] for r in rec] == ["NEWUSDT"] and rec[0]["scoreable"] is False
    assert recent_listings(db, "binance_public", 30, now + timedelta(days=61)) == []
    assert detect_new_listings(db, "dexscreener", ["X"], now)["baseline_seeded"] == 1  # providers are independent


async def test_scan_crypto_detects_and_records_new_listing_without_scoring_it(db):
    data = {"BTCUSDT": make_bars(220, seed=1, volume=50000), "AAAUSDT": make_bars(220, seed=2, volume=50000), "NEWUSDT": make_bars(10, seed=3, volume=50000)}
    base_syms = ["BTCUSDT", "AAAUSDT"]

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/exchangeInfo"):
            syms = base_syms if not state["listed"] else base_syms + ["NEWUSDT"]
            return httpx.Response(200, json={"symbols": [{"symbol": s, "status": "TRADING", "quoteAsset": "USDT"} for s in syms]})
        return base_handler(req)
    state = {"listed": False}
    base = _binance_transport(data)
    base_handler = base._transport.handler  # reuse the ticker/kline fixtures from the pipeline tests
    eng = DiscoveryEngine(db, binance=BinanceUniverse(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), db=db))
    out1 = await eng.scan_crypto(limit=10, min_quote_volume=1e6, seed=1)
    assert out1["new_listings"]["baseline_seeded"] == 2 and out1["new_listings"]["new_listings"] == []
    state["listed"] = True
    out2 = await eng.scan_crypto(limit=10, min_quote_volume=1e6, seed=1)
    assert out2["new_listings"]["new_listings"] == ["NEWUSDT"]
    row = db.query(AlphaCandidate).filter_by(symbol="NEWUSDT").one()
    assert row.status == "REJECTED" and "insufficient history" in row.rejection_reasons[0] and row.reasons[0].startswith("NEW_LISTING")


def test_new_listings_and_derivatives_routes():
    from fastapi.testclient import TestClient
    import app.security.auth as auth
    from app.main import app
    c = TestClient(app)
    r = c.get("/api/alpha/new-listings", params={"days": 30})
    assert r.status_code == 200 and "note" in r.json() and c.get("/api/alpha/new-listings", params={"days": 0}).status_code == 422
    s = Settings(app_env="production", api_key="k" * 20)
    orig = auth.get_settings
    auth.get_settings = lambda: s
    try:
        assert c.get("/api/alpha/derivatives/BTCUSDT").status_code == 401
        assert c.get("/api/alpha/derivatives/BT", headers={"X-API-Key": "k" * 20}).status_code == 422
    finally:
        auth.get_settings = orig

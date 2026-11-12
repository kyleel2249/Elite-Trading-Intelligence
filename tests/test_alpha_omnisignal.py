import httpx
import pytest

from app.alpha import fusion
from app.alpha.context import gather_context
from app.alpha.db_models import AlphaAuditLog, AlphaCandidate, AlphaStrategyState, AlphaTradePlan
from app.alpha.omnisignal_bridge import fetch_omnisignal, summarize
from app.config import Settings
from app.database import SessionLocal, init_db
from tests.test_alpha_pipeline import _cand


def _client(body, status=200, capture=None):
    def handler(req: httpx.Request) -> httpx.Response:
        if capture is not None:
            capture.append(req)
        return httpx.Response(status, json=body)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    for m in (AlphaTradePlan, AlphaCandidate, AlphaAuditLog, AlphaStrategyState):
        s.query(m).delete()
    s.commit()
    yield s
    s.close()


def _result(decision, hard=()):
    return {"decision": decision, "confidence": 72, "strategy": "swing", "fusion": {"agreement": "BOTH_AGREE", "acceptedEngine": "both"},
            "validation": {"classification": "CONFIRMED", "hardFailures": list(hard)}}


async def test_fetch_requires_config_and_valid_symbol_and_never_sends_credentials():
    assert await fetch_omnisignal(None, "BTCUSDT") is None
    assert await fetch_omnisignal("https://w.example", "../etc") is None
    seen = []
    r = await fetch_omnisignal("https://w.example/", "btcusdt", client=_client(_result("BUY"), capture=seen))
    assert r["decision"] == "BUY" and seen[0].url.path == "/api/omnisignal" and seen[0].url.params["engines"] == "swift,gainz"
    assert "authorization" not in {k.lower() for k in seen[0].headers}


async def test_fetch_degrades_to_data_unreliable():
    assert (await fetch_omnisignal("https://w.example", "BTCUSDT", client=_client({"x": 1})))["decision"] == "DATA_UNRELIABLE"

    def boom(req):
        raise httpx.ConnectError("down")
    r = await fetch_omnisignal("https://w.example", "BTCUSDT", client=httpx.AsyncClient(transport=httpx.MockTransport(boom)))
    assert r["decision"] == "DATA_UNRELIABLE"
    assert summarize(r)["available"] is False and summarize(None)["available"] is False


def _ev(result):
    return fusion.engine_omnisignal({"omnisignal": result})


def test_engine_mapping():
    assert _ev(_result("BUY")).bias == "bullish" and not _ev(_result("BUY")).hard_veto
    sell = _ev(_result("SELL"))
    assert sell.bias == "bearish" and sell.hard_veto  # validated opposing signal blocks a long thesis
    assert _ev(_result("REJECTED", ["spread too wide"])).hard_veto
    assert not _ev(_result("REJECTED")).hard_veto
    assert _ev(_result("HOLD")).bias == "neutral" and not _ev(_result("HOLD")).hard_veto
    un = _ev({"decision": "DATA_UNRELIABLE"})
    assert not un.available and not un.hard_veto and un.limitations
    assert "heuristic" in " ".join(_ev(_result("BUY")).limitations).lower()


def test_omnisignal_counts_as_independent_agreement_and_sell_blocks(db):
    c, bars = _cand(db, symbol="OMNIUSDT")
    ok = fusion.validate(db, c, bars, settings=Settings(), equity=10000, omnisignal=_result("BUY"), record=False)
    assert any(e["engine"] == "omnisignal_x" and e["bias"] == "bullish" for e in ok["engines"])
    assert ok["executable"] and "omnisignal_x" in next(c_["detail"] for c_ in ok["checks"] if c_["id"] == "V7_independent_engine_agreement")
    blocked = fusion.validate(db, c, bars, settings=Settings(), equity=10000, omnisignal=_result("SELL"), record=False)
    assert not blocked["executable"] and "V8_no_engine_veto" in blocked["hard_failures"]
    assert c.status not in ("CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")


async def test_gather_context_only_for_crypto_and_when_configured(db):
    c, bars = _cand(db, symbol="CTXUSDT")
    off = await gather_context(db, Settings(), c, bars)
    assert off["omnisignal"] is None and off["council"] is not None
    on = await gather_context(db, Settings(omnisignal_base_url="https://w.example"), c, bars, omni_client=_client(_result("BUY")))
    assert on["omnisignal"]["decision"] == "BUY"
    c.asset_class = "equity"
    async def no_fund(*a, **k):
        return None
    eq = await gather_context(db, Settings(omnisignal_base_url="https://w.example"), c, bars, omni_client=_client(_result("BUY")), fundamentals_fn=no_fund)
    assert eq["omnisignal"] is None and eq["council"] is None

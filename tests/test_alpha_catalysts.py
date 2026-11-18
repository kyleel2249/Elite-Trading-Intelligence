from datetime import date

import httpx
import pytest

from app.alpha import fusion
from app.alpha.catalysts import (SecSubmissions, insider_component, insider_summary, load_catalysts, parse_submissions)
from app.alpha.context import gather_context, load_catalysts_for
from app.alpha.db_models import AlphaAuditLog, AlphaCandidate, AlphaStrategyState, AlphaTradePlan
from app.alpha.styles import activist_presence, contrarian_value, deep_value, evaluate_styles, reflexivity
from app.config import Settings
from app.database import SessionLocal, init_db
from tests.test_alpha_ledger_investors import FORM4
from tests.test_alpha_pipeline import _cand

TODAY = date(2026, 11, 10)


def sub(rows):
    keys = ("form", "filingDate", "accessionNumber", "primaryDocument", "items")
    return {"filings": {"recent": {k: [r.get(k, "") for r in rows] for k in keys}}}


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    for m in (AlphaTradePlan, AlphaCandidate, AlphaAuditLog, AlphaStrategyState):
        s.query(m).delete()
    s.commit()
    yield s
    s.close()


def test_parse_submissions_classifies_8k_items_and_windows():
    p = parse_submissions(sub([
        {"form": "8-K", "filingDate": "2026-10-20", "accessionNumber": "0000000000-26-000001", "items": "1.03,9.01"},     # bankruptcy: hard
        {"form": "8-K", "filingDate": "2026-06-01", "accessionNumber": "0000000000-26-000002", "items": "3.01"},          # delisting but 162 days old: outside veto window
        {"form": "8-K", "filingDate": "2026-11-01", "accessionNumber": "0000000000-26-000003", "items": "2.02,2.06,5.02"},
        {"form": "SC 13D/A", "filingDate": "2026-09-02", "accessionNumber": "0000000000-26-000004"},
        {"form": "SCHEDULE 13G", "filingDate": "2024-01-02", "accessionNumber": "0000000000-24-000005"},                 # older than a year
        {"form": "4", "filingDate": "2026-10-30", "accessionNumber": "0001111111-26-000006", "primaryDocument": "xslF345X05/form4.xml"},
    ]), TODAY)
    assert [h["item"] for h in p["hard_negative"]] == ["1.03"] and p["hard_negative"][0]["confirmed"] is True
    assert [s["item"] for s in p["soft_negative"]] == ["2.06"] and {e["item"] for e in p["events"]} == {"2.02", "5.02"}
    assert [o["form"] for o in p["ownership_filings"]] == ["SC 13D/A"] and "not parsed" in p["ownership_filings"][0]["note"]
    assert len(p["form4"]) == 1 and parse_submissions({}, TODAY)["events"] == []
    assert not any(e["item"] == "9.01" for e in p["events"])  # exhibits are not events


def _tx(owner, shares, price, direction="buy", roles=("isDirector",), open_market=True):
    return {"owner": owner, "shares": shares, "price": price, "direction": direction, "roles": list(roles), "open_market": open_market}


def test_insider_summary_scores_only_officer_director_open_market_purchases():
    s = insider_summary([_tx("A", 1000, 50), _tx("B", 500, 40, roles=("isOfficer", "CFO")), _tx("C", 9999, 5, roles=("isTenPercentOwner",)),
                         _tx("D", 100, 10, open_market=False), _tx("E", 10000, 100, direction="sell")])
    assert s["distinct_buyers"] == 2 and s["purchase_value_usd"] == 70_000 and s["sale_value_usd"] == 1_000_000  # sales reported, never scored
    assert insider_component(s) == 70.0
    assert insider_component({"distinct_buyers": 3, "purchase_value_usd": 150_000}) == 80.0
    assert insider_component({"distinct_buyers": 1, "purchase_value_usd": 30_000}) == 60.0
    assert insider_component({"distinct_buyers": 1, "purchase_value_usd": 1_000}) is None and insider_component(insider_summary([])) is None  # no purchases = not measured, never "bad"


def _sec_client(submissions, form4=FORM4):
    def handler(req: httpx.Request) -> httpx.Response:
        if "/submissions/" in req.url.path:
            return httpx.Response(200, json=submissions)
        if req.url.path.endswith(".xml"):
            return httpx.Response(200, text=form4)
        return httpx.Response(404)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_load_catalysts_reads_form4_via_raw_xml_path_and_survives_bad_filings(db):
    seen = []
    s = sub([{"form": "4", "filingDate": "2026-10-30", "accessionNumber": "0001111111-26-000006", "primaryDocument": "xslF345X05/form4.xml"},
             {"form": "4", "filingDate": "2026-10-29", "accessionNumber": "0001111111-26-000007", "primaryDocument": "../evil.xml"}])
    cl = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: (seen.append(r.url.path), httpx.Response(200, json=s) if "/submissions/" in r.url.path else httpx.Response(200, text=FORM4))[1]))
    out = await load_catalysts(SecSubmissions("ua", client=cl, db=db), 123, TODAY, use_cache=False)
    assert out["insider"]["distinct_buyers"] == 1 and out["insider"]["form4_filings_read"] >= 1
    assert any(p.endswith("/form4.xml") and "xslF345" not in p for p in seen)           # the XSL display prefix is stripped to reach the raw XML
    assert not any("evil" in p for p in seen)                                            # a path-traversal document name is never fetched
    assert out["confirmed_source"].startswith("SEC EDGAR")


async def test_malicious_form4_is_skipped_not_fatal(db):
    bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><ownershipDocument>&b;</ownershipDocument>'
    s = sub([{"form": "4", "filingDate": "2026-10-30", "accessionNumber": "0001111111-26-000006", "primaryDocument": "f.xml"}])
    out = await load_catalysts(SecSubmissions("ua", client=_sec_client(s, bomb), db=db), 5, TODAY, use_cache=False)
    assert out["insider"]["form4_filings_skipped"] == 1 and out["insider"]["distinct_buyers"] == 0


async def test_load_catalysts_returns_none_when_sec_is_down(db):
    cl = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert await load_catalysts(SecSubmissions("ua", client=cl, db=db), 9, TODAY, use_cache=False) is None


def _eq(db, symbol="EQCAT"):
    c, bars = _cand(db, symbol=symbol)
    c.asset_class = "equity"
    db.commit()
    return c, bars


def test_hard_risk_filing_is_a_veto_that_outbids_every_bullish_engine(db):
    c, bars = _eq(db)
    fusion.register_engine("plugin_b9", lambda ctx: fusion.EngineEvidence("plugin_b9", True, "bullish", 0.9))
    try:
        ok = fusion.validate(db, c, bars, settings=Settings(), equity=10000, catalysts={"hard_negative": [], "soft_negative": [], "events": [], "ownership_filings": [], "insider": {"distinct_buyers": 0, "purchase_value_usd": 0}}, record=False)
        assert ok["executable"] and any(e["engine"] == "catalysts" and not e["hard_veto"] for e in ok["engines"])
        veto = {"hard_negative": [{"date": "2026-10-20", "item": "4.02", "meaning": "non-reliance on previously issued financial statements"}], "soft_negative": [], "events": [], "ownership_filings": [],
                "insider": {"distinct_buyers": 5, "purchase_value_usd": 900_000, "form4_filings_read": 5, "form4_filings_skipped": 0}, "insider_component": 80.0}
        r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, catalysts=veto, record=False)
        assert not r["executable"] and "V8_no_engine_veto" in r["hard_failures"]  # heavy insider buying cannot override a non-reliance filing
        assert any("4.02" in line for e in r["engines"] if e["engine"] == "catalysts" for line in e["evidence"])
    finally:
        fusion._ENGINES.pop("plugin_b9", None)


def test_insider_buying_counts_as_independent_agreement_and_feeds_the_institutional_component(db):
    c, bars = _eq(db, "EQINS")
    cat = {"hard_negative": [], "soft_negative": [], "events": [], "ownership_filings": [], "insider_component": 70.0,
           "insider": {"distinct_buyers": 2, "purchase_value_usd": 70_000, "form4_filings_read": 2, "form4_filings_skipped": 0}}
    r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, catalysts=cat, record=False)
    assert next(e for e in r["engines"] if e["engine"] == "insider_activity")["bias"] == "bullish"
    assert "insider_activity" in next(x["detail"] for x in r["checks"] if x["id"] == "V7_independent_engine_agreement")
    assert r["early_alpha"]["coverage"] > fusion.validate(db, c, bars, settings=Settings(), equity=10000, record=False)["early_alpha"]["coverage"]  # a measured component raises evidence coverage


def test_soft_negative_filing_lowers_conviction_without_vetoing(db):
    e = fusion.engine_catalysts({"catalysts": {"hard_negative": [], "soft_negative": [{"date": "2026-11-01", "item": "2.06", "meaning": "material impairment"}], "events": [], "ownership_filings": []}})
    assert e.bias == "bearish" and not e.hard_veto
    assert not fusion.engine_catalysts({"catalysts": None}).available


# ------------------------------------------------------------------ styles
def feats(**kw):
    base = {"sufficient": True, "bars": 200, "dist_to_high": 0.5, "off_low_20": 0.05, "extension_50": 0.0, "rsi14": 50.0}
    base.update(kw)
    return base


QP = {"quality": {"verdict": "PASSES_SCREEN"}, "metrics": {"shares": 1_000_000, "fcf": 120_000, "equity": 600_000}}


def test_contrarian_value_needs_drawdown_stabilisation_and_quality():
    assert contrarian_value(feats(), QP)["state"] == "CANDIDATE"
    assert contrarian_value(feats(dist_to_high=0.2), QP)["state"] == "NO_FLAG"
    assert contrarian_value(feats(off_low_20=0.0), QP)["state"] == "NO_FLAG"          # still falling
    assert contrarian_value(feats(), {"quality": {"verdict": "FAILS_SCREEN"}})["state"] == "NO_FLAG"
    assert contrarian_value(feats(), None)["state"] == "NOT_EVALUABLE" and "not backtested" in contrarian_value(feats(), QP)["note"]


def test_deep_value_screen_and_value_trap_caveat():
    d = deep_value(1.0, QP)  # market cap 1.0M, FCF yield 12%, P/B 1.67 -> fails P/B
    assert d["state"] == "NO_FLAG"
    cheap = deep_value(0.8, QP)  # cap 0.8M: FCF yield 15%, P/B 1.33
    assert cheap["state"] == "CANDIDATE" and "value traps" in cheap["note"]
    assert deep_value(0.8, {**QP, "quality": {"verdict": "FAILS_SCREEN"}})["state"] == "NO_FLAG"
    assert deep_value(None, QP)["state"] == "NOT_EVALUABLE" and deep_value(1.0, {"quality": {}})["state"] == "NOT_EVALUABLE"


def test_reflexivity_flags_only_extended_and_crowded_or_overbought():
    assert reflexivity(feats(extension_50=0.6, rsi14=60), {"state": "CROWDED_LONG_RISK"}, "crypto")["state"] == "BOOM_LATE_STAGE"
    assert reflexivity(feats(extension_50=0.6, rsi14=80), None, "crypto")["state"] == "BOOM_LATE_STAGE"
    assert reflexivity(feats(extension_50=0.6, rsi14=60), {"state": "NEUTRAL"}, "crypto")["state"] == "NO_FLAG"   # extended but not crowded or overbought
    assert reflexivity(feats(extension_50=0.3, rsi14=80), None, "equity")["state"] == "BOOM_LATE_STAGE" and reflexivity(feats(extension_50=0.3, rsi14=80), None, "crypto")["state"] == "NO_FLAG"
    assert "macro leg" in reflexivity(feats(), None, "crypto")["note"]


def test_activist_presence_requires_filing_and_quality_and_is_honest_about_13g():
    own = {"ownership_filings": [{"date": "2026-09-02", "form": "SC 13D/A"}]}
    assert activist_presence(own, QP)["state"] == "ACTIVIST_INTEREST_PRESENT"
    assert activist_presence(own, {"quality": {"verdict": "FAILS_SCREEN"}})["state"] == "LARGE_HOLDER_FILING_ONLY"
    assert activist_presence({"ownership_filings": []}, QP)["state"] == "NO_FLAG" and activist_presence(None, QP)["state"] == "NOT_EVALUABLE"
    assert "13G is a passive-holder filing" in activist_presence(own, QP)["note"]


def test_style_screens_are_soft_evidence_not_independent_agreement(db):
    c, bars = _eq(db, "EQSTY")
    st = evaluate_styles(feats(), QP, None, None, 0.8, "equity")
    assert set(st) == {"reflexivity", "contrarian_value", "deep_value", "activist_presence"} and set(evaluate_styles(feats(), None, None, None, 1.0, "crypto")) == {"reflexivity"}
    r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, styles=st, record=False)
    e = next(x for x in r["engines"] if x["engine"] == "style_screens")
    assert e["bias"] == "bullish" and not e["hard_veto"] and "style_screens" not in next(x["detail"] for x in r["checks"] if x["id"] == "V7_independent_engine_agreement")
    boom = fusion.engine_style_screens({"styles": {"reflexivity": {"state": "BOOM_LATE_STAGE"}}})
    assert boom.bias == "bearish" and not boom.hard_veto


async def test_gather_context_adds_catalysts_and_styles_for_equities_only(db):
    c, bars = _eq(db, "EQCTX")

    async def macro(s):
        return {"status": "not_configured"}

    async def fund(*a, **k):
        return QP

    async def cats(*a, **k):
        return {"hard_negative": [], "soft_negative": [], "events": [], "ownership_filings": [], "insider": {"distinct_buyers": 0, "purchase_value_usd": 0}}
    ctx = await gather_context(db, Settings(), c, bars, macro_fn=macro, fundamentals_fn=fund, catalysts_fn=cats)
    assert ctx["catalysts"] is not None and "contrarian_value" in ctx["styles"]
    c.asset_class = "crypto"

    async def deriv(sym):
        return {"state": "NEUTRAL", "evidence": []}
    cr = await gather_context(db, Settings(), c, bars, macro_fn=macro, derivatives_fn=deriv, catalysts_fn=cats)
    assert cr["catalysts"] is None and set(cr["styles"]) == {"reflexivity"}


async def test_load_catalysts_for_maps_ticker_and_degrades(db):
    from app.alpha import context
    context._CIK.update(ts=0.0, map={})
    rows = {"fields": ["cik", "name", "ticker", "exchange"], "data": [[777, "Co", "TST", "NYSE"]]}

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=rows) if "company_tickers_exchange" in req.url.path else httpx.Response(200, json=sub([]))
    cl = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    from app.alpha.providers import SecTickerUniverse
    out = await load_catalysts_for(db, Settings(), "tst", tickers=SecTickerUniverse(client=cl, db=db), src=SecSubmissions("ua", client=cl, db=db))
    assert out is not None and out["insider"]["distinct_buyers"] == 0
    assert await load_catalysts_for(db, Settings(), "NOPE", tickers=SecTickerUniverse(client=cl, db=db)) is None

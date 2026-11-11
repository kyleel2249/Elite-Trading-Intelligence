import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.alpha.predictions import STRATEGY_TAG, alpha_predictions, record_alpha_prediction
from app.prediction_ledger.models import ImmutableRecordError
from app.alpha.coverage import build_registry
from app.alpha.db_models import WalletLabel
from app.alpha.investor_intel import (FOUNDATIONAL_35, assess_following, audit_profiles, disclosure_freshness, effective_profile,
                                      overlap_report, profile_history, propose_profile_update, qualify_investor)
from app.alpha.whales import add_wallet_label, analyze_transfers, attribute
from app.config import get_settings
from app.database import SessionLocal, init_db
from app.integrations.edgar.filings import accession_path, compare_13f, parse_13f_information_table, parse_form4, scale_13f_value


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    yield s
    s.close()


def _rec(db, sym="LEDG1", cid="crypto:BINANCE:LEDG1", **kw):
    args = dict(symbol=sym, asset_class="crypto", price=100.0, tp1=105.0, tp2=110.0, stop=95.0, probability=0.55, candidate_id=cid,
                stage="TREND_EXPANSION", regime="trend_up", reasoning="test", now=datetime.now(timezone.utc) + timedelta(days=int(uuid.uuid4().int % 100000)))
    args.update(kw)
    return record_alpha_prediction(db, **args)


def test_alpha_predictions_go_to_the_single_immutable_ledger(db):
    row, created = _rec(db, "LEDG1", "crypto:BINANCE:LEDG1")
    assert created and row.strategy == STRATEGY_TAG and row.direction == "up" and row.market == "crypto" and row.provider == "binance"
    assert row.entry_reference == 100.0 and row.invalidation_price == 95.0 and row.target_base == 105.0 and row.sources
    assert row.expires_at > row.created_at and len(row.content_hash) == 64
    with pytest.raises(ImmutableRecordError):  # main's ledger refuses rewrites
        row.entry_reference = 1.0
        db.commit()
    db.rollback()


def test_adapter_is_idempotent_per_candidate_hour_and_validates(db):
    when = datetime(2031, 5, 1, 10, 30, tzinfo=timezone.utc) + timedelta(days=int(uuid.uuid4().int % 100000))
    a, c1 = _rec(db, "LEDG2", "crypto:BINANCE:LEDG2", now=when)
    b, c2 = _rec(db, "LEDG2", "crypto:BINANCE:LEDG2", now=when, price=90.0, tp1=99.0, tp2=100.0, stop=80.0)
    assert c1 and not c2 and a.id == b.id and b.entry_reference == 100.0  # cannot re-state at a better price
    with pytest.raises(ValueError):
        _rec(db, stop=105.0)  # stop above price
    with pytest.raises(ValueError):
        _rec(db, tp1=99.0)  # target below price
    with pytest.raises(ValueError):
        _rec(db, probability=1.0)


def test_alpha_prediction_listing_and_equity_mapping(db):
    row, _ = _rec(db, "EQT1", "equity:US:EQT1", asset_class="equity")
    assert row.market == "equity" and row.provider == "alpaca"
    assert any(p["asset"] == "EQT1" for p in alpha_predictions(db, 200))
    assert all(p["strategy"] == STRATEGY_TAG for p in alpha_predictions(db, 50))


# ------------------------------------------------------------------ SEC parsers
INFO = """<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>037833100</cusip><value>1000</value>
<shrsOrPrnAmt><sshPrnamt>5000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><investmentDiscretion>SOLE</investmentDiscretion></infoTable>
<infoTable><nameOfIssuer>ACME CORP</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>000111222</cusip><value>50</value>
<shrsOrPrnAmt><sshPrnamt>100</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><putCall>Put</putCall></infoTable></informationTable>"""

FORM4 = """<ownershipDocument><issuer><issuerName>Acme</issuerName><issuerTradingSymbol>ACM</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerName>Jane Doe</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>1</isDirector><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-10-01</value></transactionDate>
<transactionCoding><transactionCode>P</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>12.5</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>
<nonDerivativeTransaction><transactionDate><value>2026-10-02</value></transactionDate><transactionCoding><transactionCode>A</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>500</value></transactionShares></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>"""


def test_13f_parser_scale_and_compare():
    rows = parse_13f_information_table(INFO)
    assert len(rows) == 2 and rows[0]["cusip"] == "037833100" and rows[0]["shares"] == 5000 and rows[1]["put_call"] == "Put"
    assert scale_13f_value(1000, "2022-09-30") == 1_000_000 and scale_13f_value(1000, "2023-03-31") == 1000
    prev = [{"cusip": "A", "issuer": "A", "shares": 100}, {"cusip": "B", "issuer": "B", "shares": 100}, {"cusip": "C", "issuer": "C", "shares": 100}]
    curr = [{"cusip": "A", "issuer": "A", "shares": 200}, {"cusip": "B", "issuer": "B", "shares": 50}, {"cusip": "D", "issuer": "D", "shares": 10}]
    c = compare_13f(prev, curr)
    assert [x["cusip"] for x in c["added"]] == ["A"] and [x["cusip"] for x in c["trimmed"]] == ["B"]
    assert [x["cusip"] for x in c["new"]] == ["D"] and [x["cusip"] for x in c["exited"]] == ["C"]


def test_form4_only_open_market_flagged_and_accession_validated():
    tx = parse_form4(FORM4)
    assert tx[0]["direction"] == "buy" and tx[0]["open_market"] and tx[0]["ticker"] == "ACM" and "CEO" in tx[0]["roles"]
    assert tx[1]["open_market"] is False
    assert accession_path("1067983", "0001193125-24-012345").endswith("000119312524012345")
    with pytest.raises(ValueError):
        accession_path("1", "../../etc/passwd")


# ------------------------------------------------------------------ investors
def _q(**kw):
    base = dict(name="Test Investor", category="macro", years_documented=25, performance_evidence="primary_reported", return_basis="fund_level",
                risk_evidence=True, methodology_documented=True, basis_of_nomination="documented_track_record",
                sources=[{"kind": "fund_letter", "url": "https://a.example/letter"}, {"kind": "book", "url": "https://b.example/book"}])
    base.update(kw)
    return base


def test_qualification_criteria(db):
    ok = qualify_investor(db, _q())
    assert ok["status"] == "QUALIFIED" and any("fund returns" in f for f in ok["flags"])
    assert qualify_investor(db, _q(basis_of_nomination="net_worth"))["status"] == "REJECTED"
    assert qualify_investor(db, _q(basis_of_nomination="social_following"))["status"] == "REJECTED"
    assert qualify_investor(db, _q(years_documented=3))["status"] == "REJECTED"
    assert qualify_investor(db, _q(sources=[{"kind": "blog", "url": "https://x"}]))["status"] == "REJECTED"
    assert qualify_investor(db, _q(performance_evidence="none"))["status"] == "PENDING_EVIDENCE"


def test_13f_freshness_carries_delay():
    today = datetime(2026, 11, 9).date()
    f = disclosure_freshness({"category": "13f_holding", "period_of_report": "2026-06-30", "publication_date": "2026-08-14"}, today)
    assert f["information_delay_days"] == 45 and f["information_kind"] == "reported_holding" and f["level"] in ("AGING", "STALE")
    assert "not the investor's current portfolio" in f["warning"]
    old = disclosure_freshness({"category": "insider_buy", "transaction_date": "2025-01-01", "publication_date": "2025-01-03"}, today)
    assert old["level"] == "STALE"


def _act(**kw):
    a = {"category": "insider_buy", "direction": "buy", "source_provider": "sec_edgar", "verification_status": "VERIFIED",
         "transaction_date": "2026-11-01", "publication_date": "2026-11-03"}
    a.update(kw)
    return a


CAND = {"stage": "EARLY_ACCUMULATION", "scores": {"liquidity": 70}, "plan": {"entry_zone": [99, 100], "invalidation_level": 90, "atr14": 4}}


def test_following_never_authorizes_and_rejects_hard_failures():
    today = datetime(2026, 11, 9).date()
    r = assess_following(_act(), current_price=100, reference_price=98, candidate=CAND, investor_qualified=True, investor_modules=["m"],
                         lab_longs=["turtle_donchian"], today=today)
    assert r["authorizes_order"] is False and r["classification"] in ("INVESTOR_STRATEGY_MATCH", "CONTRARIAN_OPPORTUNITY", "INVESTOR_FOLLOWING_OPPORTUNITY")
    assert len(r["checks"]) == 12 and r["checks"][-1]["pass"] is None
    stale = assess_following(_act(transaction_date="2025-01-01", publication_date="2025-01-03"), current_price=100, reference_price=98,
                             candidate=CAND, investor_qualified=True, investor_modules=["m"], lab_longs=[], today=today)
    assert stale["classification"] == "STALE_DISCLOSURE"
    chase = assess_following(_act(), current_price=140, reference_price=100, candidate=CAND, investor_qualified=True, investor_modules=["m"],
                             lab_longs=["x"], today=today)
    assert chase["classification"] == "REJECTED_OPPORTUNITY"
    dist = assess_following(_act(), current_price=100, reference_price=100, candidate={**CAND, "stage": "DISTRIBUTION"}, investor_qualified=True,
                            investor_modules=["m"], lab_longs=["x"], today=today)
    assert dist["classification"] == "REJECTED_OPPORTUNITY"
    unverified = assess_following(_act(source_provider="twitter"), current_price=100, reference_price=100, candidate=CAND, investor_qualified=True,
                                  investor_modules=["m"], lab_longs=["x"], today=today)
    assert unverified["classification"] == "REJECTED_OPPORTUNITY"
    popular = assess_following(_act(), current_price=100, reference_price=100, candidate=CAND, investor_qualified=False, investor_modules=[],
                               lab_longs=["x"], today=today)
    assert popular["classification"] == "REJECTED_OPPORTUNITY"  # wealth/popularity alone is never enough


def test_overlap_report_filters_and_carries_dates():
    h = {"A": [{"cusip": "1", "issuer": "X", "shares": 1, "filing_date": "2026-08-14", "period_of_report": "2026-06-30"}],
         "B": [{"cusip": "1", "issuer": "X", "shares": 2, "filing_date": "2026-08-10", "period_of_report": "2026-06-30"}, {"cusip": "2", "issuer": "Y"}],
         "C": [{"cusip": "1", "issuer": "X", "shares": 3}]}
    r = overlap_report(h)
    assert r["overlaps"][0]["holder_count"] == 3 and r["overlaps"][0]["holders"]["A"]["filing_date"] == "2026-08-14"
    assert overlap_report(h, {"A", "B"})["overlaps"][0]["holder_count"] == 2


def test_profiles_all_35_present_and_audit_is_honest(db):
    a = audit_profiles(db)
    assert a["profiles"] == 35 == len(FOUNDATIONAL_35) and a["foundational_missing"] == []
    assert all(r["research_gaps"] or r["completeness_pct"] == 100 for r in a["results"])  # gaps are reported, not hidden
    buffett = next(r for r in a["results"] if r["trader_id"] == "warren_buffett")
    assert buffett["categories"]["win rates"]["status"] in ("UNKNOWN_PUBLICLY", "DOCUMENTED")


def test_profile_updates_are_versioned_and_need_sources(db):
    from app.alpha.db_models import TraderProfileVersion
    db.query(TraderProfileVersion).delete()
    db.commit()
    before = effective_profile(db, "ed_thorp")["philosophy"]
    with pytest.raises(ValueError):
        propose_profile_update(db, "ed_thorp", "philosophy", "x", "no source", [])
    with pytest.raises(ValueError):
        propose_profile_update(db, "ed_thorp", "id", "x", "bad field", [{"url": "https://s", "published": "2020-01-01"}])
    r = propose_profile_update(db, "ed_thorp", "philosophy", "Updated text", "primary memoir", [{"url": "https://s", "published": "2017-01-01"}])
    assert r["version"] == 2
    assert effective_profile(db, "ed_thorp")["philosophy"] == "Updated text"
    h = profile_history(db, "ed_thorp")
    assert h[0]["old"]["value"] == before  # previous version preserved


# ------------------------------------------------------------------ whales & coverage
def test_wallet_attribution_defaults_to_unattributed(db):
    db.query(WalletLabel).delete()
    db.commit()
    assert attribute(db, "eth", "0xabc0000000000000000000000000000000000001")["label"] is None
    with pytest.raises(ValueError):
        add_wallet_label(db, "eth", "0xabc0000000000000000000000000000000000002", "A Person", "individual", "rumor", 0.9, verified=False)
    with pytest.raises(ValueError):
        add_wallet_label(db, "eth", "0xabc0000000000000000000000000000000000002", "X", "exchange", "", 0.9)
    add_wallet_label(db, "eth", "0xABC0000000000000000000000000000000000003", "Exch hot wallet", "exchange", "https://explorer/label", 0.95, verified=False)
    a = attribute(db, "eth", "0xabc0000000000000000000000000000000000003")
    assert a["confidence"] == 0.5 and a["verified"] is False  # unverified capped


def test_whale_analysis_exchange_flows_and_limits():
    ex = "0x" + "e" * 40
    lab = {ex: {"entity_type": "exchange", "label": "Ex", "confidence": 0.9}}
    tx = [{"from": ex, "to": "0x" + "1" * 40, "value": str(10 ** 21), "tokenDecimal": "18", "hash": "h1", "timeStamp": "1"},
          {"from": "0x" + "2" * 40, "to": ex, "value": str(10 ** 20), "tokenDecimal": "18", "hash": "h2", "timeStamp": "2"}]
    r = analyze_transfers(tx, price_usd=1.0, threshold_usd=500, labels=lab)
    assert r["net_exchange_flow_usd"] < 0 and r["component"] > 50 and r["top_net_accumulators"][0]["attribution"]["label"] is None
    unlabeled = analyze_transfers(tx, price_usd=1.0, threshold_usd=500, labels={})
    assert unlabeled["component"] is None and unlabeled["net_exchange_flow_usd"] is None
    assert analyze_transfers([], price_usd=1, threshold_usd=1, labels={})["status"] == "no_data"


def test_coverage_registry_does_not_overclaim(db):
    reg = build_registry(db, get_settings())
    assert "Tokyo Stock Exchange" in reg["requested_exchanges_without_integration"]
    assert "does NOT cover global markets" in reg["claim"]
    assert all(p["status"] in ("OK", "UNVERIFIED", "NOT_CONFIGURED", "STALE", "DEGRADED", "FAILING") for p in reg["providers"])
    liquid = next(p for p in reg["providers"] if p["provider"] == "liquid")
    assert liquid["status"] == "NOT_CONFIGURED"


def test_explorer_errors_do_not_leak_api_key():
    import asyncio, httpx
    from app.integrations.explorer.client import ExplorerClient
    c = ExplorerClient("https://api.example/api", "SUPERSECRETKEY", httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    with pytest.raises(RuntimeError) as e:
        asyncio.run(c.token_transfers("0x" + "a" * 40))
    assert "SUPERSECRETKEY" not in str(e.value) and "api.example" not in str(e.value)


def test_research_overlay_adds_only_cited_reported_notes_and_keeps_gaps_honest():
    from app.knowledge.registry import get_trader
    for pid in ("stanley_druckenmiller", "peter_lynch", "jim_simons", "john_paulson", "charlie_munger"):
        p = get_trader(pid)
        cited = [n for n in p["historical_returns"] if "2026-11-09" in (n.get("source") or "") or "2026-11-10" in (n.get("source") or "")]
        assert cited and all(n["classification"] == "reported" and n["source"] for n in cited)
        assert any(("fund-level" in n["claim"] or "partnership-level" in n["claim"] or "personal" in (n.get("notes") or "")) for n in cited)  # fund vs personal never blurred
    a = audit_profiles(None, ["peter_lynch"])["results"][0]
    assert "drawdowns" in a["research_gaps"]  # no source found, so it is still reported as a gap, not invented
    assert audit_profiles(None, ["stanley_druckenmiller"])["results"][0]["categories"]["drawdowns"]["status"] == "DOCUMENTED"


def test_loss_records_keep_their_caveats_and_derived_numbers_are_labelled_estimates():
    from app.knowledge.registry import get_trader
    pa = get_trader("john_paulson")["historical_drawdowns"]
    assert any("51%" in n["claim"] and n["classification"] == "reported" and "declined to comment" in (n["notes"] or "") for n in pa)
    mu = get_trader("charlie_munger")["historical_drawdowns"]
    derived = [n for n in mu if "-53%" in n["claim"]]
    assert derived and derived[0]["classification"] == "estimate" and "derived" in derived[0]["notes"] + derived[0]["claim"]
    for pid in ("john_paulson", "charlie_munger"):
        assert audit_profiles(None, [pid])["results"][0]["categories"]["drawdowns"]["status"] == "DOCUMENTED"


def test_minervini_and_dennis_notes_record_contradictions_and_caveats():
    from app.knowledge.registry import get_trader
    mr = get_trader("mark_minervini")["historical_returns"]
    assert any("334.8%" in n["claim"] and "not independently audited" in n["notes"] for n in mr)
    dr = get_trader("richard_dennis")
    ret = next(n for n in dr["historical_returns"] if "$200 million" in n["claim"] and "2026-11-10" in n["source"])
    assert ret["classification"] == "estimate" and "Contradictory evidence recorded" in ret["notes"]
    dd = next(n for n in dr["historical_drawdowns"] if "1987" in n["claim"] and "2026-11-10" in n["source"])
    assert "80%" in dd["notes"] and "only the multiply-sourced" in dd["notes"]  # unsupported figure is flagged, not adopted
    for pid in ("mark_minervini", "richard_dennis"):
        assert audit_profiles(None, [pid])["results"][0]["categories"]["drawdowns"]["status"] == "DOCUMENTED"


def test_burry_and_jones_notes_flag_gross_net_confusion_and_outdated_claims():
    from app.knowledge.registry import get_trader
    b = get_trader("michael_burry")
    ret = next(n for n in b["historical_returns"] if "489.34%" in n["claim"] and "2026-11-10" in n["source"])
    assert "GROSS" in ret["notes"] and ret["classification"] == "reported"
    assert any("-18.2%" in n["claim"] for n in b["historical_drawdowns"])
    j = get_trader("paul_tudor_jones")
    r = next(n for n in j["historical_returns"] if "26%" in n["claim"] and "2026-11-10" in n["source"])
    assert "Contradictory evidence recorded" in r["notes"] and "fund-level" in r["claim"]
    dd = next(n for n in j["historical_drawdowns"] if "2008" in n["claim"] and "2026-11-10" in n["source"])
    assert "not adopted" in dd["notes"]  # the 'never a down year' claim is rejected, not repeated
    for pid in ("michael_burry", "paul_tudor_jones"):
        a = audit_profiles(None, [pid])["results"][0]["categories"]
        assert a["returns"]["status"] == "DOCUMENTED" and a["drawdowns"]["status"] == "DOCUMENTED"


def test_seykota_single_account_is_labelled_as_selected_and_estimated():
    from app.knowledge.registry import get_trader
    n = next(x for x in get_trader("ed_seykota")["historical_returns"] if "250,000%" in x["claim"] and "2026-11-10" in x["source"])
    assert n["classification"] == "estimate" and "Selection bias" in n["notes"] and "Contradictory evidence recorded" in n["notes"]
    assert audit_profiles(None, ["ed_seykota"])["results"][0]["categories"]["returns"]["status"] == "DOCUMENTED"


def test_not_documented_results_are_explicit_scoped_and_counted_as_unknown_not_gap():
    from app.knowledge.registry import get_trader
    for pid in ("richard_wyckoff", "kathy_lien"):
        n = [x for x in get_trader(pid)["historical_returns"] if x["classification"] == "not_documented" and "2026-11-10" in x["source"]]
        assert n and "One search pass, not exhaustive" in n[0]["notes"]  # the scope of the search is stated, not implied to be complete
        c = audit_profiles(None, [pid])["results"][0]["categories"]
        assert c["returns"]["status"] == "UNKNOWN_PUBLICLY" and c["drawdowns"]["status"] == "UNKNOWN_PUBLICLY"
    on = get_trader("william_oneil")["historical_returns"]
    est = next(x for x in on if "40% a year" in x["claim"] and "2026-11-10" in x["source"])
    assert est["classification"] == "estimate" and "unverified" in est["notes"]
    assert any("lagged" in x["claim"] and x["classification"] == "reported" for x in on)  # counter-evidence is kept alongside the flattering claim

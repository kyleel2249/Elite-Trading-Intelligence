"""Discovery AI: scan, featurise, score, stage and persist candidates.

Discovery can never authorize a trade. Its highest status is DEVELOPING_OPPORTUNITY;
CONFIRMED / HIGH_CONVICTION are assigned only by the independent Decision layer
(app.alpha.fusion). Rejected candidates are stored with reasons.
"""
from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaCandidate, AlphaCandidateSnapshot
from app.alpha.features import compute_features
from app.alpha.derivatives import detect_new_listings
from app.alpha.providers import AlpacaMarketData, BinanceUniverse, DexScreener
from app.alpha.scoring import classify_stage, components_from_features, score_early_alpha
from app.alpha.token_safety import screen_dex_pair

logger = logging.getLogger("eti.alpha")
STABLE_BASES = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "GBP", "AUD", "BUSD", "USDE", "PYUSD", "USD1"}
DISCOVERY_MAX = "DEVELOPING_OPPORTUNITY"
STATUSES = ("WATCHLIST", "EARLY_ACCUMULATION", "DEVELOPING_OPPORTUNITY", "CONFIRMED_OPPORTUNITY",
            "HIGH_CONVICTION_OPPORTUNITY", "REJECTED", "INVALIDATED")
VALIDATION_MAX_AGE_H = 24
MIN_LIQ = {"crypto": 1_000_000.0, "equity": 1_000_000.0, "etf": 1_000_000.0, "token": 25_000.0}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def structural_plan(f: dict[str, Any], stage: Optional[str]) -> dict[str, Any]:
    last, a = f["last"], f.get("atr14") or 0.0
    if stage in ("BREAKOUT_FORMATION", "BREAKOUT_CONFIRMATION"):
        zone = [round(f["prior_high_20"], 8), round(f["prior_high_20"] * 1.01, 8)]
    else:
        zone = [round(last - 0.5 * a, 8), round(last, 8)]
    inv = round(f["low_20"] - 0.5 * a, 8)
    return {"entry_zone": zone, "invalidation_level": inv, "atr14": a,
            "note": "Candidate levels for research; the Decision layer recomputes entry/stop/targets independently."}


def discovery_status(score: Optional[float], stage: Optional[str], rejected: bool) -> str:
    if rejected:
        return "REJECTED"
    if score is None:
        return "WATCHLIST"
    if stage in ("DISTRIBUTION", "REVERSAL_RISK", "MOMENTUM_EXHAUSTION"):
        return "WATCHLIST"
    if stage in ("BREAKOUT_FORMATION", "BREAKOUT_CONFIRMATION", "TREND_EXPANSION") and score >= 60:
        return DISCOVERY_MAX
    if stage in ("EARLY_ACCUMULATION", "PRE_ACCUMULATION") and score >= 55:
        return "EARLY_ACCUMULATION"
    return "WATCHLIST"


def subscores(f: dict[str, Any], comps: dict[str, Optional[float]], early: dict[str, Any], safety: Optional[dict] = None,
              asset_class: str = "crypto") -> dict[str, Any]:
    tech = None
    if f.get("sufficient"):
        parts = [x for x in (comps.get("regime"), comps.get("momentum"), comps.get("relative_strength")) if x is not None]
        tech = sum(parts) / len(parts) if parts else None
    risk = None
    if f.get("atr_pct") is not None:
        cap = 0.12 if asset_class in ("crypto", "token") else 0.06
        risk = min(100.0, f["atr_pct"] / cap * 100)
        if safety and safety.get("verdict") in ("HIGH_RISK", "BLOCKED"):
            risk = max(risk, 90.0)
    return {"early_alpha": early.get("score"), "technical": tech, "fundamental": None, "institutional": comps.get("institutional"),
            "investor_following": None, "onchain": comps.get("onchain"), "liquidity": comps.get("liquidity"), "risk": risk,
            "independent_validation": None, "early_alpha_coverage": early.get("coverage"), "early_alpha_band": early.get("band")}


RANK_W = {"early_alpha": .30, "technical": .20, "fundamental": .10, "institutional": .10, "investor_following": .05,
          "onchain": .05, "liquidity": .10, "independent_validation": .25}


def overall_rank(sub: dict[str, Any]) -> Optional[float]:
    avail = {k: sub[k] for k in RANK_W if sub.get(k) is not None}
    if not avail:
        return None
    w = sum(RANK_W[k] for k in avail)
    base = sum(avail[k] * RANK_W[k] for k in avail) / w
    base -= 0.2 * (sub.get("risk") or 0.0)
    if sub.get("independent_validation") is None:
        base *= 0.8  # validated opportunities outrank equally-scored unvalidated ones
    return round(max(0.0, min(100.0, base)), 1)


def upsert_candidate(db: Session, *, candidate_id: str, asset_class: str, symbol: str, provider: str, status: str,
                     stage: Optional[str], early: dict[str, Any], sub: dict[str, Any], reasons: list[str],
                     rejection: Optional[list[str]] = None, evidence: Optional[dict] = None, plan: Optional[dict] = None,
                     price: Optional[float] = None, market_cap: Optional[float] = None, volume: Optional[float] = None,
                     name: Optional[str] = None, exchange: Optional[str] = None, chain: Optional[str] = None,
                     contract: Optional[str] = None, data_status: str = "fresh", bench_price: Optional[float] = None) -> AlphaCandidate:
    row = db.query(AlphaCandidate).filter_by(candidate_id=candidate_id).one_or_none()
    now = now_utc().replace(tzinfo=None)
    if row is None:
        row = AlphaCandidate(candidate_id=candidate_id, asset_class=asset_class, symbol=symbol, provider=provider, first_seen=now, scan_count=0)
        db.add(row)
    else:
        prior = (row.plan or {}).get("invalidation_level")
        if prior and price is not None and price < prior and row.status not in ("REJECTED", "INVALIDATED") and row.status != "WATCHLIST":
            status, reasons = "INVALIDATED", [f"price {price} breached invalidation level {prior}"] + reasons
        fresh_approval = bool(row.validated_at and (now - row.validated_at).total_seconds() < VALIDATION_MAX_AGE_H * 3600)
        if fresh_approval and status in ("WATCHLIST", "EARLY_ACCUMULATION", DISCOVERY_MAX) and row.status in (
                "CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY") and status != "INVALIDATED":
            status = row.status  # a rescan cannot silently downgrade a fresh decision-layer approval; stale ones expire
    row.name, row.exchange, row.chain, row.contract = name or row.name, exchange or row.exchange, chain or row.chain, contract or row.contract
    row.status, row.stage = status, stage
    row.early_alpha_score = early.get("score")
    row.scores = {**sub, "early_alpha_detail": {k: early.get(k) for k in ("raw_score", "coverage", "uncertainty", "band", "used", "missing")}}
    row.overall_rank_score = overall_rank(sub)
    row.reasons, row.rejection_reasons, row.evidence = reasons, rejection or [], evidence or {}
    row.plan = plan if plan is not None else row.plan
    row.last_price, row.market_cap, row.volume_24h, row.data_status = price, market_cap, volume, data_status
    row.scan_count = (row.scan_count or 0) + 1
    row.last_seen = now
    db.commit()
    record_snapshot(db, row, bench_price, now)
    return row


SNAPSHOT_MIN_GAP_HOURS = 6


def record_snapshot(db: Session, row: AlphaCandidate, bench_price: Optional[float], now: datetime) -> None:
    """Append what ETI saw now (throttled to one per candidate per few hours). Never rewrites history."""
    if row.last_price is None or row.last_price <= 0:
        return
    last = (db.query(AlphaCandidateSnapshot).filter_by(candidate_id=row.candidate_id)
            .order_by(AlphaCandidateSnapshot.ts.desc()).first())
    if last is not None and (now - last.ts).total_seconds() < SNAPSHOT_MIN_GAP_HOURS * 3600:
        return
    db.add(AlphaCandidateSnapshot(candidate_id=row.candidate_id, ts=now, asset_class=row.asset_class, symbol=row.symbol, status=row.status,
                                  stage=row.stage, early_alpha_score=row.early_alpha_score, price=row.last_price, bench_price=bench_price))
    db.commit()


def evaluate_ohlcv(db: Session, *, asset_class: str, symbol: str, bars: list[dict[str, Any]], provider: str,
                   bench_closes: Optional[list[float]] = None, exchange: Optional[str] = None, name: Optional[str] = None,
                   market_cap: Optional[float] = None, volume_24h: Optional[float] = None) -> AlphaCandidate:
    cid = f"{asset_class}:{exchange or provider}:{symbol}"
    f = compute_features(bars, bench_closes)
    if not f.get("sufficient"):
        return upsert_candidate(db, candidate_id=cid, asset_class=asset_class, symbol=symbol, provider=provider, status="REJECTED",
                                stage=None, early={"score": None}, sub={}, reasons=[], rejection=[f"insufficient history: {f.get('bars')} bars"],
                                exchange=exchange, name=name, data_status="insufficient")
    comps = components_from_features(f, asset_class)
    early = score_early_alpha(asset_class, comps)
    stg = classify_stage(f, asset_class)
    rejection: list[str] = []
    dv = f.get("dollar_volume_20") or 0.0
    if dv < MIN_LIQ.get(asset_class, 1e6) * 0.25:
        rejection.append(f"illiquid: 20-bar average dollar volume {dv:,.0f}")
    sub = subscores(f, comps, early, None, asset_class)
    status = discovery_status(early.get("score"), stg["stage"], bool(rejection))
    reasons = list(stg["reasons"]) + [f"early alpha {early.get('score')} (coverage {early.get('coverage')})"]
    evidence = {"features": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in f.items()},
                "components": {k: (round(v, 1) if v is not None else None) for k, v in comps.items()},
                "bars": len(bars), "bar_interval": "1d"}
    return upsert_candidate(db, candidate_id=cid, asset_class=asset_class, symbol=symbol, provider=provider, status=status,
                            stage=stg["stage"], early=early, sub=sub, reasons=reasons, rejection=rejection, evidence=evidence,
                            plan=structural_plan(f, stg["stage"]), price=f["last"], market_cap=market_cap, volume=volume_24h,
                            name=name, exchange=exchange, bench_price=(bench_closes[-1] if bench_closes else None))


class DiscoveryEngine:
    def __init__(self, db: Session, binance: Optional[BinanceUniverse] = None, dex: Optional[DexScreener] = None,
                 alpaca: Optional[AlpacaMarketData] = None, concurrency: int = 5):
        self.db = db
        self.binance = binance or BinanceUniverse(db=db)
        self.dex = dex or DexScreener(db=db)
        self.alpaca = alpaca
        self.sem = asyncio.Semaphore(concurrency)

    async def _bars(self, fetch, *args) -> Optional[list[dict[str, Any]]]:
        async with self.sem:
            try:
                return await fetch(*args)
            except Exception:  # noqa: BLE001 - provider status already recorded
                logger.warning("bar fetch failed %s", args, exc_info=True)
                return None

    async def scan_crypto(self, limit: int = 40, min_quote_volume: float = 2_000_000.0, seed: Optional[int] = None) -> dict[str, Any]:
        tickers = await self.binance.tickers_24h()
        usable = [t for t in tickers if t["quote_volume"] >= min_quote_volume and t["symbol"][:-4] not in STABLE_BASES]
        excluded_moved = [t for t in usable if t["change_pct"] > 40]
        pool = [t for t in usable if -20 <= t["change_pct"] <= 40]
        pool.sort(key=lambda t: -t["quote_volume"])
        head, tail = pool[: limit // 2], pool[limit // 2:]
        rng = random.Random(seed if seed is not None else int(now_utc().strftime("%Y%m%d")))  # noqa: S311 - coverage rotation, not security
        rng.shuffle(tail)  # rotating long-tail sample so results are not only mega-caps
        picks = head + tail[: limit - len(head)]
        btc = await self._bars(self.binance.klines, "BTCUSDT", "1d", 200)
        bench = [b["close"] for b in btc] if btc else None
        results = await asyncio.gather(*[self._bars(self.binance.klines, t["symbol"], "1d", 200) for t in picks])
        scanned, failed = 0, []
        for t, bars in zip(picks, results, strict=True):
            if not bars:
                failed.append(t["symbol"])
                continue
            evaluate_ohlcv(self.db, asset_class="crypto", symbol=t["symbol"], bars=bars, provider="binance_public", exchange="BINANCE",
                           bench_closes=bench, volume_24h=t["quote_volume"])
            scanned += 1
        listings: dict[str, Any] = {"status": "skipped"}
        try:
            sweep = detect_new_listings(self.db, "binance_public", await self.binance.spot_symbols())
            for sym in sweep["new"][:10]:
                bars = await self._bars(self.binance.klines, sym, "1d", 200)
                if bars:
                    c = evaluate_ohlcv(self.db, asset_class="crypto", symbol=sym, bars=bars, provider="binance_public", exchange="BINANCE", bench_closes=bench)
                    c.reasons = [f"NEW_LISTING first seen {now_utc().date().isoformat()}"] + list(c.reasons or [])
                    self.db.commit()
            listings = {"status": "ok", "baseline_seeded": sweep["baseline_seeded"], "new_listings": sweep["new"]}
        except Exception:  # noqa: BLE001 - provider status already recorded
            listings = {"status": "error"}
        return {"universe_usdt_pairs": len(tickers), "liquid_pairs": len(usable), "scanned": scanned, "failed": failed, "new_listings": listings,
                "skipped_already_extended": len(excluded_moved), "coverage_note": "Binance spot USDT pairs only; not all crypto assets."}

    async def scan_equities(self, symbols: Optional[list[str]] = None, use_screeners: bool = True, limit: int = 40) -> dict[str, Any]:
        if self.alpaca is None or not self.alpaca.configured:
            return {"status": "not_configured", "scanned": 0, "detail": "ALPACA_API_KEY/ALPACA_SECRET_KEY required for equity bars"}
        syms = [s.upper() for s in (symbols or [])]
        sources = {"configured": len(syms)}
        if use_screeners:
            try:
                mv = await self.alpaca.most_actives(25)
                act = [m["symbol"] for m in mv if m.get("symbol")]
                syms += act
                sources["most_actives"] = len(act)
            except Exception:  # noqa: BLE001
                sources["most_actives"] = "error"
        syms = list(dict.fromkeys(syms))[:limit]
        spy = await self._bars(self.alpaca.daily_bars, "SPY", 250)
        bench = [b["close"] for b in spy] if spy else None
        results = await asyncio.gather(*[self._bars(self.alpaca.daily_bars, s, 250) for s in syms])
        scanned, failed = 0, []
        for s, bars in zip(syms, results, strict=True):
            if not bars:
                failed.append(s)
                continue
            evaluate_ohlcv(self.db, asset_class="equity", symbol=s, bars=bars, provider="alpaca_data", exchange="US", bench_closes=bench)
            scanned += 1
        return {"status": "ok", "scanned": scanned, "failed": failed, "sources": sources,
                "coverage_note": "US-listed equities on Alpaca's IEX feed (free tier); no international exchanges are integrated."}

    async def scan_dex(self, limit: int = 30) -> dict[str, Any]:
        profiles = await self.dex.latest_profiles()
        by_chain: dict[str, list[str]] = {}
        for p in profiles[:100]:
            by_chain.setdefault(p["chainId"], []).append(p["tokenAddress"])
        scanned, blocked = 0, 0
        for chain, addrs in by_chain.items():
            try:
                pairs = await self.dex.pairs_for_tokens(chain, addrs)
            except Exception:  # noqa: BLE001 - provider status already recorded; one chain failing must not stop the sweep
                logger.warning("dex pair lookup failed for chain %s", chain, exc_info=True)
                continue
            best: dict[str, dict[str, Any]] = {}
            for pr in pairs:
                tok = ((pr.get("baseToken") or {}).get("address") or "").lower()
                liq = float((pr.get("liquidity") or {}).get("usd") or 0)
                if tok and liq >= float((best.get(tok, {}).get("liquidity") or {}).get("usd") or 0):
                    best[tok] = pr
            for pr in list(best.values())[: max(0, limit - scanned)]:
                if self._dex_candidate(pr, chain):
                    scanned += 1
                else:
                    blocked += 1
        return {"profiles": len(profiles), "scanned": scanned, "blocked_by_safety_screen": blocked,
                "coverage_note": "Tokens with a DexScreener profile only; holder/contract data is NOT available from this source."}

    def _dex_candidate(self, pr: dict[str, Any], chain: str) -> bool:
        base = pr.get("baseToken") or {}
        addr = (base.get("address") or "").lower()
        safety = screen_dex_pair(pr)
        vol = pr.get("volume") or {}
        chg = pr.get("priceChange") or {}
        tx = ((pr.get("txns") or {}).get("h24")) or {}
        liq = float((pr.get("liquidity") or {}).get("usd") or 0)
        buys, sells = float(tx.get("buys") or 0), float(tx.get("sells") or 0)
        comps = {c: None for c in ("accumulation", "volume_anomaly", "momentum", "relative_strength", "catalyst",
                                   "institutional", "onchain", "liquidity", "valuation", "regime")}
        if buys + sells > 0:
            comps["accumulation"] = max(0.0, min(100.0, (buys / max(sells, 1.0) - 0.8) / 0.8 * 100))
        if vol.get("h24") and liq:
            comps["volume_anomaly"] = max(0.0, min(100.0, (float(vol["h24"]) / liq) / 5 * 100))
        h24 = chg.get("h24")
        if h24 is not None:
            comps["momentum"] = max(0.0, min(100.0, 50 + float(h24) / 2)) if float(h24) < 100 else 20.0
        comps["liquidity"] = max(0.0, min(100.0, liq / 500_000 * 100))
        early = score_early_alpha("token", comps)
        cid = f"token:{chain}:{addr}"
        rejection = [f["message"] for f in safety["flags"] if f["level"] == "HARD"]
        status = discovery_status(early.get("score"), None, bool(rejection))
        sub = {"early_alpha": early.get("score"), "technical": None, "fundamental": None, "institutional": None,
               "investor_following": None, "onchain": None, "liquidity": comps["liquidity"],
               "risk": 90.0 if safety["verdict"] in ("HIGH_RISK", "BLOCKED") else 60.0 if safety["verdict"] == "CAUTION" else 45.0,
               "independent_validation": None, "early_alpha_coverage": early.get("coverage"), "early_alpha_band": early.get("band")}
        upsert_candidate(self.db, candidate_id=cid, asset_class="token", symbol=base.get("symbol") or addr[:8], provider="dexscreener",
                         status=status, stage=None, early=early, sub=sub,
                         reasons=[f"safety verdict {safety['verdict']}"] + [f["message"] for f in safety["flags"]],
                         rejection=rejection, evidence={"safety": safety, "pair": {k: pr.get(k) for k in ("dexId", "pairAddress", "url", "pairCreatedAt")}},
                         price=float(pr["priceUsd"]) if pr.get("priceUsd") else None, market_cap=pr.get("marketCap"),
                         volume=float(vol["h24"]) if vol.get("h24") else None, name=base.get("name"), exchange=pr.get("dexId"),
                         chain=chain, contract=addr)
        return not rejection


def leaderboard(db: Session, asset_class: Optional[str] = None, status: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
    q = db.query(AlphaCandidate)
    if asset_class:
        q = q.filter(AlphaCandidate.asset_class == asset_class)
    if status:
        q = q.filter(AlphaCandidate.status == status)
    else:
        q = q.filter(AlphaCandidate.status.notin_(("REJECTED", "INVALIDATED")))
    rows = q.order_by(AlphaCandidate.overall_rank_score.desc().nullslast(), AlphaCandidate.last_seen.desc()).limit(min(limit, 200)).all()
    return [candidate_dict(r) for r in rows]


def candidate_dict(r: AlphaCandidate) -> dict[str, Any]:
    return {"candidate_id": r.candidate_id, "asset_class": r.asset_class, "symbol": r.symbol, "name": r.name, "exchange": r.exchange,
            "chain": r.chain, "contract": r.contract, "status": r.status, "stage": r.stage, "early_alpha_score": r.early_alpha_score,
            "overall_rank_score": r.overall_rank_score, "scores": r.scores, "reasons": r.reasons, "rejection_reasons": r.rejection_reasons,
            "plan": r.plan, "last_price": r.last_price, "market_cap": r.market_cap, "volume_24h": r.volume_24h, "data_status": r.data_status,
            "provider": r.provider, "discovered_at": r.first_seen.isoformat() if r.first_seen else None,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None, "scan_count": r.scan_count,
            "validated_at": r.validated_at.isoformat() if r.validated_at else None,
            "validation_stale": bool(r.validated_at and (now_utc().replace(tzinfo=None) - r.validated_at).total_seconds() > VALIDATION_MAX_AGE_H * 3600)}

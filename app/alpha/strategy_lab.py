"""Elite Strategy Competition Laboratory.

- Next-bar-open fills (no lookahead), per-side fee + slippage.
- Walk-forward optimisation: parameters chosen on in-sample data only, judged on
  the following out-of-sample segment; only OOS trades count toward promotion.
- Promotion requires statistical evidence (trades, t-stat with a multiple-testing
  haircut, profit factor, fold consistency, drawdown, IS->OOS degradation).
- Champion/challenger with automatic rollback after consecutive failures.
"""
from __future__ import annotations

import math
from typing import Any, Optional, Sequence

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaStrategyRun, AlphaStrategyState
from app.alpha.features import atr, sma
from app.alpha.strategy_library import LIBRARY, Strategy

DEFAULT_COSTS_BPS = {"equity": 5.0, "etf": 4.0, "crypto": 12.0, "forex": 3.0, "commodity": 8.0, "token": 60.0}

PROMOTION_GATE = {"min_oos_trades": 30, "min_profit_factor": 1.2, "min_positive_fold_ratio": 0.5,
                  "max_oos_drawdown_pct": 35.0, "min_oos_to_is_ratio": 0.4, "base_t_stat": 2.0, "min_folds": 3}


def detect_regime(bars: Sequence[dict[str, Any]]) -> dict[str, Any]:
    closes = [float(b["close"]) for b in bars]
    if len(closes) < 60:
        return {"trend": "unknown", "volatility": "unknown", "regimes": ["any"]}
    s50 = sma(closes, 50)
    s50_prev = sum(closes[-60:-10]) / 50
    s200 = sma(closes, 200)
    slope = s50 / s50_prev - 1 if s50_prev else 0.0
    last = closes[-1]
    if last > s50 and slope > 0.01 and (s200 is None or last > s200):
        trend = "trend_up"
    elif last < s50 and slope < -0.01:
        trend = "trend_down"
    else:
        trend = "range"
    a14, a50 = atr(bars, 14), (atr(bars, 50) if len(bars) > 55 else None)
    vol = "normal"
    if a14 and a50:
        ratio = a14 / a50
        vol = "high" if ratio > 1.3 else "low" if ratio < 0.75 else "normal"
    regimes = ["any", trend] + (["high_vol"] if vol == "high" else [])
    return {"trend": trend, "volatility": vol, "regimes": regimes, "sma50_slope": round(slope, 4)}


def compatibility(strategy_id: str, asset_class: str, timeframe: str, regime: dict[str, Any]) -> dict[str, Any]:
    """Is this strategy appropriate here? Explains every refusal."""
    s = LIBRARY.get(strategy_id)
    if s is None:
        return {"compatible": False, "reasons": ["unknown strategy"]}
    reasons: list[str] = []
    if asset_class not in s.asset_classes:
        reasons.append(f"{s.name} is not specified for {asset_class}")
    if timeframe not in s.timeframes:
        reasons.append(f"timeframe {timeframe} outside supported {list(s.timeframes)}")
    if not s.executable:
        reasons.append("requires external data: " + ", ".join(s.requires_data))
    prefs = set(s.regimes)
    if "any" not in prefs and not (prefs & set(regime.get("regimes", ["any"]))):
        reasons.append(f"current regime {regime.get('trend')} not in preferred {sorted(prefs)}")
    for u in s.unsuited:
        if "range" in u and regime.get("trend") == "range" and s.family == "trend":
            reasons.append("trend system in a range regime")
    return {"compatible": not reasons, "reasons": reasons or ["compatible"], "strategy": s.name}


def simulate(bars: Sequence[dict[str, Any]], positions: Sequence[int], cost_bps: float) -> dict[str, Any]:
    """Fill at next open; costs applied each side. Returns trade list + metrics."""
    n = len(bars)
    cost = cost_bps / 10_000.0
    opens = [float(b["open"]) for b in bars]
    closes = [float(b["close"]) for b in bars]
    trades: list[dict[str, Any]] = []
    entry_px, entry_i = None, 0
    equity, peak, max_dd, curve = 1.0, 1.0, 0.0, [1.0]
    held_bars = 0
    for i in range(1, n):
        want = positions[i - 1]  # decision made at close of bar i-1, filled at open of bar i
        if want == 1 and entry_px is None:
            entry_px, entry_i = opens[i] * (1 + cost), i
        elif want == 0 and entry_px is not None:
            exit_px = opens[i] * (1 - cost)
            ret = exit_px / entry_px - 1
            trades.append({"entry_i": entry_i, "exit_i": i, "ret": ret})
            equity *= 1 + ret
            entry_px = None
        mark = equity if entry_px is None else equity * (closes[i] / entry_px)
        if entry_px is not None:
            held_bars += 1
        peak = max(peak, mark)
        max_dd = max(max_dd, (peak - mark) / peak if peak else 0.0)
        curve.append(mark)
    if entry_px is not None:  # close the open trade at the last close for accounting
        ret = closes[-1] * (1 - cost) / entry_px - 1
        trades.append({"entry_i": entry_i, "exit_i": n - 1, "ret": ret, "open_at_end": True})
        equity *= 1 + ret
    return {"trades": trades, "metrics": metrics(trades, max_dd, held_bars, n), "final_equity": equity}


def metrics(trades: list[dict[str, Any]], max_dd: float = 0.0, held: int = 0, bars: int = 0) -> dict[str, Any]:
    rets = [t["ret"] for t in trades]
    k = len(rets)
    if k == 0:
        return {"trades": 0, "win_rate": None, "expectancy_pct": None, "profit_factor": None, "t_stat": None,
                "total_return_pct": 0.0, "max_drawdown_pct": round(max_dd * 100, 2), "exposure": round(held / bars, 3) if bars else None}
    wins = [r for r in rets if r > 0]
    losses = [-r for r in rets if r <= 0]
    mean = sum(rets) / k
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (k - 1)) if k > 1 else 0.0
    t = mean / (sd / math.sqrt(k)) if sd > 0 else None
    eq = 1.0
    for r in rets:
        eq *= 1 + r
    return {"trades": k, "win_rate": round(len(wins) / k, 4), "expectancy_pct": round(mean * 100, 4),
            "profit_factor": round(sum(wins) / sum(losses), 3) if losses and sum(losses) > 0 else (None if not wins else 99.0),
            "t_stat": round(t, 3) if t is not None else None, "total_return_pct": round((eq - 1) * 100, 3),
            "max_drawdown_pct": round(max_dd * 100, 2), "exposure": round(held / bars, 3) if bars else None}


def _run_params(strategy: Strategy, bars: Sequence[dict[str, Any]], params: dict[str, Any], cost_bps: float) -> dict[str, Any]:
    return simulate(bars, strategy.signal(bars, params), cost_bps)


def walk_forward(strategy: Strategy, bars: Sequence[dict[str, Any]], asset_class: str,
                 train: int = 250, test: int = 60, cost_bps: Optional[float] = None) -> dict[str, Any]:
    """Anchored-rolling walk-forward. Parameters are selected on the in-sample window
    only; the selected parameter set is then run on the next unseen window (with warm-up
    history so indicators are defined) and ONLY the unseen segment's trades are kept."""
    cost = DEFAULT_COSTS_BPS.get(asset_class, 10.0) if cost_bps is None else cost_bps
    n = len(bars)
    warm = max(strategy.min_bars, 60)
    folds: list[dict[str, Any]] = []
    oos_trades: list[dict[str, Any]] = []
    is_rets: list[float] = []
    start = 0
    while start + train + test <= n:
        is_bars = bars[start:start + train]
        best, best_score = strategy.param_grid[0], -1e9
        for params in strategy.param_grid:
            m = _run_params(strategy, is_bars, params, cost)["metrics"]
            score = (m["expectancy_pct"] if m["trades"] >= 3 else -1e6) or -1e6
            if score > best_score:
                best, best_score = params, score
        is_res = _run_params(strategy, is_bars, best, cost)
        is_rets.extend(t["ret"] for t in is_res["trades"])
        lo = max(0, start + train - warm)
        window = bars[lo:start + train + test]
        offset = start + train - lo
        res = _run_params(strategy, window, best, cost)
        seg_trades = [t for t in res["trades"] if t["entry_i"] >= offset]
        oos_trades.extend(seg_trades)
        seg_m = metrics(seg_trades)
        folds.append({"start": start, "train": train, "test": test, "params": best, "is_expectancy_pct": is_res["metrics"]["expectancy_pct"],
                      "oos_trades": seg_m["trades"], "oos_return_pct": seg_m["total_return_pct"], "oos_expectancy_pct": seg_m["expectancy_pct"]})
        start += test
    # OOS drawdown from sequential trade returns
    eq, peak, dd = 1.0, 1.0, 0.0
    for t in oos_trades:
        eq *= 1 + t["ret"]
        peak = max(peak, eq)
        dd = max(dd, (peak - eq) / peak)
    oos = metrics(oos_trades, dd)
    ins = metrics([{"ret": r} for r in is_rets])
    return {"strategy_id": strategy.id, "cost_bps": cost, "bars": n, "in_sample": ins, "out_of_sample": oos, "folds": folds}


def evaluate_promotion(wf: dict[str, Any], n_tested: int = 1, gate: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    g = {**PROMOTION_GATE, **(gate or {})}
    oos, ins, folds = wf["out_of_sample"], wf["in_sample"], wf["folds"]
    reasons: list[str] = []
    if len(folds) < g["min_folds"] or oos["trades"] < g["min_oos_trades"]:
        return {"verdict": "INSUFFICIENT_DATA", "reasons": [
            f"needs >= {g['min_folds']} folds and >= {g['min_oos_trades']} out-of-sample trades (have {len(folds)} folds, {oos['trades']} trades)"],
            "t_threshold": None}
    t_thr = g["base_t_stat"] + 0.25 * math.log(max(1, n_tested))
    if (oos["expectancy_pct"] or 0) <= 0:
        reasons.append(f"OOS expectancy {oos['expectancy_pct']}% not positive after costs")
    if oos["t_stat"] is None or oos["t_stat"] < t_thr:
        reasons.append(f"OOS t-stat {oos['t_stat']} below {t_thr:.2f} (haircut for {n_tested} strategies tested)")
    if (oos["profit_factor"] or 0) < g["min_profit_factor"]:
        reasons.append(f"profit factor {oos['profit_factor']} below {g['min_profit_factor']}")
    pos = sum(1 for f in folds if (f["oos_return_pct"] or 0) > 0 and f["oos_trades"] > 0)
    active = sum(1 for f in folds if f["oos_trades"] > 0) or 1
    if pos / active < g["min_positive_fold_ratio"]:
        reasons.append(f"only {pos}/{active} active folds profitable")
    if oos["max_drawdown_pct"] > g["max_oos_drawdown_pct"]:
        reasons.append(f"OOS drawdown {oos['max_drawdown_pct']}% above {g['max_oos_drawdown_pct']}%")
    if (ins["expectancy_pct"] or 0) > 0 and (oos["expectancy_pct"] or 0) < g["min_oos_to_is_ratio"] * ins["expectancy_pct"]:
        reasons.append("out-of-sample expectancy collapsed versus in-sample (overfit signature)")
    return {"verdict": "FAIL" if reasons else "PROMOTE", "reasons": reasons or ["all promotion gates passed"], "t_threshold": round(t_thr, 2)}


def _state(db: Session, sid: str, asset_class: str) -> AlphaStrategyState:
    row = db.query(AlphaStrategyState).filter_by(strategy_id=sid, asset_class=asset_class).one_or_none()
    if row is None:
        row = AlphaStrategyState(strategy_id=sid, asset_class=asset_class, status="CHALLENGER", version=1,
                                 consecutive_passes=0, consecutive_fails=0, live_trades=0, live_pnl=0.0)
        db.add(row)
        db.flush()
    return row


def apply_verdict(db: Session, sid: str, asset_class: str, verdict: str) -> AlphaStrategyState:
    """Champion needs two consecutive independent passes; a champion with two
    consecutive failures is rolled back to challenger (version bump)."""
    st = _state(db, sid, asset_class)
    if verdict == "PROMOTE":
        st.consecutive_passes += 1
        st.consecutive_fails = 0
        if st.consecutive_passes >= 2 and st.status != "CHAMPION":
            st.status, st.version = "CHAMPION", st.version + 1
    elif verdict == "FAIL":
        st.consecutive_fails += 1
        st.consecutive_passes = 0
        if st.status == "CHAMPION" and st.consecutive_fails >= 2:
            st.status, st.version = "CHALLENGER", st.version + 1  # automatic rollback
        elif st.consecutive_fails >= 4:
            st.status = "RETIRED"
    db.commit()
    return st


def record_live_outcome(db: Session, sid: str, asset_class: str, pnl: float) -> None:
    st = _state(db, sid, asset_class)
    st.live_trades += 1
    st.live_pnl += pnl
    db.commit()


def evaluate_strategy(db: Optional[Session], strategy_id: str, bars: Sequence[dict[str, Any]], asset_class: str,
                      symbol: str, timeframe: str = "1d", n_tested: int = 1, train: int = 250, test: int = 60,
                      apply_state: bool = True) -> dict[str, Any]:
    s = LIBRARY[strategy_id]
    if not s.executable:
        return {"strategy_id": strategy_id, "verdict": "NOT_TESTABLE", "reasons": ["requires external data: " + ", ".join(s.requires_data)]}
    if len(bars) < max(train + test, s.min_bars):
        return {"strategy_id": strategy_id, "verdict": "INSUFFICIENT_DATA", "reasons": [f"{len(bars)} bars; need {max(train + test, s.min_bars)}"]}
    wf = walk_forward(s, bars, asset_class, train=train, test=test)
    prom = evaluate_promotion(wf, n_tested=n_tested)
    out = {**wf, **prom, "symbol": symbol, "asset_class": asset_class, "timeframe": timeframe}
    if db is not None:
        db.add(AlphaStrategyRun(strategy_id=strategy_id, asset_class=asset_class, symbol=symbol, timeframe=timeframe, bars=len(bars),
                                in_sample=wf["in_sample"], out_of_sample=wf["out_of_sample"], folds=wf["folds"],
                                verdict=prom["verdict"], reasons=prom["reasons"]))
        db.commit()
        st = apply_verdict(db, strategy_id, asset_class, prom["verdict"]) if (apply_state and prom["verdict"] in ("PROMOTE", "FAIL")) else _state(db, strategy_id, asset_class)
        out["status"], out["version"] = st.status, st.version
    return out


def evaluate_pooled(db: Optional[Session], strategy_id: str, datasets: dict[str, Sequence[dict[str, Any]]], asset_class: str,
                    timeframe: str = "1d", n_tested: int = 1, train: int = 250, test: int = 60) -> dict[str, Any]:
    """Pool out-of-sample trades across several symbols of one asset class. This is the
    realistic route to a statistically meaningful sample on daily data. Pooled trades are
    treated as independent, which overstates significance when symbols are correlated,
    so the gate is applied with the same thresholds and the note says so."""
    s = LIBRARY[strategy_id]
    if not s.executable:
        return {"strategy_id": strategy_id, "verdict": "NOT_TESTABLE", "reasons": ["requires external data: " + ", ".join(s.requires_data)]}
    rets: list[float] = []
    is_rets: list[float] = []
    folds: list[dict[str, Any]] = []
    worst_dd = 0.0
    used: list[str] = []
    for sym, bars in datasets.items():
        if len(bars) < max(train + test, s.min_bars):
            continue
        wf = walk_forward(s, bars, asset_class, train=train, test=test)
        used.append(sym)
        folds.extend({**f, "symbol": sym} for f in wf["folds"])
        worst_dd = max(worst_dd, wf["out_of_sample"]["max_drawdown_pct"])
        # recover per-trade OOS returns by re-simulating is unnecessary: walk_forward keeps metrics only,
        # so pooled returns are rebuilt from fold results via a dedicated pass below
        rets.extend(_oos_returns(s, bars, asset_class, train, test))
        is_rets.append(wf["in_sample"]["expectancy_pct"] or 0.0)
    if not used:
        return {"strategy_id": strategy_id, "verdict": "INSUFFICIENT_DATA", "reasons": ["no dataset long enough"]}
    oos = metrics([{"ret": r} for r in rets], worst_dd / 100.0)
    ins_exp = sum(is_rets) / len(is_rets)
    wf = {"strategy_id": strategy_id, "bars": sum(len(datasets[u]) for u in used), "in_sample": {"expectancy_pct": round(ins_exp, 4)},
          "out_of_sample": oos, "folds": folds}
    prom = evaluate_promotion(wf, n_tested=n_tested)
    out = {**wf, **prom, "symbol": f"POOLED({len(used)})", "symbols": used, "asset_class": asset_class, "timeframe": timeframe,
           "pooling_note": "Trades pooled across symbols and treated as independent; correlation overstates significance."}
    if db is not None:
        db.add(AlphaStrategyRun(strategy_id=strategy_id, asset_class=asset_class, symbol=out["symbol"], timeframe=timeframe, bars=wf["bars"],
                                in_sample=wf["in_sample"], out_of_sample=oos, folds=folds[:200], verdict=prom["verdict"], reasons=prom["reasons"]))
        db.commit()
        if prom["verdict"] in ("PROMOTE", "FAIL"):
            st = apply_verdict(db, strategy_id, asset_class, prom["verdict"])
            out["status"], out["version"] = st.status, st.version
    return out


def _oos_returns(s: Strategy, bars: Sequence[dict[str, Any]], asset_class: str, train: int, test: int) -> list[float]:
    cost = DEFAULT_COSTS_BPS.get(asset_class, 10.0)
    warm = max(s.min_bars, 60)
    out: list[float] = []
    start, n = 0, len(bars)
    while start + train + test <= n:
        is_bars = bars[start:start + train]
        best, best_score = s.param_grid[0], -1e9
        for params in s.param_grid:
            m = _run_params(s, is_bars, params, cost)["metrics"]
            sc = (m["expectancy_pct"] if m["trades"] >= 3 else -1e6) or -1e6
            if sc > best_score:
                best, best_score = params, sc
        lo = max(0, start + train - warm)
        res = _run_params(s, bars[lo:start + train + test], best, cost)
        off = start + train - lo
        out.extend(t["ret"] for t in res["trades"] if t["entry_i"] >= off)
        start += test
    return out


def run_competition(db: Optional[Session], datasets: dict[tuple[str, str], Sequence[dict[str, Any]]],
                    timeframe: str = "1d", strategy_ids: Optional[list[str]] = None) -> dict[str, Any]:
    """Evaluate every compatible executable strategy on every dataset and rank by OOS t-stat."""
    ids = [i for i in (strategy_ids or list(LIBRARY)) if i in LIBRARY]
    planned: list[tuple[str, str, str]] = []
    for (ac, sym) in datasets:
        for sid in ids:
            s = LIBRARY[sid]
            if s.executable and ac in s.asset_classes and timeframe in s.timeframes:
                planned.append((sid, ac, sym))
    results, skipped = [], []
    class_sizes: dict[str, int] = {}
    for (ac, _sym) in datasets:
        class_sizes[ac] = class_sizes.get(ac, 0) + 1
    for sid, ac, sym in planned:
        # With several symbols in a class only the pooled verdict moves champion/challenger state,
        # so one competition run can never count as multiple independent confirmations.
        r = evaluate_strategy(db, sid, datasets[(ac, sym)], ac, sym, timeframe, n_tested=max(1, len(planned)),
                              apply_state=class_sizes.get(ac, 1) < 2)
        if "out_of_sample" not in r:  # not testable or too few bars to even run folds
            skipped.append({"strategy_id": sid, "symbol": sym, "reason": r["reasons"][0]})
            continue
        results.append(r)
    by_class: dict[str, dict[str, Sequence[dict[str, Any]]]] = {}
    for (ac, sym), bars in datasets.items():
        by_class.setdefault(ac, {})[sym] = bars
    for ac, group in by_class.items():
        if len(group) < 2:
            continue
        for sid in ids:
            sx = LIBRARY[sid]
            if sx.executable and ac in sx.asset_classes and timeframe in sx.timeframes:
                r = evaluate_pooled(db, sid, group, ac, timeframe, n_tested=max(1, len(planned)))
                if "out_of_sample" in r:
                    results.append(r)
    results.sort(key=lambda r: (r["out_of_sample"]["t_stat"] if r["out_of_sample"]["t_stat"] is not None else -99), reverse=True)
    board = [{"rank": i + 1, "strategy_id": r["strategy_id"], "symbol": r["symbol"], "asset_class": r["asset_class"],
              "verdict": r["verdict"], "status": r.get("status"), "oos": r["out_of_sample"], "in_sample": r["in_sample"]}
             for i, r in enumerate(results)]
    return {"evaluated": len(results), "skipped": skipped, "leaderboard": board, "tested_count": len(planned),
            "note": "Past out-of-sample results are not a forecast; promotion requires statistical gates and repeat confirmation."}


def combine_signals(a: str, b: str, bars: Sequence[dict[str, Any]], pa: Optional[dict] = None, pb: Optional[dict] = None) -> list[int]:
    """Long only when both modules are long (AND). Tested as its own independent model."""
    sa, sb = LIBRARY[a], LIBRARY[b]
    xa, xb = sa.signal(bars, pa or sa.param_grid[0]), sb.signal(bars, pb or sb.param_grid[0])
    return [1 if p == 1 and q == 1 else 0 for p, q in zip(xa, xb, strict=True)]


def combination_test(db: Optional[Session], a: str, b: str, bars: Sequence[dict[str, Any]], asset_class: str, symbol: str) -> dict[str, Any]:
    for sid in (a, b):
        if sid not in LIBRARY or not LIBRARY[sid].executable:
            return {"verdict": "NOT_TESTABLE", "reasons": [f"{sid} is not an executable module"]}
    cid = f"combo:{a}+{b}"
    synth = Strategy(id=cid, name=f"{LIBRARY[a].name} AND {LIBRARY[b].name}", inspired_by=LIBRARY[a].inspired_by + LIBRARY[b].inspired_by,
                     family="combination", source_basis="AND-combination of two independently specified modules",
                     asset_classes=tuple(set(LIBRARY[a].asset_classes) & set(LIBRARY[b].asset_classes)),
                     min_bars=max(LIBRARY[a].min_bars, LIBRARY[b].min_bars), signal=lambda bb, p: combine_signals(a, b, bb))
    if asset_class not in synth.asset_classes:
        return {"verdict": "NOT_COMPATIBLE", "reasons": [f"no shared support for {asset_class}"]}
    if len(bars) < 310:
        return {"verdict": "INSUFFICIENT_DATA", "reasons": [f"{len(bars)} bars; need 310"]}
    wf = walk_forward(synth, bars, asset_class)
    prom = evaluate_promotion(wf, n_tested=10)  # combinations carry a stricter multiple-testing haircut
    out = {**wf, **prom, "strategy_id": cid, "symbol": symbol, "asset_class": asset_class}
    if db is not None:
        db.add(AlphaStrategyRun(strategy_id=cid, asset_class=asset_class, symbol=symbol, timeframe="1d", bars=len(bars),
                                in_sample=wf["in_sample"], out_of_sample=wf["out_of_sample"], folds=wf["folds"],
                                verdict=prom["verdict"], reasons=prom["reasons"]))
        db.commit()
    return out


def live_signals(bars: Sequence[dict[str, Any]], asset_class: str, timeframe: str = "1d") -> list[dict[str, Any]]:
    """Which compatible, executable modules currently hold a long position on these bars?
    Uses each module's default (first) parameter set; no fitting on the live window."""
    regime = detect_regime(bars)
    out = []
    for sid, s in LIBRARY.items():
        comp = compatibility(sid, asset_class, timeframe, regime)
        row = {"strategy_id": sid, "name": s.name, "inspired_by": s.inspired_by, "compatible": comp["compatible"], "notes": comp["reasons"]}
        if comp["compatible"] and len(bars) >= s.min_bars:
            pos = s.signal(bars, s.param_grid[0])
            row["long"] = bool(pos and pos[-1] == 1)
        else:
            row["long"] = None
        out.append(row)
    return out

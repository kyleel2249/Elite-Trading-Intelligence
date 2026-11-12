"""Out-of-sample, walk-forward, regime and significance validation.

The library never states that a strategy "works". It assigns an *evidence grade* from explicit, published
criteria and always attaches the reasons. A good grade means "worth a forward/paper test", nothing more.
"""
from __future__ import annotations

import math
import random
from dataclasses import asdict
from typing import Any, Optional

from app.strategies import engine, indicators as ind
from app.strategies.base import Strategy, param_combos
from app.strategies.registry import get_strategy
from app.strategies.types import Bars, CostModel, MissingData, Plan, RiskModel

NaN = float("nan")

CRITERIA = {
    "min_oos_trades": 30, "min_profit_factor": 1.2, "max_drawdown_pct": 35.0, "min_positive_fold_fraction": 0.6,
    "min_wf_folds": 3, "min_oos_to_is_sharpe": 0.5, "max_bootstrap_p": 0.10, "min_deflated_sharpe": 0.90,
    "cost_stress_multiple": 2.0, "min_bars": 300, "min_is_trades": 10,
}
STATEMENT = ("An evidence grade is NOT a claim that the strategy works or will be profitable. Historical results, including out-of-sample "
             "and walk-forward results, are estimates with sampling error and selection bias. Any strategy must still pass paper/forward "
             "testing and ETI's in-process risk engine before capital is committed.")


# ------------------------------------------------------------------ statistics
def _phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _phi_inv(p: float) -> float:
    """Acklam's rational approximation of the standard-normal quantile."""
    if p <= 0 or p >= 1: return -math.inf if p <= 0 else math.inf
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > 1 - pl:
        q = math.sqrt(-2 * math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5; r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def _sr(r: list[float]) -> float:
    if len(r) < 2: return 0.0
    m = sum(r) / len(r); sd = math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1))
    return m / sd if sd > 0 else 0.0


def deflated_sharpe(returns: list[float], trial_srs: list[float]) -> Optional[float]:
    """Bailey & Lopez de Prado (2014) deflated Sharpe ratio: probability the true Sharpe exceeds the best Sharpe
    expected from `len(trial_srs)` unskilled trials. Per-bar (non-annualised) units."""
    T = len(returns)
    if T < 30: return None
    sr = _sr(returns); m = sum(returns) / T
    m2 = sum((x - m) ** 2 for x in returns) / T
    if m2 <= 0: return None
    skew = sum((x - m) ** 3 for x in returns) / T / m2 ** 1.5; kurt = sum((x - m) ** 4 for x in returns) / T / m2 ** 2
    N = max(len(trial_srs), 1)
    if N > 1:
        mu = sum(trial_srs) / N; var = sum((s - mu) ** 2 for s in trial_srs) / (N - 1)
        g = 0.5772156649
        sr0 = math.sqrt(var) * ((1 - g) * _phi_inv(1 - 1 / N) + g * _phi_inv(1 - 1 / (N * math.e)))
    else:
        sr0 = 0.0
    den = 1 - skew * sr + (kurt - 1) / 4 * sr * sr
    if den <= 0: return None
    return round(_phi((sr - sr0) * math.sqrt(T - 1) / math.sqrt(den)), 4)


def block_bootstrap(returns: list[float], n_boot: int = 500, seed: int = 1234) -> dict[str, Any]:
    T = len(returns)
    if T < 30: return {"available": False, "reason": "fewer than 30 bars"}
    rng = random.Random(seed); bl = max(2, int(math.sqrt(T))); means = []
    for _ in range(n_boot):
        s = 0.0; cnt = 0
        while cnt < T:
            st = rng.randrange(T)
            for k in range(bl):
                if cnt >= T: break
                s += returns[(st + k) % T]; cnt += 1
        means.append(s / T)
    means.sort()
    return {"available": True, "n_boot": n_boot, "block_len": bl, "mean_bar_return_bps": round(sum(returns) / T * 1e4, 4),
            "ci95_bps": [round(means[int(0.025 * n_boot)] * 1e4, 4), round(means[int(0.975 * n_boot) - 1] * 1e4, 4)],
            "p_mean_le_zero": round(sum(1 for m in means if m <= 0) / n_boot, 4)}


# ------------------------------------------------------------------ regimes
def classify_regimes(bars: Bars) -> list[str]:
    n = len(bars); sma = ind.sma(bars.c, 100); adx = ind.adx(bars.h, bars.l, bars.c, 14); rv = ind.realized_vol(bars.c, 20)
    pr = ind.percent_rank(rv, max(60, min(250, n // 3)))
    out = []
    for i in range(n):
        if not all(not ind.isnan(x) for x in (sma[i], adx[i], pr[i])): out.append("unclassified"); continue
        tr = "uptrend" if (bars.c[i] > sma[i] and adx[i] >= 20) else ("downtrend" if (bars.c[i] < sma[i] and adx[i] >= 20) else "range")
        out.append(f"{tr}|{'high_vol' if pr[i] >= 0.5 else 'low_vol'}")
    return out


def regime_table(labels: list[str], idx_returns: list[tuple[int, float]], bpy: float) -> dict[str, Any]:
    groups: dict[str, list[float]] = {}
    for i, r in idx_returns: groups.setdefault(labels[i], []).append(r)
    total = max(len(idx_returns), 1); table = {}
    for k, rs in sorted(groups.items()):
        g = 1.0
        for r in rs: g *= 1 + r
        sd = math.sqrt(sum((x - sum(rs)/len(rs)) ** 2 for x in rs) / (len(rs) - 1)) if len(rs) > 1 else 0.0
        nz = [r for r in rs if r != 0]
        table[k] = {"bars": len(rs), "share_pct": round(len(rs) / total * 100, 2), "compound_return_pct": round((g - 1) * 100, 4),
                    "mean_bar_return_bps": round(sum(rs) / len(rs) * 1e4, 4),
                    "sharpe": round(sum(rs) / len(rs) / sd * math.sqrt(bpy), 3) if sd > 0 and len(rs) >= 50 else None,
                    "hit_rate_active_bars": round(sum(1 for r in nz if r > 0) / len(nz), 4) if nz else None,
                    "sufficient_sample": len(rs) >= 50}
    return table


# ------------------------------------------------------------------ runners
class _Evaluator:
    """Caches one Plan per parameter set (plans are causal over the whole series) and runs windows of it."""

    def __init__(self, strategy_id: str, bars: Bars, aux, cost: CostModel, risk: RiskModel, bpy: float):
        self.sid, self.bars, self.aux, self.cost, self.risk, self.bpy = strategy_id, bars, aux, cost, risk, bpy
        self._plans: dict[tuple, Plan] = {}

    def plan(self, params: dict[str, Any]) -> Plan:
        key = tuple(sorted((k, repr(v)) for k, v in params.items()))
        if key not in self._plans:
            self._plans[key] = get_strategy(self.sid, **params).plan(self.bars, self.aux)
        return self._plans[key]

    def run(self, params, start, end, cost: Optional[CostModel] = None):
        return engine.run(self.bars, self.plan(params), cost or self.cost, self.risk, start, end)

    def metrics(self, res) -> dict[str, Any]:
        return engine.metrics(res.bar_returns, res.trades, self.bpy, res.exposure_bars, res.costs_paid, self.risk.initial_equity)


def _score(m: dict[str, Any], mode: str) -> float:
    need = CRITERIA["min_is_trades"]
    if (m["trades"] < need) or m["sharpe"] is None: return -math.inf
    return m["sharpe"]


def _select(ev: _Evaluator, grid: dict, defaults: dict, start: int, end: int):
    best, best_s, srs = dict(defaults), -math.inf, []
    for combo in param_combos(grid):
        params = {**defaults, **combo}
        res = ev.run(params, start, end); m = ev.metrics(res); s = _score(m, "")
        if res.bar_returns: srs.append(_sr(res.bar_returns))
        if s > best_s: best, best_s = params, s
    return best, (best_s if best_s > -math.inf else None), srs


def _downsample(xs: list[float], k: int = 200) -> list[float]:
    step = max(1, len(xs) // k)
    return [round(x, 2) for x in xs[::step]]


def run_backtest(strategy_id: str, bars: Bars, aux: Optional[dict] = None, params: Optional[dict] = None, cost: Optional[CostModel] = None,
                 risk: Optional[RiskModel] = None, bpy: float = 8760.0) -> dict[str, Any]:
    """Single full-sample run with fixed (default or caller-supplied) parameters. This is IN-SAMPLE by construction."""
    strat = get_strategy(strategy_id, **(params or {}))
    cost = cost or strat.default_costs(); risk = risk or RiskModel()
    plan = strat.plan(bars, aux)
    res = engine.run(bars, plan, cost, risk)
    m = engine.metrics(res.bar_returns, res.trades, bpy, res.exposure_bars, res.costs_paid, risk.initial_equity)
    return {"strategy_id": strategy_id, "params": strat.params, "sample": "in_sample_full_series", "metrics": m,
            "costs": asdict(cost), "risk": asdict(risk), "notes": plan.notes,
            "trades_tail": [{k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in t.items()} for t in res.trades[-25:]],
            "equity_curve": _downsample(res.equity), "warning": "In-sample result on the full series: not evidence of an edge. Use /validate."}


def validate(strategy_id: str, bars: Bars, aux: Optional[dict] = None, *, params: Optional[dict] = None, cost: Optional[CostModel] = None,
             risk: Optional[RiskModel] = None, bpy: float = 8760.0, train_frac: float = 0.7, wf_train: Optional[int] = None,
             wf_test: Optional[int] = None, n_boot: int = 500) -> dict[str, Any]:
    strat0 = get_strategy(strategy_id, **(params or {})); spec = strat0.spec
    cost = cost or strat0.default_costs(); risk = risk or RiskModel(); n = len(bars)
    report: dict[str, Any] = {
        "strategy_id": strategy_id, "name": spec.name, "fidelity": spec.fidelity, "fidelity_note": spec.fidelity_note,
        "statement": STATEMENT, "criteria": CRITERIA,
        "data": {"bars": n, "symbol": bars.symbol, "interval": bars.interval, "first_ts": bars.window_ts()[0], "last_ts": bars.window_ts()[1],
                 "ohlc_complete": bars.ohlc_complete, "has_volume": bars.v is not None, "aux_keys": sorted((aux or {}).keys())},
        "assumptions": {"costs": asdict(cost), "risk": asdict(risk), "bars_per_year": bpy,
                        "fills": "signal on close of bar i, fill at open of bar i+1; stops intrabar (stop wins ties); gaps fill at the worse open"},
        "execution_eligible": False,
        "promotion_note": "The strategy library emits research signals only. Order placement stays behind ETI's in-process risk engine and promotion authority.",
    }
    try:
        ev = _Evaluator(strategy_id, bars, aux, cost, risk, bpy)
        ev.plan(strat0.params)  # surfaces MissingData before any metric is produced
    except MissingData as e:
        report.update(status="blocked_missing_data", verdict={"grade": "blocked_missing_data", "reasons": [str(e)], "failed": [], "passed": []})
        return report
    if n < CRITERIA["min_bars"]:
        report.update(status="insufficient_history", verdict={"grade": "insufficient_sample", "failed": ["min_bars"], "passed": [],
                      "reasons": [f"{n} bars < {CRITERIA['min_bars']} required for a train/test split and walk-forward"]})
        report["backtest"] = {"params": strat0.params, "sample": "in_sample_full_series", "metrics": ev.metrics(ev.run(strat0.params, 0, n))}
        return report

    defaults = {**spec.params_default, **(params or {})}; grid = {k: v for k, v in spec.param_grid.items() if not (params and k in params)}
    n_combos = len(param_combos(grid))
    # 1) full-sample default-parameter backtest (in-sample, no optimisation)
    full = ev.run(defaults, 0, n)
    report["backtest"] = {"params": defaults, "sample": "in_sample_full_series", "metrics": ev.metrics(full),
                          "note": "Fixed parameters, whole series. Descriptive only."}
    # 2) train/test with parameter selection on train only
    split = int(n * train_frac)
    sel, sel_score, trial_srs = _select(ev, grid, defaults, 0, split)
    is_res, oos_res = ev.run(sel, 0, split), ev.run(sel, split, n)
    is_m, oos_m = ev.metrics(is_res), ev.metrics(oos_res)
    report["train_test"] = {"split_index": split, "selection_objective": "in-sample Sharpe, min trades", "selected_params": sel,
                            "selection_found_valid_candidate": sel_score is not None, "grid_size": n_combos,
                            "in_sample": is_m, "out_of_sample": oos_m}
    # 3) rolling walk-forward
    wtr = wf_train or int(n * 0.4); wte = wf_test or max(30, int(n * 0.15))
    folds, stitched, idx_ret, wf_trades = [], [], [], []
    s = 0
    while s + wtr + wte <= n:
        tr_end, te_end = s + wtr, s + wtr + wte
        p_sel, _sc, _ = _select(ev, grid, defaults, s, tr_end)
        r = ev.run(p_sel, tr_end, te_end); m = ev.metrics(r)
        folds.append({"train": [s, tr_end], "test": [tr_end, te_end], "params": p_sel, "oos_return_pct": m["total_return_pct"],
                      "oos_trades": m["trades"], "oos_max_drawdown_pct": m["max_drawdown_pct"], "oos_sharpe": m["sharpe"]})
        stitched += r.bar_returns; idx_ret += list(zip(range(tr_end, te_end), r.bar_returns)); wf_trades += r.trades
        s += wte
    wf_m = engine.metrics(stitched, wf_trades, bpy, 0, 0.0, risk.initial_equity) if stitched else None
    pos_frac = (sum(1 for f in folds if f["oos_return_pct"] > 0) / len(folds)) if folds else None
    modal = None
    if folds:
        from collections import Counter
        cnt = Counter(repr(sorted(f["params"].items())) for f in folds); modal = cnt.most_common(1)[0][1] / len(folds)
    report["walk_forward"] = {"train_bars": wtr, "test_bars": wte, "n_folds": len(folds), "folds": folds, "stitched_oos": wf_m,
                              "positive_fold_fraction": None if pos_frac is None else round(pos_frac, 4),
                              "parameter_stability": None if modal is None else round(modal, 4),
                              "worst_fold_drawdown_pct": max((f["oos_max_drawdown_pct"] for f in folds), default=None)}
    # primary out-of-sample evidence: walk-forward when available, else the single hold-out
    use_wf = len(folds) >= CRITERIA["min_wf_folds"] and wf_m is not None
    prim_m, prim_ret = (wf_m, stitched) if use_wf else (oos_m, oos_res.bar_returns)
    prim_idx = idx_ret if use_wf else list(zip(range(split, n), oos_res.bar_returns))
    report["max_drawdown"] = {"backtest_in_sample_pct": report["backtest"]["metrics"]["max_drawdown_pct"], "hold_out_oos_pct": oos_m["max_drawdown_pct"],
                              "walk_forward_stitched_pct": None if wf_m is None else wf_m["max_drawdown_pct"],
                              "worst_walk_forward_fold_pct": report["walk_forward"]["worst_fold_drawdown_pct"],
                              "note": "Maximum historical drawdown over the tested window only; the future maximum is not bounded by it."}
    report["regimes"] = {"basis": "walk_forward_oos" if use_wf else "hold_out_oos", "definition": "trend: close vs SMA100 with ADX>=20; volatility: percent-rank of 20-bar realised vol >= 0.5 (all causal)",
                         "table": regime_table(classify_regimes(bars), prim_idx, bpy)}
    # 4) cost stress on the hold-out
    stress = {}
    for k in (1.0, CRITERIA["cost_stress_multiple"], 3.0):
        rr = ev.run(sel, split, n, cost.scaled(k)); mm = ev.metrics(rr)
        stress[f"{k:g}x"] = {"total_return_pct": mm["total_return_pct"], "sharpe": mm["sharpe"], "profit_factor": mm["profit_factor"]}
    report["cost_sensitivity"] = {"basis": "hold_out_oos_selected_params", **stress}
    # 5) significance
    boot = block_bootstrap(prim_ret, n_boot)
    dsr = deflated_sharpe(prim_ret, trial_srs)
    report["significance"] = {"basis": report["regimes"]["basis"], "bootstrap": boot, "deflated_sharpe_probability": dsr, "n_trials_in_selection": max(n_combos, 1),
                              "note": "Deflated Sharpe accounts for the number of parameter sets tried; it cannot account for strategies/markets you tried elsewhere."}
    # 6) verdict
    sr_is, sr_oos = is_m["sharpe"], oos_m["sharpe"]
    checks = {
        "oos_sample_adequate": prim_m["trades"] >= CRITERIA["min_oos_trades"],
        "oos_net_return_positive": prim_m["total_return_pct"] > 0,
        "oos_profit_factor_ok": (prim_m["profit_factor"] or 0) >= CRITERIA["min_profit_factor"],
        "oos_drawdown_within_limit": prim_m["max_drawdown_pct"] <= CRITERIA["max_drawdown_pct"],
        "walk_forward_consistent": bool(use_wf and pos_frac is not None and pos_frac >= CRITERIA["min_positive_fold_fraction"]),
        "no_severe_is_to_oos_degradation": (sr_oos is not None and sr_oos > 0) if not sr_is or sr_is <= 0 else (sr_oos is not None and sr_oos >= CRITERIA["min_oos_to_is_sharpe"] * sr_is),
        "bootstrap_significant": bool(boot.get("available") and boot["p_mean_le_zero"] <= CRITERIA["max_bootstrap_p"]),
        "deflated_sharpe_ok": dsr is not None and dsr >= CRITERIA["min_deflated_sharpe"],
        "robust_to_2x_costs": (stress[f"{CRITERIA['cost_stress_multiple']:g}x"]["total_return_pct"] or 0) > 0,
    }
    passed = [k for k, v in checks.items() if v]; failed = [k for k, v in checks.items() if not v]
    if not checks["oos_sample_adequate"]: grade = "insufficient_sample"
    elif not checks["oos_net_return_positive"] or (prim_m["profit_factor"] or 0) < 1.0: grade = "no_evidence_of_edge"
    elif not failed: grade = "candidate_requires_forward_test"
    else: grade = "weak_evidence"
    reasons = [f"failed: {k}" for k in failed]
    if spec.fidelity != "full": reasons.append(f"implementation fidelity is '{spec.fidelity}': {spec.fidelity_note}")
    report.update(status="validated_run", verdict={"grade": grade, "passed": passed, "failed": failed, "reasons": reasons, "primary_oos_basis": report["regimes"]["basis"]})
    report["limitations"] = list(spec.known_weaknesses)
    return report


def latest_signal(strategy_id: str, bars: Bars, aux: Optional[dict] = None, params: Optional[dict] = None) -> dict[str, Any]:
    """Research state of the strategy at the last COMPLETED bar. Not an order and not aware of any open position."""
    strat = get_strategy(strategy_id, **(params or {})); plan = strat.plan(bars, aux); i = len(bars) - 1
    base = {"strategy_id": strategy_id, "as_of_index": i, "as_of_ts": bars.t[i] if bars.t else None, "last_close": bars.c[i], "notes": plan.notes}
    if plan.mode == "exposure":
        e = plan.exposure[i]
        return {**base, "mode": "exposure", "target_exposure": None if (e is None or ind.isnan(e)) else round(e, 4),
                "state": "long" if e > 0 else ("short" if e < 0 else "flat")}
    sd = plan.stop_dist[i]
    state = "enter_long" if plan.signal[i] == 1 else ("enter_short" if plan.signal[i] == -1 else "no_entry")
    return {**base, "mode": "trade", "state": state, "exit_condition_active": bool(plan.exit_signal[i]),
            "initial_stop_distance": None if ind.isnan(sd) else round(sd, 8), "take_profit_r": plan.take_profit_r}

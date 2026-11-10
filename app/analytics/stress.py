"""Portfolio stress testing and scenario analysis. Shocks are hypothetical, never claims of history."""
from __future__ import annotations

from typing import Any, Sequence

HYPOTHETICAL_SCENARIOS: dict[str, dict[str, float]] = {
    "equity_selloff_20": {"stock": -0.20, "index": -0.20, "crypto": -0.30, "commodity": -0.05, "forex": 0.0, "metal": 0.05, "cash": 0.0},
    "crypto_crash_50": {"crypto": -0.50, "stock": -0.05, "index": -0.05},
    "rates_shock": {"stock": -0.10, "index": -0.10, "crypto": -0.15, "metal": -0.05},
    "commodity_spike": {"commodity": 0.25, "stock": -0.05, "index": -0.05},
    "broad_risk_on": {"stock": 0.10, "index": 0.10, "crypto": 0.20},
}


def _validate(positions: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for p in positions:
        if not p.get("symbol"):
            raise ValueError("every position needs a symbol")
        mv = float(p.get("market_value"))
        out.append({"symbol": str(p["symbol"]).upper(), "market_value": mv,
                    "asset_class": str(p.get("asset_class", "stock")).lower()})
    return out


def stress_test(positions: Sequence[dict[str, Any]], scenarios: dict[str, dict[str, float]] | None = None,
                symbol_shocks: dict[str, dict[str, float]] | None = None) -> dict[str, Any]:
    """Apply per-asset-class shocks (optionally overridden per symbol). Short positions use negative market value."""
    pos = _validate(positions)
    if not pos:
        return {"status": "insufficient_data", "detail": "no positions"}
    scen = scenarios if scenarios is not None else HYPOTHETICAL_SCENARIOS
    gross = sum(abs(p["market_value"]) for p in pos)
    net = sum(p["market_value"] for p in pos)
    results = []
    for name, shocks in scen.items():
        pnl = 0.0
        rows = []
        for p in pos:
            shock = (symbol_shocks or {}).get(name, {}).get(p["symbol"], shocks.get(p["asset_class"], 0.0))
            delta = p["market_value"] * shock
            pnl += delta
            rows.append({"symbol": p["symbol"], "shock_pct": round(shock * 100, 3), "pnl": round(delta, 2)})
        results.append({
            "scenario": name, "pnl": round(pnl, 2), "pnl_pct_of_gross": round(pnl / gross * 100, 3) if gross else 0.0,
            "worst_positions": sorted(rows, key=lambda r: r["pnl"])[:3],
        })
    results.sort(key=lambda r: r["pnl"])
    return {"status": "ok", "gross_exposure": round(gross, 2), "net_exposure": round(net, 2), "scenarios": results,
            "notes": ["Scenarios are hypothetical shocks, not historical replays.",
                      "Linear shocks ignore convexity, margin calls, gaps and liquidity."]}


def scenario_analysis(positions: Sequence[dict[str, Any]], scenarios: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Probability-weighted outcomes. Each scenario: {name, probability, shocks:{asset_class: pct}}. Probabilities must sum to 1 (+-0.01)."""
    pos = _validate(positions)
    if not pos or not scenarios:
        return {"status": "insufficient_data"}
    total_p = sum(float(s["probability"]) for s in scenarios)
    if abs(total_p - 1.0) > 0.01:
        raise ValueError(f"scenario probabilities must sum to 1.0 (got {total_p:.3f})")
    outs = []
    for s in scenarios:
        pnl = sum(p["market_value"] * float(s["shocks"].get(p["asset_class"], 0.0)) for p in pos)
        outs.append({"name": s["name"], "probability": float(s["probability"]), "pnl": round(pnl, 2)})
    return {"status": "ok", "expected_pnl": round(sum(o["probability"] * o["pnl"] for o in outs), 2),
            "best_case": max(outs, key=lambda o: o["pnl"]), "worst_case": min(outs, key=lambda o: o["pnl"]),
            "scenarios": outs, "notes": ["Probabilities are user-supplied assumptions, not forecasts."]}

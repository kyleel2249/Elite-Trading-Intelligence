# ETI Advanced Intelligence Expansion — Implementation Register

This register tracks the staged implementation of the GOD-MODE specification. Existing capabilities are reused rather than duplicated.

## Repository audit (2026-11-18)

The Cloudflare Worker already includes:
- Smart Money Concepts: displacement, FVG, order blocks, liquidity pools/sweeps, confirmed market structure and volume profile.
- SMC and FVG chart overlays in the main dashboard.
- Multi-timeframe analysis across yearly through 1-minute frames, with closed-candle handling.
- ETIAlgo V3 Alpha, signal ledger, backtesting, expectancy, calibration, replay primitives and regime classification.
- A 12-agent research system with structured reports, orchestration, decision controls and an execution route guarded by existing risk checks.
- Portfolio and exchange reconciliation modules, Bybit/Bitget adapters, paper execution, journal and Cloudflare D1/KV infrastructure.

## Gaps confirmed during audit

- No dedicated exchange-trade footprint endpoint that exposes price-level bid/ask aggression and CVD in a reusable schema.
- No timestamped historical order-book depth persistence and liquidity persistence summary in the analysis API.
- Existing order-book snapshots are current-state measurements; they must not be represented as historical liquidity.
- Some features in the master specification already exist in separate modules and need integration/coverage rather than replacement.

## Phase 1 — Order-flow and depth-history foundation

Implemented in this checkpoint:
- Validated public trade-tape normalization.
- Aggressor-side footprint aggregation by price bucket.
- Buy/sell volume, delta, delta percentage and CVD.
- Top-of-book spread, depth notional imbalance and microprice.
- Conservative absorption candidates only when tape pressure and candle-body evidence coexist; the output is explicitly low-confidence.
- KV-backed, bounded 72-snapshot depth history with seven-day expiry, using a dedicated key prefix inside the existing ETI_EXECUTION_LOG namespace (no new binding required).
- Persistent bid/ask liquidity summaries with observation counts and persistence percentages.
- Read-only POST support for browser-fetched Bybit/Bitget data; Bitget is not routed through blocked Worker egress.
- Bybit server-side GET support.
- Explicit data-quality notes and no order-submission capability.

## Phase 2 — Signal quality and lifecycle\n\nImplemented in this checkpoint:\n- Closed-candle, confirmed-pivot regular and hidden bullish/bearish price-RSI divergence.\n- Divergence evidence contributes to ETIAlgo V3 Alpha scoring and warns when it opposes the candidate direction.\n- Persistent signal lifecycle states: confirmed, entry reached, TP1/TP2/TP3 reached, invalidated and expired.\n- Conservative stop-first handling when one candle touches both a stop and target.\n- Existing TP1-based historical outcome accounting remains comparable.\n\n## Planned phases

1. Visual Market Intelligence: integrate footprint, CVD and historical liquidity into the chart and Pro Terminal; complete MTF confluence presentation.
2. ETIAlgo intelligence: regime-aware adaptive scoring, divergence and lifecycle persistence.
3. Agent network: specialist report evidence, consensus/dissent, conflict resolution and audit persistence.
4. Portfolio risk: consolidated exposure, correlation, stress tests and protective controls.
5. Strategy research: realistic backtesting, walk-forward validation and attribution.
6. Market-wide intelligence: Bybit/Bitget comparison, large-trade alerts, event risk and anomalies.
7. Execution intelligence: paper/shadow execution, reconciliation and controlled order management.
8. Workspaces: replay, setup scanner, opportunity radar, strategy conflicts, journal and command centre.
9. Final release: complete regression, security and deployment verification.

## Safety invariants

All analysis routes are read-only. A single depth snapshot cannot prove spoofing or institutional intent. Historical persistence is only reported when timestamped KV samples exist. All live orders remain subject to the existing central execution gateway, operator permissions, exchange validation, risk limits and kill switch.

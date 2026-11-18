# ETI Advanced Intelligence Expansion — Implementation Register

## Verified baseline
Main branch includes the SMC/FVG and institutional analysis engines, ETIAlgo V3 Alpha, multi-timeframe views, twelve-agent orchestration, risk and execution controls, Bybit/Bitget market adapters, sports paper intelligence, Global Alpha, GainzAlgo V2/V2 Alpha, Pro Terminal, trade journal, D1 and KV persistence.

## Phase 1 — Order-flow foundation
- Validated public trade-tape normalization and aggressor-side price-level footprint.
- Buy/sell volume, delta, delta percentage and sample CVD.
- Spread, top-ten depth notional imbalance and microprice.
- Conservative low-confidence absorption candidates with explicit evidence limitations.
- Optional KV-backed historical depth sampling (72 samples, seven-day expiry) using the existing ETI_EXECUTION_LOG namespace.
- Persistent bid/ask liquidity summaries; unavailable states when history is not stored.
- Read-only `/api/analysis/orderflow` endpoint; Bybit server-side and Bitget browser-fed.
- Pro Terminal footprint, CVD and historical liquidity panels.

## Phase 2 — Dedicated AI Agents workspace and consistent page dimensions
- Dedicated `/agents` workspace with navigation to core ETI tools.
- Shared 1920px maximum page shell and 24px desktop content gutters, matching the main dashboard.
- GainzAlgo Intelligence, Global Alpha Center, Trade Journal, Sports Betting Intelligence and ETI Pro/Pro Terminal use the same outer workspace sizing standard.
- Sidebar layouts retain navigation width; usable main content width is calculated within the 1920px shell.
- Responsive mobile gutters and single-column breakpoints remain active.
- Added route-level layout regression coverage for `/agents`, `/gainz`, `/alpha`, `/journal`, `/sports`, `/pro` and `/terminal`.

## Remaining roadmap
1. Multi-timeframe confluence visualizer with timeframe coverage, conflict and freshness indicators.
2. Regime-aware ETIAlgo scoring, divergence and signal lifecycle analytics.
3. Agent collaboration evidence, dissent, strategy conflict resolution and persistent decision audit.
4. Portfolio exposure, correlation, stress tests, risk-of-ruin and protective controls.
5. Fee/funding/slippage-aware backtesting, walk-forward validation and attribution.
6. Bybit/Bitget market comparison, large-trade monitoring, event risk and anomaly detection.
7. Paper/shadow execution quality, reconciliation and controlled order management.
8. Market Replay, Setup Scanner, Opportunity Radar, strategy health and unified Command Centre.

## Safety invariants
All new analytical routes are read-only. A single order-book snapshot cannot prove spoofing, absorption or institutional intent. Historical liquidity is shown only when timestamped samples exist. Agent proposals and strategies cannot bypass the central execution gateway, risk manager, exchange validation, operator permissions or kill switch. Paper execution is labelled separately from exchange live trading.

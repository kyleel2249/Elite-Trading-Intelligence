# ETI Global Alpha Intelligence — Python/FastAPI backend

> **Read first.** `main` already contains a separate Global Alpha implementation in the Cloudflare Worker (`worker/alpha/*`,
> documented in [GLOBAL_ALPHA.md](GLOBAL_ALPHA.md)). This document describes a second implementation in the FastAPI
> app (`app/alpha/*`, routes under `/api/alpha/*` on the Python service, page at the Python service's `/alpha`).
> The two are different deployables and do not share code or storage. Choose one as the system of record, or run
> this one as the persistent server-side research backend. Overlap and differences:
>
> | Area | Worker (`worker/alpha`) | Python (`app/alpha`) |
> |---|---|---|
> | Early-alpha score, 8 stages, coverage-aware scoring | yes | yes |
> | Strategy lab, walk-forward, costs, multiple-testing correction | yes (18 strategies) | yes (12 executable + 5 live evaluators) |
> | Fusion + independent validation, hard veto | yes | yes (+ plug-in engines incl. the Worker's OMNISIGNAL X via HTTP) |
> | Ledger | worker ledger (KV) | writes to the existing immutable SQL prediction ledger |
> | SEC 13F / Form 4 | yes (13D/G too) | 13F / Form 4 parsers (no 13D/G) |
> | **SEC XBRL fundamentals (quality, PEG) and FRED macro regime evaluators** | no | **yes (unique)** |
> | Investor qualification criteria, versioned profile updates, cited research overlay | profile audit only | yes |
> | Storage / runtime | KV, cron, Workers Paid for CPU | SQL database, async job, FastAPI |
> | Copy-trade 12-step evaluation | yes | yes |
> | Wallet/DEX safety | order-flow, GoPlus | heuristic DEX screen, operator-supplied wallet labels |


Dashboard: `/alpha` · API: `/api/alpha/*` (OpenAPI at `/docs`) · Code: `app/alpha/`

## How it fits ETI (no duplicated subsystems)
| Concern | Owner | Global Alpha's role |
|---|---|---|
| Predictions, immutability, outcomes, calibration, monthly reports | `app/prediction_ledger` (DB triggers + resolver job) | writes decision-time predictions through `app/alpha/predictions.py`; keeps no ledger of its own |
| Swift / GainzAlgo / OMNISIGNAL X engines | `worker/algo/*` (Worker, `GET /api/omnisignal`) | consumed read-only via `omnisignal_bridge.py` when `OMNISIGNAL_BASE_URL` is set |
| Order risk limits, kill switch, 6% notional cap, live gates | `app/risk/engine.py` via `TradingService` | trade plans are sized to the same cap; every order goes through the RiskEngine |
| Strategy promotion to paper/live, adaptive edge | `app/adaptive_edge` (human-approved, cannot authorize live) | the lab's CHAMPION is a lab status only; it never deploys anything |
| Knowledge profiles | `app/knowledge` | audit, qualification, versioned updates, dated research overlay (`research_alpha.py`) |

## Three layers that cannot approve themselves
| Layer | Modules | May | May not |
|---|---|---|---|
| Discovery AI | `discovery`, `scoring`, `features`, `token_safety` | scan, score, stage, persist (incl. rejected) | assign CONFIRMED/HIGH_CONVICTION; send orders |
| Research AI | `investor_intel`, `strategy_lab`, `fundamentals`, `macro`, `whales`, `sec_sync` | qualify, test, screen, label | authorize orders |
| Decision AI | `fusion`, `execution`, `context` | re-validate from raw bars, approve/reject, plan, paper/testnet execution | trust Discovery's numbers; outvote a hard veto |

Evidence engines (each publishes `EngineEvidence`): technical, strategy_lab, investor_intel, onchain, trading_council, **omnisignal_x**, macro_regime (context only, never counts as agreement, never vetoes), fundamentals, risk (hard veto). An opposing validated OMNISIGNAL `SELL` or a `REJECTED` with hard failures is a veto. `register_engine` attaches more.

## Scores
Early Alpha (0-100) is asset-class weighted; unmeasured components are excluded, thin evidence is shrunk toward 50, and coverage/uncertainty are reported. It is a research priority, never a BUY. Validation score = share of ten Decision checks passed; any hard failure blocks approval; a failed re-validation downgrades a prior approval, and approvals expire after `ALPHA_VALIDATION_MAX_AGE_HOURS`.

## Strategy lab
Executable (price/volume): Donchian/Turtle-style, EMA trend, Minervini trend template + VCP, Darvas, Wyckoff spring, Livermore pivot, O'Neil breakout (technical leg), Williams volatility expansion, Raschke ADX pullback, 200-period MA, z-score baseline. Live evaluators (not backtestable): Buffett/Munger quality and Lynch GARP from SEC XBRL; Druckenmiller liquidity regime, Dalio growth x inflation proxy and a credit-cycle leg from FRED. Soros, Kovner, Lien, Templeton, Burry and activist styles remain unimplemented. Modules are inspired by public principles, not private systems.

Protocol: next-bar-open fills, costs, walk-forward selection on in-sample only, OOS-only scoring, gates (>=3 folds, >=30 OOS trades, positive net expectancy, t-stat >= 2 + 0.25 ln(n tested), PF >= 1.2, >=50% profitable folds, drawdown <= 35%, OOS >= 40% of IS). Pooled trades are treated as independent, which overstates significance for correlated symbols.

## Execution and live trading
Paper/testnet by default. Live additionally needs `LIVE_TRADING_ENABLED`, `ALPHA_LIVE_EXECUTION_AUTHORIZED`, `API_KEY`, `LIVE_ACCOUNT_EQUITY`, and `confirm_live="I AUTHORIZE LIVE ORDER"`; it submits limit orders only. On current main the RiskEngine also demands `live_confirmed` in order metadata, which no route sets yet, so live orders remain blocked end to end. Plans are capped at `MAX_POSITION_NOTIONAL_PCT`. Stops/targets are ETI-managed by the monitor (no resting broker orders). Exits are reduce-only. DEX tokens have no execution venue. No withdrawal/transfer capability exists.

## Operating notes
* `alembic upgrade head` (migration `0006_global_alpha` follows `0004_prediction_ledger`). Main's migration 0004_prediction_ledger uses ALTER constraint operations that SQLite cannot run; use PostgreSQL for migrations, or `init_db` for SQLite dev.
* Providers were tested with mock transports only; coverage shows `UNVERIFIED` until a first real success.
* **Two separate RBAC systems exist and do not share state:** the Worker's accounts/roles/MFA (`worker/identity/rbac.ts`) govern the Worker; the roles below govern only this Python service's `/api/alpha/*` routes.
* **Access roles** (`app/alpha/access.py`): `analyst` (scans, validation, research, strategy lab, labelling, qualification, macro/fundamentals, no orders) < `trader` (+ paper/testnet execution and the position monitor) < `admin` (the existing `API_KEY`; the only role allowed to attempt `environment=live`, which still needs every operator flag). Extra keys: `ALPHA_ROLE_KEYS="key:analyst,key:trader"` (keys of at least 16 characters; weak, duplicate or admin entries are dropped). Constant-time comparison, no key is ever logged, and audit entries carry a role and a short key fingerprint. Same fail-closed rule as the rest of ETI: production with no keys returns 503.

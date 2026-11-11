# Capability map: the 31 requested items vs what ETI contains

Built from a file/doc audit on 2026-11-11 (directory listings and docs: `docs/GLOBAL_ALPHA_PYTHON.md`, `READINESS.md`, `PORTFOLIO.md`,
`app/alpha/coverage.py`, `app/alpha/whales.py`). "Exists" means the module/doc exists; **none of it was run by the author**, and
the repo's own docs say its providers were exercised against mocks only. An earlier report in this change set called whale
activity, institutional holdings and multi-account "not built"; that was wrong, they exist as listed below.

Columns: **Existing** = pre-existing ETI code. **Added** = added by the `app/analytics` and `app/providers` work (unit-tested only).

| # | Capability | Existing | Added | Gap |
|---|---|---|---|---|
| 1 | Real-time multi-market scanning | `worker/alpha/scanner.ts`, `app/alpha/discovery.py` (crypto, US equities via Alpaca IEX, DEX tokens) | `GET /api/analytics/scan` | No forex, commodities, futures or non-US equities feed (`coverage.py`) |
| 2 | Automated watchlists | not reviewed (`worker/universe.test.ts` exists) | `build_watchlist` via `/scan` | Persistence of watchlists |
| 3 | Opportunity ranking | `app/alpha/scoring.py` early-alpha score | attention ranking in `/scan` | Two scorers; unify |
| 4 | Economic calendar | Worker readiness engine reads `ETI_EVENT_FEED_URL` (no vendor shipped) | FMP adapter + `GET /api/analytics/intel/calendar/feed` in that format | Needs `FMP_API_KEY`, `EVENT_FEED_TOKEN`, and the Worker variables below |
| 5 | Earnings calendar | `earnings` category in readiness (no data) | `GET /intel/calendar/earnings` (FMP) | Not exported to readiness (date only, no release time) |
| 6 | Token unlock monitoring | none found | Tokenomist adapter, `GET /intel/unlocks/{token}` | Needs `TOKENOMIST_API_KEY`; per-token only |
| 7 | Whale activity | `app/alpha/whales.py` (Etherscan-compatible explorer + operator labels), `worker/alpha/flow.ts` | none | Needs explorer config and verified labels; Whale Alert adapter optional/not built |
| 8 | Institutional holdings | `app/alpha/sec_sync.py`, `investor_intel.py` (13F, Form 4), `worker/alpha/sec.ts`, Quiver; `docs/INVESTOR_INTELLIGENCE.md` | none | 13F is delayed up to 45 days |
| 9 | Unusual volume | not found | `GET /unusual-volume` | |
| 10 | Volatility breakout alerts | not found as alerts | `GET /volatility-breakout` | Alert delivery/subscriptions |
| 11 | Market regime | readiness regime/volatility; `app/alpha/macro.py` | `GET /regime` | |
| 12 | Correlation | readiness factor 9; risk engine correlated-exposure cap | `GET /correlation` | |
| 13 | Portfolio stress testing | not found | `POST /stress` | Hypothetical shocks only |
| 14 | Monte Carlo | README mentions probabilistic tools (not reviewed) | `GET /monte-carlo` | |
| 15 | Scenario analysis | not found | `POST /scenario` | |
| 16 | Strategy optimization | `worker/optimizer`, `app/alpha/strategy_lab.py` | grid search in walk-forward | |
| 17 | Walk-forward testing | `app/alpha/strategy_lab.py` (full protocol: costs, folds, gates), `app/backtest` (shallow) | `POST /walk-forward` | Prefer the alpha lab for decisions |
| 18 | Paper trading | `app/paper`, `worker/paper*`, `docs/PAPER_TRADING.md`, `PORTFOLIO.md` | none | |
| 19 | Live vs backtest | `app/memory` learning loop (not reviewed) | `POST /live-vs-backtest` | |
| 20 | Multi-account | `app/execution` (accounts via `POST /api/execution/accounts`, encrypted vault), Worker identity/RBAC | none | Aggregated multi-account reporting not reviewed |
| 21 | Multi-currency reporting | not found | `POST /portfolio/multi-currency` | Caller supplies FX rates; no FX provider |
| 22 | Trade journal | `GET /api/paper-trading/journal` | none | |
| 23 | Tax/transaction support | CSV history in portfolio API | `POST /tax/realized-gains` | Not tax advice; no wash-sale rules |
| 24 | Automated risk alerts | Worker alerts page/tests, risk engine | `POST /risk-alerts` rule function | Scheduling and delivery |
| 25 | Voice assistant | not found | `/static/assistant.html` (Web Speech API; calls `/api/analytics/query`) | Never run in a browser |
| 26 | Natural-language queries | `worker/command` (not reviewed) | `POST /query` rule-based router | No LLM |
| 27 | Historical replay | `worker/replay.test.ts` replay lab | `Replay` class only | |
| 28 | Strategy comparison lab | `app/alpha/strategy_lab.py`, `docs/STRATEGY_LIBRARY.md` | `POST /strategy-lab/compare` | |
| 29 | Strategy marketplace + validation records | none found (immutable `app/prediction_ledger` is the natural base) | none | **Not built** |
| 30 | AI daily/weekly reports | `worker/daily/*` (daily report), ledger monthly reports | none | Weekly report and LLM narrative not found |
| 31 | Live trading | gated engine; docs say live orders stay blocked end to end (no route sets `live_confirmed`) | none, deliberately | Unchanged |
| — | AI research mode | alpha research overlay (`app/knowledge`) | `POST /research` evidence-gated dossier | No LLM-driven investigation |

## Wiring the calendar into the readiness engine
On the Python service: set `FMP_API_KEY` and `EVENT_FEED_TOKEN` (a long random string). On the Worker: set
`ETI_EVENT_FEED_URL=https://<python-origin>/api/analytics/intel/calendar/feed` and the secret `ETI_EVENT_FEED_TOKEN` to the same value.
Until verified live, the readiness engine keeps reporting the calendar as unverified.

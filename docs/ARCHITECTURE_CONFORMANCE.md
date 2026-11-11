# Technical architecture: conformance report

This states what the repository implements today against the recommended stack, what was verified, and what is not done. "Verified" means exercised by tests or a real headless-browser run in this repository. Nothing here was verified against live Cloudflare, exchange or broker accounts, which are not reachable from the build environment.

Run the new Python tests without the web stack: `python -m pytest --noconftest tests/research -q`.

## Summary
ETI runs as two cooperating parts: a **Cloudflare Worker (TypeScript)** that serves the dashboards and every authenticated, execution-related API, and a **Python/FastAPI research and execution package** (`app/`) that is deployed separately. The recommended frontend rewrite (Next.js, React, Tailwind, Framer Motion, React Three Fiber) and the Redis/Celery/PyTorch/vector-database infrastructure are **not implemented**; they cannot be built or tested without package-registry access, and claiming them would be false.

## Frontend
| Recommended | Status |
|---|---|
| Responsive JavaScript dashboards | Done and browser-verified (desktop, tablet, phone): signal engine, chart with trade layer, order execution, portfolio and open orders, daily report, command centre, agents, futures, `/account`, `/providers`. |
| Trading charting library | Done with the in-house canvas chart (candles, volume, order book, indicators, trade markers). It is not TradingView or Lightweight Charts. |
| React, Next.js, TypeScript, Tailwind, Framer Motion, Three.js / R3F | **Not done.** Pages are dependency-free server-rendered HTML with inline TypeScript-generated JS; the Worker code itself is TypeScript. Migration is a rewrite of every page, not a configuration change. |

## Backend
| Recommended | Status |
|---|---|
| Python FastAPI | Present in `app/` (providers, markets, backtest, memory, risk, jobs, streaming). Not runnable in the build sandbox (dependencies not installable), so not re-verified this session; the pre-existing pytest suite is unchanged. |
| PostgreSQL | Supported by the FastAPI package through `DATABASE_URL` (`docs/POSTGRES.md`). The Worker uses Cloudflare **D1** (SQLite) because a Worker cannot hold a Postgres connection pool; D1 is the system of record for ledger, accounts and audit. |
| Redis | **Not done.** The Worker uses KV for rate limits and caches. |
| WebSockets | Browser consumes the public Binance market stream; `app/streaming` serves WebSockets from the Python package. No authenticated WebSocket on the Worker. |
| Celery or equivalent | Equivalent in the Worker: Cron Triggers (every-minute portfolio/futures monitor, periodic research, provider probes). The Python package has `app/jobs`. No distributed task queue. |

## AI and quantitative research
| Recommended | Status |
|---|---|
| Modular LLM integration | **No LLM calls exist anywhere in the Worker.** Signals, scoring and reports are deterministic code. Because there are no LLM prompts, prompt compression, caching and token metering have nothing to act on and were not simulated. |
| Python quant engine, Pandas/NumPy/SciPy/scikit-learn | Present in `app/` (backtest, analytics, adaptive edge, alpha scoring). |
| PyTorch | **Not done**; no model here requires it. |
| Backtesting, forecasting | Backtesting in `app/backtest`. **New:** `app/research/forecast.py`, walk-forward forecasting (naive, drift, EWMA, Holt, AR) on numpy with no look-ahead, scored against naive, intervals from out-of-sample residuals, and an explicit `beats_naive` flag. Tested (7 tests, standalone). Not a deep-learning forecaster. |
| Vector memory for research and strategy notes | **New, partial:** `app/research/vector_memory.py`, exact cosine search with kind/metadata filters and atomic persistence. The built-in embedder is lexical (hashing), not semantic; plug in a real embedding model for semantic search. Suitable to ~100k entries. It is not yet wired into `app/memory` or served over the API, and it is not a vector database (pgvector, Qdrant) |

## Data integrations (`worker/providers/`)
Implemented and tested: a registry where every provider declares **exactly** which data types it serves, how (streaming, polling, delayed, on demand), what credentials it needs and what it cannot do; live probing; per-provider state (`unconfigured`, `unknown`, `ok`, `degraded`, `stale`, `down`) with last good response age, latency and error code; a coverage matrix per data type that reports `uncovered` rather than substituting another source. Unconfigured providers are never contacted. `/providers` and `/api/providers/status` display it, and the cron refreshes it.

| Data type | Adapters |
|---|---|
| Prices | Binance (streaming), Bybit, OKX, CoinGecko (delayed aggregate), Alpaca (IEX feed unless upgraded), DEX Screener |
| Historical OHLCV | Binance, Bybit, OKX (partial), CoinGecko (coarse), Alpaca |
| Order books | Binance only |
| Fundamentals | SEC EDGAR filings only (not a ratios feed) |
| Financial news / economic calendar | Operator-supplied feed (`ETI_EVENT_FEED_URL`) and FRED macro series; there is no built-in news vendor |
| On-chain | Etherscan (EVM only) |
| Broker execution | Alpaca **paper** account only |
| Exchange execution | Binance **testnet** only; no live path exists |

Provider status in the Worker reflects reachability and freshness of the endpoints probed. It does not prove that every symbol or every field is covered; limits and caveats are listed per provider.

## Security
See `docs/SECURITY.md`. Verified by tests: accounts, RBAC with five roles, mandatory TOTP MFA for trader/admin (RFC test vectors), recovery codes, sealed secrets, peppered password hashing, revocable sessions with idle and absolute expiry, CSRF origin checks, lockout, last-admin protection, tamper-evident audit chain (including concurrent writers and tamper detection), nonce-based CSP on every page, rate limiting, input validation, encrypted backup and restore. Browser-verified: sign-in, MFA enrolment, recovery codes, user administration, audit verification, no CSP violations on any page.

Gaps and caveats:
- Account storage needs D1 and `ETI_IDENTITY_KEY`; without them accounts report unavailable.
- Named accounts coexist with the existing automatic paper/testnet sessions. Set `ETI_AUTO_SESSIONS=off` to require sign-in for execution scopes.
- API-key isolation: exchange keys are Worker secrets used only server-side, separate per broker, with no withdrawal functions. There is no per-user key vault; all users of the deployment share the operator's testnet/paper keys.
- Passkeys/WebAuthn, SSO, and per-account IP allow-lists are not implemented.
- KV-based rate limits are approximate (eventual consistency).
- Database access control relies on Cloudflare's binding model; there is no separate database user layer.
- Backups are operator-triggered; there is no built-in scheduler for exporting them off-platform.

## What to do next if you need the full recommended stack
1. Build the Next.js/React/Tailwind front end against the existing JSON APIs (they are already stable and documented), keeping the Worker as the only holder of credentials.
2. Stand up Postgres, Redis and a Celery worker for the Python package, and move heavy research jobs there.
3. Add a vector store (for example pgvector) behind `app/memory`.
Each is a separate project that needs registry and infrastructure access.

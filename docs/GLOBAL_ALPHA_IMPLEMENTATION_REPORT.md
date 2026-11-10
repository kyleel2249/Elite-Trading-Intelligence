# ETI Global Alpha Intelligence (Python backend) — Implementation Report (rev 3)

**Important:** while this was being built, `main` gained its own Worker-side Global Alpha (`worker/alpha/*`, commit 7c2cf0f). This report covers the separate Python implementation; see docs/GLOBAL_ALPHA_PYTHON.md for the overlap table. The two have not been merged functionally, and the Python one was NOT pushed to `main` (no credentials, and duplicating a subsystem needs your decision).

Verification: 315 automated tests pass in the combined tree (main's Python tests + 141 new); pyflakes clean; migration 0005 upgrade/downgrade verified in isolation on SQLite; offline live-server smoke test completed a research cycle with no traceback. Rebased onto current `main` (9f01643) after it was force-updated.

## What changed since rev 1 ("Not complete" items)
| Item | Result |
|---|---|
| Swift / GainzAlgo / OMNISIGNAL X "not present" | **Wrong for the repo as a whole.** They live in `worker/algo/` on `main` (and feature branches). Now consumed through `omnisignal_bridge.py` (read-only `GET /api/omnisignal`), counted as an independent engine; a validated `SELL`/hard-rejected result vetoes. Needs `OMNISIGNAL_BASE_URL`. |
| Duplicate prediction ledger | Retired. Alpha writes to main's immutable ledger (`app/prediction_ledger`) via an adapter. |
| Position sizing vs main's 6% cap | Bug found and fixed: plans could exceed `MAX_POSITION_NOTIONAL_PCT`; now capped, live attempts are limit-only, missing live equity refused with a clear reason. |
| Data-dependent strategy modules | Buffett/Munger quality and Lynch GARP (SEC XBRL), Druckenmiller liquidity regime, Dalio growth x inflation proxy, credit-cycle leg (FRED) now have live evaluators. They are screens, not backtests. |
| Trader profile gaps | Main's own research had raised completeness from ~66% to ~90%. This work added cited, dated, fund-level-labelled return/drawdown notes for Druckenmiller, Lynch (returns), Simons, Paulson and Munger (5 sourced lookups), bringing the audit to ~96%. |
| Coverage gaps | Not closable without licensed data: international exchanges, forex, commodities, futures. Documented, not faked. |

## Still not complete (honest)
* **Profiles (corrected):** the 35 foundational profiles are present and the audit reports about 96% average completeness. An earlier revision of this report wrongly said ten profiles lacked methodology fields; `main`'s newer research had already filled those. What remains: no cited drawdown record for 23 profiles, no cited return record for 8 (Paul Tudor Jones, Dennis, Seykota, Minervini, Wyckoff, O'Neil, Lien, Burry), and no dated prediction outcomes for Dalio. Many of these were never publicly disclosed; recording "not publicly documented" requires a documented search per trader, which has not been done, so they stay listed as gaps. Cited notes added by this work: Druckenmiller, Lynch (returns), Simons, Paulson, Munger.
* **International equities, forex, commodities, futures:** no licensed or verified data adapter. Liquid: existing client is a health check only.
* **Unimplemented styles:** Soros, Kovner, Lien, Templeton, Burry, activist/concentrated, distressed/event legs.
* **Live end-to-end:** blocked by design and also by main's unwired `live_confirmed`.
* **Provider calls** (Binance, DexScreener, Alpaca, SEC, FRED, explorer, Worker) tested only against mock transports; first real success per provider needed.
* **Prediction probabilities** are uncalibrated priors until the ledger accumulates resolved predictions.
* **Role-based access:** single API key only.
* Main's migration 0004 cannot run on SQLite (pre-existing, not changed).

## Dependencies needed from the operator
Alpaca keys, FRED key, `OMNISIGNAL_BASE_URL`, explorer URL + key, wallet labels with sources, `SEC_USER_AGENT` contact, licensed data for non-US markets, primary-source research time for the remaining profiles.

## Live-trading permissions
None active. All flags default off; no withdrawal or transfer capability.

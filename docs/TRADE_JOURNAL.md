# ETI Autonomous Trade Journal

A permanent, append-only record of everything ETI analyses, orders and trades (paper and testnet; live trading stays disabled), plus trades you record yourself. Page: `/journal`. API: `/api/journal/*`.

## What is recorded
Analyses (including NO_TRADE/SELL), executed and resting orders, **refusals by safeguards, broker rejections, unknown outcomes, cancellations, expirations**, fills, closed trades (wins and losses), ledger anomalies, evaluated predictions (hits and misses), manual trades and notes. Nothing is filtered out.

## How entries get in
1. **Live hooks** in the order flow (`worker/execution.ts`, `worker/futures.ts`) and the Omnisignal path (`worker/algo/testnet-api.ts`). They never throw, so a journal fault cannot block a trade.
2. **Sync/backfill** (`POST /api/journal/sync`, and the cron every 5 minutes): reads the portfolio ledgers, `reject:`/`order:`/`exec:paper:rec:` records and the paper engine's closed trades, and appends anything missing. Entry ids are deterministic, so nothing is duplicated.

## Integrity
- No update or delete exists. `PUT/PATCH/DELETE` return 405 `journal_is_append_only`. A correction is a new note with `corrects: <entryId>`.
- Each entry stores `hash = SHA-256(canonical JSON incl. prev)`. `GET /api/journal/verify` recomputes the chain and reports bad hashes, broken links and forks.
- No TTL on journal entries (unlike the 90-day audit records).
- **Storage:** bind D1 `ETI_PORTFOLIO_DB` (apply `migrations/0002_journal.sql`; tables are also created on first use). D1 gives a strict chain and up to 200,000 entries. KV (`ETI_EXECUTION_LOG`) works as a fallback but is tamper-evident only (concurrent writers can fork the chain, which verify reports) and reads are capped at the newest 5,000 entries. **Use D1 for a permanent journal.** A hash chain detects edits; it does not stop someone with direct database access from rewriting the whole chain, so export periodically (`/api/journal/export`) and keep copies elsewhere.

## Statistics and learning
Win rate (with Wilson interval in the API), expectancy, profit factor, payoff, max drawdown, streaks, breakdowns by strategy/symbol/environment/hour/weekday, R multiples only where a risk amount was recorded, order-outcome counts, refusal reasons, prediction hit rate and calibration. Unknown fees stay unknown. Fewer than 30 closed trades is flagged as indicative.
Insights are rule-based, need minimum samples, show their numbers and **only suggest**; they never change trading behaviour or recorded entries.
Prediction rule: using 1h candles, a BUY/SELL analysis is a hit if its first target is reached before its stop within the horizon (default 6 h); stop-first when one candle contains both; otherwise a miss. No data = inconclusive.

## API (master token or any ETI session)
`GET summary | entries | trades | trades/<id> | stats | insights | verify | export?format=csv|json`; `POST sync | manual | note | analysis`.

## Limits
Manual trade P&L is computed from your prices. Testnet/paper only. Not financial advice.

# Live portfolio, open orders and chart integration

Every paper and testnet order is recorded in a persistent, append-only ledger. The dashboard's Open Orders, Positions, Closed Trades, P&L analytics and chart markers are all derived from that ledger and nothing else.

## Environments (strictly separate)
| Environment | Who produces fills | Cash balance | Stop / TP |
|---|---|---|---|
| Internal Paper | ETI simulates (live public price +/- slippage, fee) | simulated, `ETI_PAPER_START_BALANCE` | automatic exits (stop first, TP1/2/3 = 40/30/30) |
| Exchange Testnet | the broker only (Binance testnet, Alpaca paper) | not tracked by ETI (use Reconcile) | alert-only, close manually |
| Live | none | none | disabled, no ledger, API answers 423 |

Each has its own event stream (`pf:<env>:*` in `ETI_EXECUTION_LOG`) and its own session scope. A paper session cannot read the testnet portfolio and vice versa; the master token sees both.

## Data integrity
- Source of truth = events (`submitted, accepted, fill, cancelled, rejected, expired, plan, mark`); state is a pure fold (`worker/portfolio/ledger.ts`).
- An order is not a holding: only fills change positions or cash.
- Duplicate events and duplicate `orderId|fillId` are applied once; fills beyond the order quantity are clamped/ignored; orphans, sells with no position and oversells are listed as anomalies and never counted in P&L.
- Fees the broker does not report stay unknown (shown as `+?`, net marked `*`). Nothing is estimated for testnet.
- Rejections (insufficient simulated balance or holdings, broker rejections) are recorded as `Rejected` orders with the reason.
- Reconcile: internal = recompute cash/quantities from fills; testnet = compare with Binance `/api/v3/account` or Alpaca `/v2/account` + `/v2/positions`.

## API (all authenticated per environment)
`GET /api/portfolio/state?environment=`, `GET /api/portfolio/history?environment=&symbol=&strategy=&result=&from=&to=&source=[&format=csv]`, `POST /api/portfolio/cancel|plan|sync|reconcile`. `/api/orders` accepts `type: "stop"` (sell, internal paper), `stopPrice`, and `plan: {stop, tp1, tp2, tp3}`; a limit/stop order that is not immediately marketable now rests (HTTP 202) instead of being refused.

## Matching (internal paper)
Cron (every minute) walks closed 1m bars after each order's creation: buy limit fills when low <= limit, sell limit when high >= limit, sell stop when low <= stop (gap-aware prices). A bar touching both stop and TP counts as the stop. Day orders expire at 00:00 UTC, IOC orders expire unfilled. When nothing is active and no event arrived, the cycle costs one KV read.

## Storage: D1 (preferred) or KV
- **D1** (`ETI_PORTFOLIO_DB`): strongly consistent SQLite on the free plan. Tables `pf_events` (primary key env+id, so a repeated event id is ignored) and `pf_kv`; each append is one atomic batch that also bumps a head counter. Polling reads one row while nothing changed, so the free-plan list quota no longer applies. The Worker creates the tables on first use; `migrations/0001_portfolio.sql` is the same schema for `wrangler d1 migrations apply`.
- **KV** (`ETI_EXECUTION_LOG`): automatic fallback when no D1 binding exists (eventually consistent, list-based).
- Auth sessions, the key ring, rate limits and the order audit trail stay in KV; the order gateway still needs `ETI_EXECUTION_LOG`.
- Set up: `node scripts/provision-d1.mjs` (creates the database, binds `ETI_PORTFOLIO_DB` in `wrangler.jsonc`, applies the migration), then deploy. If you already have KV portfolio data, call `POST /api/portfolio/migrate-to-d1` with the master token once per environment (`internal_paper`, `exchange_testnet`); it is idempotent.
- Free D1 limits (about 5M rows read and 100k rows written per day when last checked) are much more generous than KV list operations; confirm on Cloudflare's pricing page. Each ledger change re-reads that environment's events once per isolate, so very large ledgers (tens of thousands of events) will want an incremental read.

## Realtime
The dashboard polls (4 s with activity, 15 s idle, 60 s hidden tab, exponential back-off with an offline indicator and immediate refresh after any order). Unrealized P&L is recomputed every second from the live chart price. WebSockets/SSE were not used: no Durable Object is provisioned, and KV is eventually consistent (another edge location can lag about a minute). A Durable Object is the upgrade path for push and strict ordering. On the KV fallback, free-plan list limits (1,000/day) matter for heavy polling; use D1.

## Chart
"My trades and orders" layer: buy (green) / sell (red) markers snapped to the candle containing the fill timestamp (hollow = partial fill, square = exit, SL/TP tags), open-position entry/stop/TP1-3 lines with unrealized P&L, resting order lines, click any marker or line for details. Markers are re-anchored on every redraw so they survive symbol and timeframe changes.

## Verified / not verified
Automated: ledger math, lifecycle, matching, auth isolation, broker parsers and sync against stubbed broker responses, UI script validity. Browser-verified against a harness using the real engine. Not verified: real Binance/Alpaca testnet traffic (no outbound network or credentials in the build environment), and deployed Cloudflare KV behaviour.

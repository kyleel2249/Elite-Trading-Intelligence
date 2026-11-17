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
`GET /api/portfolio/state?environment=`, `GET /api/portfolio/history?environment=&symbol=&strategy=&result=&from=&to=&source=[&format=csv]`, `POST /api/portfolio/cancel|plan|sync|reconcile`. `GET /api/portfolio/manager?environment=` returns risk-first strategy allocation recommendations, sample-size-qualified performance, ledger venue exposure and readiness warnings. It is read-only and never places orders. `/api/orders` accepts `type: "stop"` (sell, internal paper), `stopPrice`, and `plan: {stop, tp1, tp2, tp3}`; a limit/stop order that is not immediately marketable now rests (HTTP 202) instead of being refused.

## Matching (internal paper)
Cron (every minute) walks closed 1m bars after each order's creation: buy limit fills when low <= limit, sell limit when high >= limit, sell stop when low <= stop (gap-aware prices). A bar touching both stop and TP counts as the stop. Day orders expire at 00:00 UTC, IOC orders expire unfilled. When nothing is active and no event arrived, the cycle costs one KV read.

## Storage: D1 (preferred) or KV
- **D1** (`ETI_PORTFOLIO_DB`): strongly consistent SQLite on the free plan. Tables `pf_events` (primary key env+id, so a repeated event id is ignored) and `pf_kv`; each append is one atomic batch that also bumps a head counter. Polling reads one row while nothing changed, so the free-plan list quota no longer applies. The Worker creates the tables on first use; `migrations/0001_portfolio.sql` is the same schema for `wrangler d1 migrations apply`.
- **KV** (`ETI_EXECUTION_LOG`): automatic fallback when no D1 binding exists (eventually consistent, list-based).
- Auth sessions, the key ring, rate limits and the order audit trail stay in KV; the order gateway still needs `ETI_EXECUTION_LOG`.
- **Automatic binding:** `wrangler.jsonc` declares `ETI_PORTFOLIO_DB` with database name `eti-portfolio-db` and no `database_id`. With wrangler 4.45+ (`package.json` requires it), `npm run deploy` creates the database on first deploy and binds it; the Worker then creates the tables itself. Apply `migrations/0001_portfolio.sql` with `npx wrangler d1 migrations apply eti-portfolio-db --remote` if you prefer explicit migrations.
- Explicit alternative (older wrangler, or to pin the id): `node scripts/provision-d1.mjs` (creates the database, binds `ETI_PORTFOLIO_DB` in `wrangler.jsonc`, applies the migration), then deploy. If you already have KV portfolio data, call `POST /api/portfolio/migrate-to-d1` with the master token once per environment (`internal_paper`, `exchange_testnet`); it is idempotent.
- Free D1 limits (about 5M rows read and 100k rows written per day when last checked) are much more generous than KV list operations; confirm on Cloudflare's pricing page. Each ledger change re-reads that environment's events once per isolate, so very large ledgers (tens of thousands of events) will want an incremental read.

## Realtime
The dashboard polls (4 s with activity, 15 s idle, 60 s hidden tab, exponential back-off with an offline indicator and immediate refresh after any order). Unrealized P&L is recomputed every second from the live chart price. WebSockets/SSE were not used: no Durable Object is provisioned, and KV is eventually consistent (another edge location can lag about a minute). A Durable Object is the upgrade path for push and strict ordering. On the KV fallback, free-plan list limits (1,000/day) matter for heavy polling; use D1.

## Chart
"My trades and orders" layer: buy (green) / sell (red) markers snapped to the candle containing the fill timestamp (hollow = partial fill, square = exit, SL/TP tags), open-position entry/stop/TP1-3 lines with unrealized P&L, resting order lines, click any marker or line for details. Markers are re-anchored on every redraw so they survive symbol and timeframe changes.

## Verified / not verified
Automated: ledger math, lifecycle, matching, auth isolation, broker parsers and sync against stubbed broker responses, UI script validity. Browser-verified against a harness using the real engine. Not verified: real Binance/Alpaca testnet traffic (no outbound network or credentials in the build environment), and deployed Cloudflare KV behaviour.

## Futures (Binance USDT-M perpetuals)

Futures orders use a separate event-sourced ledger (`worker/perp/`), stored under the environments `perp_paper` and `perp_testnet`; the spot ledger is untouched.

- **Model:** one-way mode, isolated margin, USDT-margined. The wallet changes only through realized P&L and fees; margin is reserved, not spent. Available = wallet - position margin - resting-order margin.
- **Liquidation price:** long `entry * (1 - margin/notional + mmr)`, short `entry * (1 + margin/notional - mmr)`, with one configurable maintenance rate (`ETI_PERP_MMR`, default 0.5%). Real Binance uses tiered rates, so the real liquidation price can differ.
- **Paper (`perp_paper`):** fills on live Binance futures prices with taker 5 bps / maker 2 bps fees and 5 bps slippage. Resting orders and liquidations are matched against each closed 1m bar (liquidation, then stops, then limits). Funding is **not** simulated.
- **Testnet (`perp_testnet`):** needs `BINANCE_FUTURES_API_KEY` / `BINANCE_FUTURES_SECRET_KEY`. Isolated margin and leverage are set before each order; fills and fees are recorded only from `userTrades`. Stop orders are not supported there. `/api/perp/sync` reconciles positions against the exchange. Tested with a mocked exchange only, not against the live testnet.
- **Routes:** `/api/perp/{config,state,preview,order,close,cancel,sync}`; sessions are scoped paper to `perp_paper`, testnet to `perp_testnet`. The kill switch blocks new exposure but never reduce-only orders or cancels.
- Not supported: COIN-M contracts, hedge mode, cross margin, funding payments.


## AI Portfolio Manager

GET /api/portfolio/manager?environment=internal_paper is an authenticated, read-only allocation advisory. It scores the four managed strategies from up to 60 most recent closed trades per strategy using net expectancy, profit factor, sample reliability and drawdown. Strategies need at least 20 closed trades with known fees, positive net expectancy and a profit factor of at least 1.15 before receiving a recommended allocation. Trades with unknown fees are excluded from the qualification sample. Eligible strategies share a maximum 50% deployment budget, with a 35% per-strategy cap; remaining capital stays unallocated/reserved.

The response includes current ledger equity, cash, position exposure, estimated open risk, venue exposure recorded in the selected ledger, stale marks, missing protective stops and ledger anomalies. Missing/stale account information is never guessed into available capital. Venue exposure is limited to fills recorded in that ledger; it is not a live Bybit/Bitget account-balance aggregator.

This service is advisory only: executionEnabled, live orders, leverage and automatic reallocation remain disabled. It does not call exchange order endpoints or modify the portfolio.

## Cross-exchange account snapshots

`GET /api/portfolio/exchanges` returns a read-only Bybit unified-wallet and linear/inverse-position snapshot plus separate Bitget spot, cross-margin, isolated-margin, USDT-futures, USDC-futures and coin-futures account snapshots. This endpoint requires the ETI master execution token or an administrator session with MFA. It calls only the existing allowlisted GET account endpoints. It never submits, amends or cancels orders, changes leverage, transfers assets or withdraws funds.

Bitget balances are deliberately kept separate by product. Shared collateral can appear in more than one product response, so the API does not add those balances into a synthetic total. Non-USD coin balances remain in their exchange-reported units; they are not assigned an invented USD value. Missing credentials, rejected permissions, regional/IP restrictions and unavailable product endpoints are reported as missing/partial/unavailable data, never as zero balances. The Bybit and Bitget API keys should be configured as Worker secrets with read-only account permissions; withdrawal and transfer permissions should remain disabled.

The portfolio UI refreshes exchange snapshots on request and at a 60-second minimum interval while the manager panel is active. Account snapshots are informational only and are not currently used as deployable capital for the strategy allocator. Live multi-exchange order routing and automatic capital transfers remain disabled pending explicit authorization and reconciliation tests.

## Cross-exchange risk reconciliation and autonomous controls

The authenticated operator endpoints /api/portfolio/reconciliation and /api/portfolio/autonomy extend the read-only Bybit/Bitget snapshots. Reconciliation compares open position quantities by venue, symbol and side with the selected persistent ETI ledger. Missing, stale or mismatched account data fails closed. The combined available-capital subtotal is restricted to Bybit unified-account available USD plus valued Bitget spot availability; Bitget margin and futures collateral is excluded because product accounts may share collateral. Combined USD exposure remains unavailable until open orders and verified position notionals are included.

Autonomous authorization is separate from exchange credentials and portfolio sessions. An operator can authorize agent limits for 15 minutes, capped at USD 1,000 per order and five concurrent positions, or revoke the authorization. This is a control-plane record only: executionDispatchEnabled remains false and no live orders are submitted. Any future execution path must obtain explicit Risk Manager approval; a veto, stale reconciliation, kill switch or exceeded limit blocks it. The Risk Manager veto cannot be overridden. See docs/CROSS_EXCHANGE_RISK.md.

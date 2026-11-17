# Cross-exchange risk reconciliation and autonomous execution control

## Scope
The portfolio account snapshot feeds a reconciliation service for Bybit and Bitget. It compares venue, symbol and side quantities with ETI's persistent ledger, reports stale or missing snapshots explicitly, and withholds verified capital when any position mismatch exists.

## Capital policy
- Bybit unified-account available USD is eligible only when the account snapshot is connected and fresh.
- Bitget spot available assets contribute only when their USD valuation is reported. Cross-margin, isolated-margin, USDT/USDC/coin futures collateral is excluded because product accounts may share collateral.
- Unpriced assets, unavailable product data, stale snapshots and position mismatches never become zero balances or spendable capital.
- Combined exposure remains unavailable until open orders and every position's trusted USD notional are included. The endpoint explicitly reports this limitation.

## Autonomous execution authorization
GET /api/portfolio/autonomy reports authorization state. POST /api/portfolio/autonomy requires master/operator authorization and exact confirmation phrase AUTHORIZE ETI AUTONOMY. Authorizations expire after 15 minutes and have a USD per-order cap (maximum $1,000) and maximum five concurrent positions. Set enabled:false to revoke.

This is an authorization control plane, not a live-order switch. executionDispatchEnabled remains false. The existing execution engine and live-order lockout are unchanged. Before any autonomous order path is enabled, it must pass fresh cross-exchange reconciliation, explicit Risk Manager approval, the kill switch, order caps, position caps and a separate execution-dispatch implementation. The Risk Manager veto is never overridable.

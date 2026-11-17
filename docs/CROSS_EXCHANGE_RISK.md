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

## Exchange execution and open-order synchronization

The operator-only endpoints GET/POST /api/portfolio/exchange-activity read and refresh a persistent exchange activity journal in the portfolio store (D1 when configured, otherwise the existing KV fallback). The sync reads Bybit V5 execution history and current open orders for spot, linear and inverse categories, plus Bitget fills and open orders for spot, cross/isolated margin and USDT/USDC/coin futures. It deduplicates by venue + market + exchange execution ID and retains up to 12,000 recent fills. A seven-day overlap window is re-read each sync to avoid relying on a cursor that could skip late-arriving fills.

A failed market fetch does not erase the last successfully observed open-order snapshot for that market. Partial results are labelled and stale market scopes are returned. Bitget margin symbol discovery must be configured with ETI_BITGET_MARGIN_SYMBOLS (comma-separated symbols) because margin history and open-order endpoints are symbol-scoped.

The activity journal is intentionally separate from the long-only spot portfolio fold. Futures hedge-mode, reduce-only, inverse-contract, and margin borrow/repay semantics are retained as raw normalized venue activity and are not converted into position/cash events. Exchange fills are matched to ETI orders by venue, broker order ID, client order ID or order ID; unmatched activity is surfaced for operator review. This avoids fabricating holdings or P&L. Live environment sync remains disabled.

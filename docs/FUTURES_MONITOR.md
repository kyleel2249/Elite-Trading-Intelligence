# Futures protective-stop monitor and control page

## Protective stops
`worker/futures-monitor.ts` runs from a Cron Trigger **every minute** (`* * * * *`, added to `wrangler.jsonc` next to the existing `*/15` cron, which is still forwarded to the original scheduled handler) and on demand (`POST /api/futures/monitor/run`, bearer). It is a no-op unless `ETI_FUTURES_ENABLED=true`, the testnet futures keys and the KV log are configured.

For each open position it:
1. checks whether a `STOP_MARKET` (`closePosition`) order already protects it;
2. if not, looks up the **audited ETI entry order** for that symbol and direction and uses *its* `stopPrice`;
3. places `STOP_MARKET` + `closePosition=true` + `workingType=MARK_PRICE` on the opposite side, and audits it (`intent: PROTECT`, actor `eti-futures-monitor`).

It does **not** act, and raises a critical alert instead, when: no ETI order with a stop is on record (e.g. a manually opened position), the recorded stop is already beyond mark, open orders could not be read (avoids duplicate stops), or the kill switch is active. It never opens, increases or closes positions. It also alerts on liquidation distance (warning < 15 %, critical < 8 %). Results are stored under `futures:monitor` (24 h) and served by `GET /api/futures/monitor`.

## Control page
`GET /agents/futures` is a read-only page: gateway status, positions with liquidation risk, monitor alerts/actions (with a *Run monitor now* button), reconciliation and an agent plan preview. You type the execution token into the page; it is held in memory only. There is intentionally no order button.

## Caveats
* The audit-log scan reads up to five pages of `order:` keys; a very large history could slow it.
* Cron cadence is one minute, so a freshly filled entry can be unprotected for up to a minute, and a fast move can pass the stop level before it is placed.
* Binance's handling of `closePosition` orders and error codes was written from documentation and not verified against a live testnet account.

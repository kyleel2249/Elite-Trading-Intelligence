# Bitget integration

## Public market data (Cloudflare Workers; no API key)

ETI's shared chart market API supports Bitget directly from Cloudflare Workers. It tries Bitget's UTA V3 public market endpoints first, then falls back to documented Classic V2 public market endpoints through `capi.bitget.com` and `api.bitget.com` when V3 is blocked. The Worker uses Cloudflare's free placement hint targeting the data centre nearest GCP `europe-west1` (Belgium); this is a location hint, not a fixed-IP guarantee. No Fly.io service, paid regional proxy, or exchange credentials are used for public data.

| Product | Symbol catalogue | Chart data category |
|---|---|---|
| Spot | `/api/market/symbols?venue=bitget&market=spot` | `SPOT` |
| Margin (cross / isolated eligibility) | `/api/market/symbols?venue=bitget&market=margin` | `SPOT` for candles/depth/ticker; `MARGIN` for public fills |
| USDT-margined perpetual futures | `/api/market/symbols?venue=bitget&market=futures&category=USDT-FUTURES` | `USDT-FUTURES` |
| USDC-margined futures | same route with `category=USDC-FUTURES` | `USDC-FUTURES` |
| Coin-margined futures (perpetual and delivery where listed) | same route with `category=COIN-FUTURES` | `COIN-FUTURES` |

Futures ticker responses also retain Bitget's mark price, index price, funding rate, open interest, best bid/ask and exchange timestamp where supplied. These are available to the analysis layer without estimating them from spot prices.

The common market endpoints accept `venue=bitget`:
- `GET /api/market/klines?venue=bitget&symbol=BTCUSDT&interval=1m`
- `GET /api/market/depth?venue=bitget&symbol=BTCUSDT`
- `GET /api/market/trades?venue=bitget&symbol=BTCUSDT`
- `GET /api/market/ticker?venue=bitget&symbol=BTCUSDT`

Use `market=futures` and an explicit Bitget futures `category` for derivatives. Use `market=margin` for margin-enabled pairs discovered from Bitget's MARGIN instrument catalogue. Bitget exposes margin pairs from its MARGIN instrument catalogue (V3) or Classic V2 `/api/v2/margin/currencies` fallback, including cross/isolated borrowability and leverage limits. The underlying spot candles, order book and ticker use the SPOT market-data category; V3 margin fills use MARGIN, while the V2 fallback uses the public spot fills tape. ETI keeps the margin eligibility catalogue distinct from ordinary spot listings and never substitutes another exchange's data. The symbol catalogue is refreshed every minute by cron (see "Pair catalogue sync") and cached for 60 seconds per isolate; public REST calls use short cache windows and strict payload validation. Bitget V3's documented candle intervals are used directly; 2h, 8h, 3d, weekly and monthly chart bars are aggregated from hourly or daily candles rather than sending unsupported interval strings.

## Pair catalogue sync (every minute)

All Bitget pairs (spot, USDT-/USDC-/coin-margined futures including delivery contracts, and the margin list) are kept in sync by the existing **every-minute cron** (`* * * * *`), not only when someone opens the dashboard.

| Piece | What it does |
|---|---|
| `worker/bitget/catalogue.ts` | Every minute fetches the five categories (`SPOT`, `USDT-FUTURES`, `USDC-FUTURES`, `COIN-FUTURES`, `MARGIN`) bypassing the in-memory and Cloudflare edge caches, and persists them in D1 (migration `0019_bitget_catalogue.sql`, applied automatically by the deploy workflow). |
| Change tracking | Listings and delistings between two successful refreshes are stored (30-day retention). The first load of a category is the baseline and produces no events. "Listed" means first seen by ETI, not Bitget's own listing time. |
| Partial-failure safety | Each category is fetched independently. If one fails (for example COIN-FUTURES times out), its last confirmed pairs are **kept** and reported as `carried` with their real age; they are never treated as delisted. A category that never synced and is unreachable is reported `missing` with zero pairs. Nothing is invented. |
| Write economy | An unchanged list costs a one-row `UPDATE` per category; the full JSON is rewritten only when the content hash changes. |
| `GET /api/bitget/catalogue` | Public status: `state` (`fresh` = every category confirmed within 150 s and the last run succeeded; `degraded`; `stale`; `never_synced`), per-category pair counts, confirmation age and last error, totals, consecutive failures and the 50 most recent listings/delistings. |
| Snapshot fallback | `/api/market/symbols?venue=bitget` uses the D1 snapshot, labelled `stale` with host `eti-d1-snapshot`, when Bitget cannot be reached (or fills a failed futures product type from it). Without a snapshot an outage is still an honest 502. |
| Python origin | `app/market/symbols.py` now lists Bitget spot **and** all three futures products (previously spot only), carries a failed category forward, tracks new and delisted pairs per market (a futures listing is no longer hidden by a spot pair of the same name), includes Bitget in its one-minute background refresh, and starts that refresh at boot (`SYMBOL_SYNC_ENABLED=false` disables it). `GET /api/market/symbols?provider=bitget&market=futures&product_type=COIN-FUTURES` filters; `GET /api/market/symbols/sync-status` reports the last result and recent delistings. |
| Browser | The pair picker re-reads every 60 s and now keeps a category's last known pairs if that category fails, with a warning, instead of dropping them. |

Set `ETI_BITGET_CATALOGUE_SYNC=false` to switch the Worker cron sync off. If Cloudflare egress is blocked by Bitget, the Worker sync reports the real error class in `/api/bitget/catalogue` (state `stale`/`degraded`) instead of hiding it; the Python origin sync is independent of Cloudflare egress.

Known limits: the browser pair picker still labels every Bitget pair `crypto` (the Worker and Python classifiers are richer), so metals/stock-token filters are only accurate for Worker-served lists.

## Account, fills and history

Worker secrets (only credential variable names are ever reported):

| Credential | Names accepted |
|---|---|
| API key | `BITGET_API_KEY`, `BITGET_KEY`, `BITGET_ACCESS_KEY` |
| API secret | `BITGET_API_SECRET`, `BITGET_SECRET_KEY`, `BITGET_SECRET` |
| Passphrase | `BITGET_API_PASSPHRASE`, `BITGET_PASSPHRASE` |

All private routes except the public margin catalogue require `Authorization: Bearer <ETI_EXECUTION_TOKEN>`. `market` is one of `spot`, `margin-crossed`, `margin-isolated`, `usdt-futures`, `usdc-futures`, `coin-futures`.

| Route | Returns |
|---|---|
| `GET /api/bitget/status` | credential presence (names only), enabled markets and storage readiness |
| `GET /api/bitget/account?market=` | account balances / equity |
| `GET /api/bitget/positions?market=usdt-futures` | futures positions |
| `GET /api/bitget/orders?market=&symbol=` | order history |
| `GET /api/bitget/fills?market=&symbol=&startTime=&endTime=` | normalized fills, fees and realized futures PnL |
| `POST /api/bitget/sync[?market=]` | idempotent fill sync into `ETI_EXECUTION_LOG` |
| `GET /api/bitget/trades?market=&symbol=` | stored trade history |
| `GET /api/bitget/margin-pairs` | public margin eligibility and cross/isolated leverage limits |

The 5-minute sync covers all six account market types when credentials and KV storage are configured. Margin fill history needs explicit symbols via `ETI_BITGET_MARGIN_SYMBOLS`.

## Signed-request reliability and error codes
Signed reads retry transient failures (network error, timeout, HTTP 429/5xx, Bitget 40010) up to three attempts with backoff and honour `Retry-After`. A timestamp rejection (40004/40005/40008) resynchronises from `GET /api/v2/public/time` and retries once; the learned clock offset is shared with the order path. Authentication and permission errors are never retried. Errors carry a `hint` from Bitget's documented V2 list: `40009` signature error, `40012` wrong key or passphrase, `40014` key lacks permission, `40018` request IP not whitelisted (Workers have no fixed egress IP), `40008` timestamp expired. Earlier docs and comments mapped 40018/40019 incorrectly.

## Account-mode note

The existing private account, fill-history and live-order adapter is retained on Bitget Classic V2 endpoints. The new shared chart feed uses the current public V3 market-data endpoints. Bitget documents a UTA V3 migration path and unified order/account endpoints; this change does not silently rewrite the existing private trading adapter. If the Bitget account is already in Unified Trading Account mode, verify the private account/order routes against that account before enabling live execution. The live adapter remains gated by the ETI execution token, explicit enable flag, kill switch and audit log.

## Execution and regional eligibility

- The existing live-order adapter is separate from public market data. It requires the master ETI execution token, explicit risk confirmation, kill-switch approval, audit KV, quantity/notional limits and futures leverage checks. No transfer or withdrawal route is exposed.
- Use an API key with only the permissions ETI needs; disable withdrawals. IP allowlisting may require a fixed egress IP, which Cloudflare Workers Free does not provide. Do not enable IP whitelist unless the Worker outbound IP situation is supported by your Bitget account setup.
- The public API uses Bitget's global host. Hosting the Worker in a Cloudflare location does not alter account registration country, KYC or product permissions. Ghana is not named in Bitget's currently published prohibited-country list, but that list may change and does not guarantee eligibility for every account or product. Use the actual account's verified entity and check the account's own API access. ETI reports upstream geo/IP errors instead of masking them.
- Cloudflare Workers Free is used for this integration; Fly.io is not part of the deployment workflow.

## Verification status

Automated tests cover request routing, all Bitget public product categories, candle normalization, symbol catalogues, margin catalogue, authentication boundaries and malformed upstream data. The catalogue sync is tested against real SQLite (the actual migration) and mocked Bitget payloads, not the live exchange. Production verification still requires the deployed Worker to reach Bitget from its Cloudflare egress (check `GET /api/bitget/catalogue` after deploy: `state` should be `fresh`) and, for private account routes, valid Bitget credentials and KV configuration.

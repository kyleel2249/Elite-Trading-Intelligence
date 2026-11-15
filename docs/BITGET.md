# Bitget integration

## Market data (public, no credentials)
Spot, USDT-/USDC-/coin-margined perpetual futures: candles, depth, trades, tickers, pair lists (`/api/market/*?venue=bitget`, see `MARKET_DATA.md`).
Margin pairs: `GET /api/bitget/margin-pairs` (Bitget `margin/currencies`: symbol, base, quote, status, cross / isolated leverage). Margin pairs are
spot-listed symbols, so their candles use the spot endpoints.

## Account and trade data (read-only, credentials required)
Worker secrets (any listed name works; only names are reported, never values):

| Credential | Names accepted |
|---|---|
| API key | `BITGET_API_KEY`, `BITGET_KEY`, `BITGET_ACCESS_KEY` |
| API secret | `BITGET_API_SECRET`, `BITGET_SECRET_KEY`, `BITGET_SECRET` |
| Passphrase | `BITGET_API_PASSPHRASE`, `BITGET_PASSPHRASE` |

All routes except `margin-pairs` need `Authorization: Bearer <ETI_EXECUTION_TOKEN>`. `market` is one of `spot`, `margin-crossed`,
`margin-isolated`, `usdt-futures`, `usdc-futures`, `coin-futures`.

| Route | Returns |
|---|---|
| `GET /api/bitget/status` | which credential names were found, markets, storage, read-only flag |
| `GET /api/bitget/account?market=` | balances / account equity |
| `GET /api/bitget/positions?market=usdt-futures` | open futures positions |
| `GET /api/bitget/orders?market=&symbol=` | order history |
| `GET /api/bitget/fills?market=&symbol=&startTime=&endTime=` | live fills from Bitget, normalised (id, symbol, side, price, qty, quote qty, fee, fee coin, maker/taker, time, realized PnL for futures) |
| `POST /api/bitget/sync[?market=]` | pulls new fills into KV (`ETI_EXECUTION_LOG`), de-duplicated by fill id, cursor per market |
| `GET /api/bitget/trades?market=&symbol=` | the stored history written by the sync |

The 5-minute cron runs the sync for all six markets when credentials and KV are present. First sync looks back `ETI_BITGET_BACKFILL_DAYS` (default 7, max 90).
Bitget margin endpoints require a symbol, so margin fills are synced only for `ETI_BITGET_MARGIN_SYMBOLS` (comma-separated) or an explicit `symbol` query.

## Safety
- Read-only by construction: only GET requests to a 13-path allowlist are signed (`path_not_allowed` otherwise). No order, transfer or withdrawal endpoint exists in the code, and tests assert this.
- Create the Bitget key with **read-only** permission and, if you use IP whitelisting, whitelist Cloudflare egress or leave it open (Workers have no fixed IP).
- Bitget error codes are passed through (`bitget_40018` bad key/signature, `bitget_40014` missing permission, `bitget_40019` IP not whitelisted); nothing is converted into an empty success.

## Verification status
Implemented from Bitget's documented v2 REST API and tested against mocked responses (signature verified against an independent HMAC, normalisation of
all three fill shapes, idempotent sync, error surfacing). It has **not** been run against the live exchange: the build sandbox cannot reach Bitget. After deploying, call `GET /api/bitget/status`, then `GET /api/bitget/account?market=spot` and `POST /api/bitget/sync`; an error code names the exact problem.
Not built: order placement on Bitget (ETI orders still go to ETI Internal Paper or Binance testnet) and WebSocket streaming (REST polling only).

# Bitget integration

## Public market data (Cloudflare Workers; no API key)

ETI's shared chart market API supports Bitget directly from Cloudflare Workers using the global `https://api.bitget.com` REST host. It does not use Fly.io, a paid regional proxy, or exchange credentials for public data.

| Product | Symbol catalogue | Chart data category |
|---|---|---|
| Spot | `/api/market/symbols?venue=bitget&market=spot` | `SPOT` |
| Margin (cross / isolated eligibility) | `/api/market/symbols?venue=bitget&market=margin` | `SPOT` for candles/depth/ticker; `MARGIN` for public fills |
| USDT-margined perpetual futures | `/api/market/symbols?venue=bitget&market=futures&category=USDT-FUTURES` | `USDT-FUTURES` |
| USDC-margined futures | same route with `category=USDC-FUTURES` | `USDC-FUTURES` |
| Coin-margined futures | same route with `category=COIN-FUTURES` | `COIN-FUTURES` |

Futures ticker responses also retain Bitget's mark price, index price, funding rate, open interest, best bid/ask and exchange timestamp where supplied. These are available to the analysis layer without estimating them from spot prices.

The common market endpoints accept `venue=bitget`:
- `GET /api/market/klines?venue=bitget&symbol=BTCUSDT&interval=1m`
- `GET /api/market/depth?venue=bitget&symbol=BTCUSDT`
- `GET /api/market/trades?venue=bitget&symbol=BTCUSDT`
- `GET /api/market/ticker?venue=bitget&symbol=BTCUSDT`

Use `market=futures` and an explicit Bitget futures `category` for derivatives. Use `market=margin` for margin-enabled pairs discovered from Bitget's MARGIN instrument catalogue. Bitget exposes the margin pair's underlying spot candles, order book and ticker through the SPOT market-data category; the recent fills request uses MARGIN. ETI keeps the margin eligibility catalogue distinct from ordinary spot listings and never substitutes another exchange's data. The symbol catalogue is refreshed on a 60-second cache; public REST calls use short cache windows and strict payload validation.

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

## Account-mode note

The existing private account, fill-history and live-order adapter is retained on Bitget Classic V2 endpoints. The new shared chart feed uses the current public V3 market-data endpoints. Bitget documents a UTA V3 migration path and unified order/account endpoints; this change does not silently rewrite the existing private trading adapter. If the Bitget account is already in Unified Trading Account mode, verify the private account/order routes against that account before enabling live execution. The live adapter remains gated by the ETI execution token, explicit enable flag, kill switch and audit log.

## Execution and regional eligibility

- The existing live-order adapter is separate from public market data. It requires the master ETI execution token, explicit risk confirmation, kill-switch approval, audit KV, quantity/notional limits and futures leverage checks. No transfer or withdrawal route is exposed.
- Use an API key with only the permissions ETI needs; disable withdrawals. IP allowlisting may require a fixed egress IP, which Cloudflare Workers Free does not provide. Do not enable IP whitelist unless the Worker outbound IP situation is supported by your Bitget account setup.
- The public API uses Bitget's global host. Hosting the Worker in a Cloudflare location does not alter account registration country, KYC or product permissions. Ghana is not named in Bitget's currently published prohibited-country list, but that list may change and does not guarantee eligibility for every account or product. Use the actual account's verified entity and check the account's own API access. ETI reports upstream geo/IP errors instead of masking them.
- Cloudflare Workers Free is used for this integration; Fly.io is not part of the deployment workflow.

## Verification status

Automated tests cover request routing, all Bitget public product categories, candle normalization, symbol catalogues, margin catalogue, authentication boundaries and malformed upstream data. Production verification still requires the deployed Worker to reach Bitget from its Cloudflare egress and, for private account routes, valid Bitget credentials and KV configuration.

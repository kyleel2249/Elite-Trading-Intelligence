# Bitget integration

## Public market data (Cloudflare Workers; no API key)

ETI's shared chart market API supports Bitget directly from Cloudflare Workers using the global `https://api.bitget.com` REST host. It does not use Fly.io, a paid regional proxy, or exchange credentials for public data.

| Product | Symbol catalogue | Chart data category |
|---|---|---|
| Spot | `/api/market/symbols?venue=bitget&market=spot` | `SPOT` |
| Margin (cross / isolated eligibility) | `/api/market/symbols?venue=bitget&market=margin` | `MARGIN` |
| USDT-margined perpetual futures | `/api/market/symbols?venue=bitget&market=futures&category=USDT-FUTURES` | `USDT-FUTURES` |
| USDC-margined futures | same route with `category=USDC-FUTURES` | `USDC-FUTURES` |
| Coin-margined futures | same route with `category=COIN-FUTURES` | `COIN-FUTURES` |

The common market endpoints accept `venue=bitget`:
- `GET /api/market/klines?venue=bitget&symbol=BTCUSDT&interval=1m`
- `GET /api/market/depth?venue=bitget&symbol=BTCUSDT`
- `GET /api/market/trades?venue=bitget&symbol=BTCUSDT`
- `GET /api/market/ticker?venue=bitget&symbol=BTCUSDT`

Use `market=futures` and an explicit Bitget futures `category` for derivatives. Use `market=margin` for margin-enabled spot pairs. Spot, margin, USDT, USDC and Coin-M data are never silently substituted for one another. The symbol catalogue is refreshed on a 60-second cache; public REST calls use short cache windows and strict payload validation.

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

## Execution and regional eligibility

- The existing live-order adapter is separate from public market data. It requires the master ETI execution token, explicit risk confirmation, kill-switch approval, audit KV, quantity/notional limits and futures leverage checks. No transfer or withdrawal route is exposed.
- Use an API key with only the permissions ETI needs; disable withdrawals. IP allowlisting may require a fixed egress IP, which Cloudflare Workers Free does not provide. Do not enable IP whitelist unless the Worker outbound IP situation is supported by your Bitget account setup.
- The public API uses Bitget's global host. Hosting the Worker in a Cloudflare location does not alter account registration country, KYC or product permissions. A Ghana-based user must use the actual Bitget account's global/regional entity and the products available to that verified account. ETI will report upstream geo/IP errors instead of masking them.
- Cloudflare Workers Free is used for this integration; Fly.io is not part of the deployment workflow.

## Verification status

Automated tests cover request routing, all Bitget public product categories, candle normalization, symbol catalogues, margin catalogue, authentication boundaries and malformed upstream data. Production verification still requires the deployed Worker to reach Bitget from its Cloudflare egress and, for private account routes, valid Bitget credentials and KV configuration.

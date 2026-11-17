# ETI market-data layer

All public crypto market-data requests are served by `worker/market.ts` on Cloudflare Workers. The Worker uses the exchange's global public REST APIs directly. No Fly.io service, paid regional proxy, VPN, or exchange credentials are required for public market data.

## Explicit venue selection

- **Bybit (default):** V5 spot, spot-margin-eligible pairs, linear perpetual and inverse perpetual markets. Margin pairs are filtered from Bybit's spot instrument catalogue using the exchange-reported `marginTrading` field and use the spot market-data category. Uses `api.bybit.com` with `api.bytick.com` as an alternate host.
- **Bitget:** V3 spot, margin, USDT futures, USDC futures and Coin-M futures. Uses `api.bitget.com`. The three futures product categories are selected explicitly and are never mixed.
- **No silent cross-venue failover:** a Bitget request is never answered with Bybit data, or vice versa. Provider identity and upstream attempts are exposed in response headers.

## Common market endpoints

`GET /api/market/{klines,depth,trades,ticker}`

Query parameters:
- `venue=bybit|bitget` (defaults to Bybit)
- `market=spot|futures|margin` (margin is Bitget margin-enabled spot pairs; Bybit spot margin uses spot category)
- Bybit futures: `category=linear|inverse`
- Bitget futures: `category=USDT-FUTURES|USDC-FUTURES|COIN-FUTURES`
- Bitget spot / margin: `category=SPOT|MARGIN`

Examples:
- `/api/market/klines?symbol=BTCUSDT&interval=1m`
- `/api/market/klines?venue=bitget&symbol=BTCUSDT&interval=1m`
- `/api/market/klines?venue=bitget&market=margin&symbol=BTCUSDT&interval=1m`
- `/api/market/klines?venue=bitget&market=futures&category=USDT-FUTURES&symbol=BTCUSDT&interval=1m`

## Pair catalogues

- Bybit: `/api/market/symbols?venue=bybit&market=all` (spot, linear and inverse), or `market=margin` for pairs whose Bybit instrument metadata reports margin eligibility.
- Bitget: `/api/market/symbols?venue=bitget&market=all` (spot plus all three futures product types).
- Bitget margin: `/api/market/symbols?venue=bitget&market=margin`.

Bitget's catalogue refreshes every 60 seconds and identifies the futures product type in the seventh symbol-array field. Margin eligibility is sourced from Bitget's MARGIN instrument catalogue, not inferred from spot listings.

## Validation and availability

OHLCV rows are validated for finite positive prices, valid high/low bounds, non-negative volume, de-duplicated timestamps and ascending time order. Order books must contain valid bid/ask levels and cannot be crossed. Trades and tickers are validated before being returned. Futures tickers retain exchange-reported mark price, index price, funding rate, open interest, best bid/ask and exchange timestamp when provided. Unsupported intervals and upstream errors are surfaced; ETI does not fabricate data.

## Regional eligibility

Cloudflare Workers Free does not provide a fixed outbound IP or a guaranteed Ghana egress location. The public APIs use the exchanges' global hosts. A user's account country, KYC status, account entity, product permissions and API-key IP rules remain controlled by the exchange. ETI does not spoof location or bypass geographic restrictions. If an exchange rejects Cloudflare's outbound IP, the free Worker architecture cannot guarantee an alternate country egress; the error is reported clearly.

## Cost and deployment

The market-data routes run on the existing Cloudflare Worker deployment. Fly.io deployment and `FLY_API_TOKEN` are not required. Cloudflare account limits and exchange rate limits still apply.

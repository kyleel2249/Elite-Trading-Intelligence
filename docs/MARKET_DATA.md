# Market-data proxy (Cloudflare Worker)

`/api/market/{klines,depth,trades,ticker}` are served by `worker/market.ts`.

- **Providers (order set by `MARKET_PROVIDER_ORDER`, default `binance,bybit,okx`)**: Binance spot
  (`data-api.binance.vision` -> `api-gcp.binance.com` -> `api.binance.com`), Bybit v5 spot, OKX v5 spot.
  All are USDT spot markets, so failover is like-for-like; prices can differ slightly between venues.
  The serving provider is returned in `x-eti-provider`, `x-eti-failover` and `x-eti-attempts` headers.
- **Not used**: Alpaca (crypto is USD-quoted, not USDT) and Liquid (no verified base URL). Never substituted.
- **Validation**: OHLCV must be finite, positive, `low <= open/close <= high`, volume >= 0, de-duplicated and
  time-sorted; order books must be non-empty and not crossed. Invalid/empty data counts as a provider failure.
- **Errors**: if every provider fails the Worker returns **502** with `classification`
  (`http_403_blocked`, `http_451_geo_restricted`, `timeout`, ...) and per-host `attempts`. It never returns a fake 200.
- **Diagnostics**: `GET /api/market/diag?symbol=BTCUSDT&interval=1m` probes every host of every provider and
  reports status, latency, error class, body snippet, `cf-ray`/`server`, candle freshness and failover state.
  `lastSuccessAt` is held in isolate memory and may reset. No credentials are sent or reported.
- **Finding the real 403 cause**: open `/api/market/diag` on the deployed Worker. `blocked` plus a Cloudflare/CloudFront
  HTML body and a non-Binance `server` header means the provider is filtering Worker egress IPs.
- **Tests**: `npm test` (mocked upstreams; proves proxy logic, not exchange reachability).

## Bitget (spot and perpetual futures)

Bitget is a second, explicitly selected data venue. It is never used as a silent fallback for Binance data and Binance is never used
for a Bitget request, so a chart always shows one exchange's prices and the `x-eti-provider` header names it (`bitget` for spot,
`bitget_mix` for perpetual futures).

- **Pair list**: `GET /api/market/symbols?venue=all` (or `venue=bitget`) returns Binance and Bitget pairs. Rows are
  `[symbol, base, quote, market, category, venue]` plus the Bitget product type for futures (`usdt-futures`, `usdc-futures`,
  `coin-futures`). Without `venue` the response is the original five-column Binance list. Sources are Bitget's public
  `spot/public/symbols` and `mix/market/contracts` (perpetual, active contracts of all three product types). One venue or product type
  failing is reported in `warnings` and does not hide the rest.
- **Categories**: `crypto`, `stocks`, `metals`, `commodities`, `indices`, `fx`, decided by the ETI classifier. Only catalogue matches
  count (for example `TSLA`, `TSLAON` / `TSLAX` tokenised equities, `XAU`, `PAXG`); an unrecognised ticker stays `crypto` rather than
  being guessed into a stock.
- **Chart data**: add `&venue=bitget` (and `&market=futures`, optional `&pt=<product type>`, inferred from the symbol suffix when
  omitted) to `/api/market/{klines,depth,trades,ticker}`; `/api/signals` takes `&provider=bitget` (spot) or `&provider=bitget_mix` (futures),
  which the dashboard sends automatically. Same validation as every other provider; invalid or empty
  data is a 502, never a fake 200.
- **Dashboard**: the Exchange selector next to Market (All / Binance / Bitget) filters the pair dropdown. With "All", a pair listed on
  both exchanges shows once (Binance); Bitget-only pairs are labelled "Bitget". Spot, Futures and Metals all include Bitget pairs.
  Bitget pairs are chart-only: orders still go only to Binance spot testnet / Alpaca paper.
- **Limits**: delivery (dated) contracts are not listed. Bitget pairs update by REST polling (no WebSocket). The ETI risk review
  classifies by symbol, so a Bitget stock perpetual such as `TSLAUSDT` is reviewed as a crypto-quoted contract until the classifier
  learns it. 2h and 8h candles are not offered by Bitget and return `unsupported_by_provider`.
- **Verification status**: covered by mocked-upstream tests only. The endpoint paths and response shapes follow Bitget's documented v2
  public API but could not be exercised against the live exchange from the build environment; check `/api/market/diag`-style
  behaviour on a deployed Worker (a 502 with `attempts` names the exact upstream failure).

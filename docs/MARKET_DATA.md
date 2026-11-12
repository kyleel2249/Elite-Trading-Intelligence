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

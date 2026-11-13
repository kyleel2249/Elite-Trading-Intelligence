# Binance market data and regions

ETI reads Binance **public** market data (symbol list, candles) through `app/market/binance_hosts.py`. It tries Binance's official global hosts in order and remembers the one that last worked:

`api.binance.com`, `api-gcp.binance.com`, `api1.binance.com` to `api4.binance.com`, `data-api.binance.vision` (market data only).

**Binance.US is never used.** Override the list with `ETI_BINANCE_PUBLIC_HOSTS` (comma-separated https URLs); plain-http and `binance.us` entries are ignored.

## What this does and does not do

- It keeps market data available when one host is slow, down or erroring.
- It does **not** get around Binance's location restrictions. Binance refuses some regions, including the US, by the caller's IP on every official host. If all hosts answer HTTP 451/403, ETI reports `Binance is refusing requests from this server's location` rather than showing data it does not have. ETI does not use proxies or VPNs to evade this.
- The fix for a location block is to run the ETI server in a region Binance serves.

## Check it

```bash
curl https://<host>/api/market/binance-hosts          # hosts, last good host, last failures
curl 'https://<host>/api/market/symbols?provider=binance&q=BTC&limit=5'   # sources.binance.host shows who answered
curl -i 'https://<host>/api/market/public-history?symbol=BTCUSDT'         # X-Binance-Host header
```

## Where ETI runs

`fly.toml` sets `primary_region = "iad"` (Virginia, US). Machines there use US IP addresses, so Binance will usually refuse them. Moving the Fly app to a non-US region (for example `fra`, `ams`, `sin` or `nrt`) needs a new `eti_data` volume in that region and a data migration if you use SQLite on the volume, so it is a deliberate step and has not been done automatically. The Cloudflare Worker build serves from Cloudflare's edge and is not tied to one region.

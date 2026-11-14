# Markets you can list and chart

`GET /api/market/symbols?provider=...` lists instruments; `GET /api/market/public-history?provider=...&symbol=...` returns candles for the 3D market view. Both are read-only.

| provider | what | needs | symbol format |
|---|---|---|---|
| `binance` | every TRADING spot pair on global Binance (never Binance.US) | nothing | `BTCUSDT` |
| `bitget` | every online Bitget spot pair | nothing | `BTCUSDT` |
| `alpaca` | US stocks | `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` | `AAPL` |
| `oanda` | forex, spot metals, index/commodity CFDs your OANDA account offers | `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID` | `EUR_USD`, `XAU_USD`, `DE30_EUR` |
| `twelvedata` | non-US stocks and forex pairs | `TWELVEDATA_API_KEY`; optional `TWELVEDATA_EXCHANGES` (comma-separated MIC codes, default XLON,XETR,XPAR,XAMS,XSWX,XMIL,XSTO,XTKS,XHKG,XASX,XTSE,XNSE) | `SAP:XETR`, `EUR/USD` |

Filters: `q`, `quote`, `exchange` (e.g. `XETR`, `FOREX`), `new_only=true`, `limit`, `offset`, `refresh=true` (rate limited).

## Honesty rules

- A source without credentials reports `not_configured`; one that cannot be reached reports `unavailable`; an older successful list is labelled `stale`. No list is ever invented.
- Twelve Data is read one exchange at a time. If your plan's rate limit stops some exchanges, the response still lists the ones that loaded and names the ones that failed in `sources.twelvedata.message`.
- `new` means this server first saw the pair after its first load of that exchange; it is not the exchange's listing time.
- Candles are plotted as delivered. Stock/forex candles are labelled STALE outside market hours.
- OANDA, Alpaca and Twelve Data chart requests answer 503 when their credentials are missing, with the reason shown on the page.

## Not verified here

The Bitget and Twelve Data request/response shapes follow each provider's documented REST API and are tested with mocked responses only. Check them against your own keys; a free Twelve Data plan may not include some non-US exchanges or intraday intervals, and it will say so in the error shown on the chart.

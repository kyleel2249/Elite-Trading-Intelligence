# ETI GainzAlgo V2 and V2 Alpha integration

## Scope and provenance
ETI provides two separate source-engine identities: `gainz_v2` and `gainz_v2_alpha`. It accepts signals only through a documented/licensed integration or an operator-controlled TradingView alert webhook. ETI does not claim access to GainzAlgo's private Pine Script, AI model, weights, or proprietary signal formula. Its independent technical assessment is labelled ETI-native and is not represented as the vendor indicator.

## Endpoints
- `GET /gainz` — GainzAlgo Intelligence Centre.
- `GET /api/gainz/status` — service, D1 and webhook readiness (no credentials exposed).
- `POST /api/gainz/webhook` — signed TradingView alert ingestion.
- `GET /api/gainz/signals` — authenticated signal history.
- `GET /api/gainz/compare` — authenticated V2 / Alpha signal and resolved-outcome comparison.
- `GET /api/gainz/config`, `PUT /api/gainz/config` — authenticated configuration.
- `GET /api/gainz/analyse?symbol=BTCUSDT&interval=15m&market=spot` — ETI independent TA, FVG and displacement analysis.
- `POST /api/gainz/outcomes` — authenticated, one-time outcome recording.

## Database
Apply the additive D1 migration:
```sh
npx wrangler d1 migrations apply eti-portfolio-db --remote
```
The binding is the existing `ETI_PORTFOLIO_DB` in `wrangler.jsonc`. The migration creates only `gainz_*` tables and does not modify existing tables.

## Secrets
Set two Cloudflare Worker secrets:
- `ETI_GAINZ_WEBHOOK_SECRET`: high-entropy secret used to verify TradingView webhook HMAC signatures.
- `ETI_GAINZ_ADMIN_TOKEN`: optional dedicated dashboard/API token. If absent, the existing `ETI_EXECUTION_TOKEN` is accepted for authenticated read/write administration.

Never place secrets in frontend code, Git, TradingView alert bodies, or public Worker variables.

Webhook signature:
- Header `X-ETI-Gainz-Timestamp`: Unix timestamp in seconds (or milliseconds).
- Header `X-ETI-Gainz-Signature`: `sha256=<hex>`.
- HMAC-SHA256 message: `<timestamp>.<exact raw request body>`.
- Requests with timestamps outside five minutes are rejected.

Example payload:
```json
{
  "engine": "gainz_v2_alpha",
  "preset": "alpha",
  "signalId": "unique-alert-id",
  "symbol": "BTCUSDT",
  "exchange": "BINANCE",
  "market": "futures",
  "direction": "BUY",
  "timeframe": "5m",
  "signalTimestamp": 1794834000,
  "entry": 90000,
  "stopLoss": 89550,
  "tp1": 90900,
  "tp2": 91350,
  "tp3": 91800
}
```

## Execution boundary
This integration ingests, validates, stores, compares and analyses signals. It does not directly submit orders. Any subsequent order must be explicitly reviewed and submitted through ETI's existing execution route, which currently documents Alpaca Paper and Binance Spot Testnet safeguards. It does not enable live trading, futures order submission, leverage changes, or exchange credentials from this signal webhook.

## Validation and reporting
A signal's directional score and consensus score are evidence scores, not probabilities. Win rate and profit factor are not reported until outcomes have been explicitly resolved and stored. Outcomes are one-time records per signal. The signal source, raw payload, validation reasons and consensus events are retained in D1.

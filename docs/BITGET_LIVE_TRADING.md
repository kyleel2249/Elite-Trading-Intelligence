# Bitget live trading

ETI supports explicitly confirmed Bitget live orders through the master-authenticated `POST /api/orders/live` endpoint. This is separate from ETI Internal Paper, Alpaca Paper and Binance Testnet.

## Supported account API mode

The private account and order adapters use Bitget Classic V2 endpoints. If the account is Unified Trading Account (UTA) and requires V3 private account/order endpoints, do not enable live orders with this adapter until UTA support has been implemented and verified.

## Credentials and permissions

Configure these as Cloudflare Worker secrets (or GitHub Actions secrets used by the deploy workflow):

- `BITGET_API_KEY`
- `BITGET_API_SECRET`
- `BITGET_API_PASSPHRASE`
- `ETI_EXECUTION_TOKEN`

Use a dedicated API key with only required read/trade permissions. Disable withdrawals and transfers. Never put credentials in `wrangler.jsonc`, browser code, chat, or source control.

## Account and connectivity routes

All private routes require `Authorization: Bearer <ETI_EXECUTION_TOKEN>`. The public margin catalogue is the exception.

| Route | Purpose |
|---|---|
| `GET /api/bitget/status` | Secret-free credential presence, market list and KV readiness |
| `GET /api/bitget/verify` | Three signed, read-only deployed-Worker checks: Spot account, USDT-M Futures account, and USDT-M Futures positions |
| `GET /api/bitget/account?market=spot` | Spot, margin or futures account assets |
| `GET /api/bitget/positions?market=usdt-futures` | Futures positions |
| `GET /api/bitget/orders?market=spot` | Order history |
| `GET /api/bitget/fills?market=spot` | Normalized fill history |
| `POST /api/bitget/sync` | Idempotent fill-history sync to KV |
| `GET /api/portfolio/exchanges` | Read-only account snapshot |
| `GET /api/portfolio/exchange-activity?environment=exchange_testnet` | Stored exchange fill/open-order activity |
| `POST /api/portfolio/exchange-activity?environment=exchange_testnet` | Refresh Bitget and Bybit fill/open-order activity |

The verification route returns only pass/fail metadata and safe error codes; it does not include balances, positions, or credentials. It does not enable trading and does not verify private WebSocket streaming.

The scheduled portfolio monitor polls exchange activity approximately every five minutes. The activity journal is kept separate from ETI's long-only paper/testnet position ledger so hedge-mode futures and reduce-only fills are not incorrectly folded into spot positions. The journal retains the latest 12,000 unique fills and seven days are queried per sync.

## Order execution and safeguards

Bitget live orders use `POST /api/orders/live` and require the master ETI execution token, `ETI_BITGET_LIVE_ENABLED=true`, `ETI_BITGET_EGRESS_VERIFIED=true`, an audit KV binding, explicit `riskConfirmed: true`, a unique ETI client order ID, valid execution source, quantity/notional caps and a disabled kill switch. Futures additionally require explicit leverage and margin mode. Acknowledgement means accepted, not necessarily filled.

Live execution stays disabled by default. Never set `ETI_BITGET_EGRESS_VERIFIED=true` until the deployed `/api/bitget/verify` route succeeds from the Cloudflare Worker and the API key's account mode and permissions have been confirmed. An ambiguous order response remains reserved; check Bitget order history before retrying. No withdrawal, transfer or funding route is exposed.

## WebSocket status

Public market-data WebSockets are separate from private account activity. The authenticated account sync currently uses signed REST polling. Private WebSocket account/order streaming, automatic position-ledger folding, and automatic agent-council live dispatch are not enabled by this change.

## Verification limits

Automated tests use mocked exchange responses and verify signing, route mounting, error handling and fail-closed behavior. They do not prove real credentials, Cloudflare egress, account eligibility, fills, or production order execution. Those require the deployed read-only verification route and then a separately approved testnet/live rollout.

# Bybit V5 integration

ETI uses Bybit V5 as its primary crypto exchange integration. Public market data is read-only and does not require API credentials. Private account and execution access is server-side only.

## Products

- **Spot:** market data, instrument discovery and execution.
- **Spot margin:** uses the Spot category (category=spot). ETI's execution account must explicitly include margin_enabled=true; Bybit must have margin trading enabled and the pair must be margin-eligible. Borrowing availability, collateral and interest remain exchange/account controlled.
- **Linear perpetuals:** category=linear (USDT/USDC-settled).
- **Inverse perpetuals:** category=inverse (coin-settled).

The V5 instrument catalogue is the source of truth. Linear and inverse instruments are cursor-paginated; ETI filters for trading perpetual contracts. A symbol being listed does not mean the account is allowed to trade it.

## Configure a testnet account

1. Create a Bybit Testnet account and generate an API key with read/trade permissions only.
2. Do not grant withdrawal, transfer or asset-transfer permissions. Restrict the key by IP where possible.
3. Set these values in the FastAPI backend's secret environment (never in browser code, Git, or chat):

~~~dotenv
BYBIT_TESTNET_API_KEY=
BYBIT_TESTNET_API_SECRET=
BYBIT_TESTNET_ENABLED=true
BYBIT_LIVE_TRADING_ENABLED=false
~~~

4. Set EXECUTION_ENABLED=true only after the execution vault key and database are configured. Set EXECUTION_VAULT_KEY to a strong Fernet key. Keep LIVE_TRADING_ENABLED=false.
5. Verify the account using the protected /api/execution/accounts/{account_id}/verify endpoint. The automatically provisioned environment account is env-bybit-testnet and starts in intelligence-only mode.

For manually created execution accounts, provider is bybit, credentials are api_key and api_secret. Optional credential fields:
- category: spot (default), linear, or inverse.
- margin_enabled: true only for an account where Bybit spot margin is already enabled.

## Execution safety

ETI sends orders through the Python execution engine and its existing account policy, proposal/approval, risk, idempotency and reconciliation controls. A successful Bybit order acknowledgement means accepted, not necessarily filled. ETI uses orderLinkId for reconciliation and will not blindly retry an ambiguous write. Spot market buys explicitly use base-coin quantity; derivatives use contract quantity. Limit orders use IOC to avoid leaving unmanaged resting orders.

Testnet is the only recommended initial environment. Live execution requires a separately created environment=live account, the global LIVE_TRADING_ENABLED=true gate, successful key-permission verification and the same ETI risk controls. ETI does not expose transfer or withdrawal endpoints.

## Market data region and live streams

- Cloudflare's ETI market-data Worker is explicitly placed near AWS Cape Town (`aws:af-south-1`) so public Bybit REST requests do not originate from the US-based GitHub Actions runner region that produced HTTP 403 responses.
- Check the live Worker execution location with `GET /api/market/region`; a successful regional placement reports a Cloudflare `cf-placement` value ending in `-CPT`.
- The Python FastAPI origin remains in Fly.io Frankfurt (`fra`), outside Bybit's documented US and mainland-China IP blocks. It remains there to avoid adding cross-region latency to its existing PostgreSQL connection.
- ETI uses Bybit's global REST hosts (`api.bytick.com`, `api.bybit.com`) and global public WebSocket hosts for the Ghana-registered international account. Dedicated regional API domains must only be used when Bybit says the user's own account is registered on that regional site; server placement does not change account residency.
- REST snapshots/history use the Bybit V5 public market endpoints.
- Instruments use /v5/market/instruments-info with pagination for linear/inverse.
- Public WebSockets: wss://stream.bybit.com/v5/public/spot, /linear, and /inverse.
- The Python stream hub starts separate public WebSocket connections for Spot, Linear and Inverse. Startup defaults are BTCUSDT/ETHUSDT for Spot and Linear, plus BTCUSD for Inverse.
- The full instrument catalogue is refreshed on a 60-second cadence. The WebSocket watchlist is selected separately so ETI does not subscribe every listed instrument indiscriminately or exceed venue topic limits.
- Additional symbols are validated against the current Bybit instrument catalogue and subscribed without reconnecting the existing socket.
- Spot margin uses the Spot market-data stream; margin eligibility is supplied by the instrument catalogue and account-side borrowing permissions remain separate.
- Category-aware live quote: `GET /api/market/live?symbol=BTCUSDT&provider=bybit&category=linear`.
- Category-filtered SSE: `GET /api/stream/sse?symbol=BTCUSDT&category=linear`.
- Add a live subscription (requires the ETI API key): `POST /api/stream/subscribe` with `{"provider":"bybit","category":"linear","symbols":["BTCUSDT"]}`.
- Stream status: `GET /api/stream/status`; category-specific connection and subscription state appears under `bybit_categories`.
- Derivatives context: `GET /api/market/bybit/derivatives-context?symbol=BTCUSDT&category=linear&interval=1h&limit=50` returns the latest funding rate, chronological open-interest observations and the latest open-interest change. The endpoint is public and read-only.

Private WebSocket order/fill streaming is not enabled in this change; execution status is reconciled through authenticated REST reads. Do not assume an account stream is connected just because public prices are streaming.

## Important limitations

- Options are not enabled in ETI's trading adapter in this release.
- Spot margin borrowing is opt-in and requires the account's own UTA eligibility/collateral setup.
- Bybit product availability, leverage, margin mode and regional API hosts depend on the user's account jurisdiction and account mode.
- Public market data and private execution are independent: market-feed health does not prove that credentials or order permissions are valid.

Official references: [V5 introduction](https://bybit-exchange.github.io/docs/v5/intro), [instrument information](https://bybit-exchange.github.io/docs/v5/market/instrument), [place order](https://bybit-exchange.github.io/docs/v5/order/create-order), [WebSocket connection](https://bybit-exchange.github.io/docs/v5/ws/connect).

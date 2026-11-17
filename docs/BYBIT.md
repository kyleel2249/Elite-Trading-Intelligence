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

## Market data and live streams

- REST snapshots/history use the Bybit V5 public market endpoints.
- Instruments use /v5/market/instruments-info with pagination for linear/inverse.
- Public WebSockets: wss://stream.bybit.com/v5/public/spot, /linear, and /inverse.
- ETI's 3D chart can select Spot/Margin, Linear perpetual and Inverse perpetual and uses Bybit ticker/trade WebSocket topics for live candle updates.
- The Python stream hub currently starts a Spot stream for BTCUSDT and ETHUSDT by default; additional symbols are restricted by its market-data allowlist.

Private WebSocket order/fill streaming is not enabled in this change; execution status is reconciled through authenticated REST reads. Do not assume an account stream is connected just because public prices are streaming.

## Important limitations

- Options are not enabled in ETI's trading adapter in this release.
- Spot margin borrowing is opt-in and requires the account's own UTA eligibility/collateral setup.
- Bybit product availability, leverage, margin mode and regional API hosts depend on the user's account jurisdiction and account mode.
- Public market data and private execution are independent: market-feed health does not prove that credentials or order permissions are valid.

Official references: [V5 introduction](https://bybit-exchange.github.io/docs/v5/intro), [instrument information](https://bybit-exchange.github.io/docs/v5/market/instrument), [place order](https://bybit-exchange.github.io/docs/v5/order/create-order), [WebSocket connection](https://bybit-exchange.github.io/docs/v5/ws/connect).

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

## Market data transport and account region

- Public REST market data runs directly from the Cloudflare Worker using Bybit's global API hosts `api.bybit.com` and `api.bytick.com` (primary + alternate host). No Fly.io origin, static-IP proxy, VPN, or account-region spoofing is used.
- Cloudflare Workers are globally distributed and do not provide a guaranteed Ghana egress IP or fixed outbound IP on the free plan. The global Bybit API is the appropriate host for an account registered with Bybit's global entity, subject to that account's KYC and product permissions.
- The Worker's actual outbound IP geography is controlled by Cloudflare, not ETI. If Bybit rejects that egress with a geo/IP error, the free Worker architecture cannot guarantee a different country egress. Do not change account country or use a proxy to bypass Bybit restrictions.
- Public market REST requests are read-only and do not require exchange credentials. Account and order routes remain subject to the account's own country, product eligibility, API-key permissions and IP whitelist.
- The Python WebSocket service is separate from this Cloudflare-only public REST path; it is not a deployment prerequisite for the Worker chart REST endpoints.

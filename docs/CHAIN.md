# ETI on-chain wallet

ETI can own **one EVM address**, hold native coin, and transact on-chain under a hard spending policy. The same address works on every supported EVM network.

## What it does
- Generates a private key **on the server**, encrypts it with the existing credential vault (`EXECUTION_VAULT_KEY`, a Fernet key kept separate from the database) and stores only the ciphertext. No endpoint returns, logs or exports the key.
- Reads chain state over JSON-RPC (block, gas, balances, token balances).
- Sends native-coin transfers and DEX swaps (Uniswap-V2-style router) with exact-amount approvals.
- Inspects contracts and scans recent blocks for large native transfers and watched addresses (read-only intelligence).

UI: `/wallet`. API: `/api/chain/*` (every route needs `X-API-Key` when the server enforces one).

## Safeguards (enforced server-side, in this order)
1. **Testnets by default.** Mainnet sending is refused unless the operator sets `CHAIN_MAINNET_SEND_ENABLED=true`.
2. **Preview, then send.** A preview runs the policy and returns an HMAC-signed, 120-second, **single-use** quote bound to the exact transaction. `send` re-verifies the quote, re-runs the policy, and requires the literal confirmation `SEND`.
3. **Spending policy:** destination allowlist (required by default), per-transaction cap, 24-hour cap (failed broadcasts do not count), global kill switch (`KILL_SWITCH`), swap slippage cap, token allowlist, exact-amount approvals only (never unlimited).
4. **Chain-ID check** on every RPC use: an endpoint that reports the wrong chain is refused.
5. **Honest status:** a transaction is `pending` after the node accepts it and `confirmed`/`failed` only when a receipt says so. Broadcast rejections are recorded as `broadcast_failed`.
6. **Audit trail** (`eti_chain_events`) and full transaction records. Nonces are serialised under a lock.

## Operator setup
1. Set `EXECUTION_VAULT_KEY` (generate with `CredentialVault.generate_key()`), store it in your host's secret store, **separate from the database**.
2. Run `alembic upgrade head` (migration `0009_chain_wallet`).
3. Optionally set a private RPC per network: `CHAIN_RPC_SEPOLIA`, `CHAIN_RPC_BASE_SEPOLIA`, ... (hyphens become underscores). Sepolia has a public default; mainnets have none. RPC URLs often contain API keys, so they are never returned or logged.
4. Open `/wallet` and create the wallet. Fund the address from a testnet faucet.
5. Add allowlist entries (destinations, tokens with symbol and decimals, watch addresses).
6. For trading, set `CHAIN_DEX_ROUTER_<NETWORK>` and `CHAIN_WRAPPED_NATIVE_<NETWORK>` to addresses **you have verified** on that network (ETI hard-codes none).

| Variable | Default | Meaning |
|---|---|---|
| `CHAIN_ENABLED` | true | Master switch for `/api/chain` |
| `CHAIN_MAX_TX_NATIVE` | 0.05 | Max native value moved per transaction |
| `CHAIN_MAX_DAILY_NATIVE` | 0.2 | Max native value moved per rolling 24h, per network |
| `CHAIN_MAX_SLIPPAGE_BPS` | 100 | Max swap slippage (hard ceiling 1000) |
| `CHAIN_REQUIRE_ALLOWLIST` | true | Transfers only to allowlisted destinations |
| `CHAIN_MAINNET_SEND_ENABLED` | false | Allow sending on mainnet networks |

## Limits you must know about
- **The key cannot be exported.** If the database *or* the vault key is lost, funds in the wallet are lost. Back up both, separately.
- **Cryptography is hand-written pure Python** (Keccak-256, secp256k1, RLP, transaction signing) so it adds no dependency. It is verified against published vectors (including the canonical EIP-155 transaction) in `tests/test_chain_crypto.py`, but it is **not constant-time** and has had no external audit. Before holding meaningful value, replace `app.chain.crypto.sign` with an audited library or a KMS/HSM.
- **No ERC-20 transfers** are offered (swap proceeds stay in the wallet). Only native transfers, swaps and exact approvals.
- **Swap quotes** are the router's current pool state: price impact, MEV/sandwiching and token transfer taxes are not modelled. Contract inspection reports indicators only (no honeypot simulation, no source check): the absence of an indicator is not a safety verdict.
- Public RPCs can rate-limit or censor; use a private endpoint for anything serious.
- Mainnet use is the operator's decision and responsibility. Start on a testnet.

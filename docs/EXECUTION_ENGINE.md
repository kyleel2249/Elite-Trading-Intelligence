# ETI Autonomous Trading Engine

Optional execution layer (`app/execution/`, API under `/api/execution`). Disabled until `EXECUTION_ENABLED=true`.
It sits beside the existing paper/live path (`/api/trading/order`), which is unchanged.

## Operating modes (per account)

| Mode | Behaviour |
|---|---|
| `intelligence_only` (default) | Signals are logged as analysis. No order is ever created. |
| `assisted` | Signal becomes a proposal (`pending_approval`, expires after `proposal_ttl_seconds`). A human approval re-runs every guard on fresh data, then executes. A proposal can be decided exactly once. |
| `autonomous` | Executes inside the user-approved instruments, per-order and total capital limits, strategy list and risk rules. Requires `POST /accounts/{id}/autonomous/enable?confirm=ENABLE AUTONOMOUS TRADING ON <id>`. Any policy change revokes that authority. |

## Order path (every mode ends in `ExecutionEngine._execute`, which fails closed)

1. Halt / global `KILL_SWITCH` check, intent validation, approved-symbol and strategy check.
2. Duplicate prevention: deterministic idempotency key (explicit key, `signal_id`, or hash of the order + time window), unique in the database, plus a same-symbol/side window.
3. Live data: quote must exist, be uncrossed, not stale (`max_quote_age_seconds`), not future-dated, spread <= `max_spread_bps`. Order book (where the venue has one): depth >= `min_depth_ratio` x size and expected slippage <= `max_slippage_bps`.
4. Slippage control: market intents are converted to marketable limits at ask(+)/bid(-) the slippage band; a user limit beyond the band is refused. Prices round toward the conservative side; quantity floors to the venue lot size; venue min qty/notional checked.
5. Position logic: no shorting unless allowed and supported; sells cannot exceed available long position; `reduce_only` honoured.
6. Capital limits (no limit configured = reject), daily order cap, then the independent `RiskEngine` (kill switch, `LIVE_TRADING_ENABLED`, notional % of equity, daily loss and drawdown from broker equity, freshness). Live with no risk engine configured = refuse.
7. Order row is persisted **before** sending. Failures: explicit venue reject -> `rejected`; timeout/unknown -> look up by client order id, adopt if found, resend the same id only if the venue confirms absence, otherwise `unknown` and never blind-resend.

Afterwards: partial fills are tracked; unfilled/partial remainders are cancelled after `order_ttl_seconds`; positions are reconciled against the broker (baseline + ETI fills; mismatch halts the account; `reconcile_tolerance_pct` absorbs fees taken in the base asset); a per-venue circuit breaker detects downtime and probes recovery; `emergency-flatten` halts, cancels working orders and sends reduce-only closing orders (ETI-opened quantity by default, `scope=all` for everything) and is retried by the supervisor until it completes.

Every step writes to the append-only `execution_logs` table (credentials are scrubbed).

## Adapters

| Provider | Status |
|---|---|
| alpaca (US equities, paper/live) | implemented, unit-tested against scripted responses, **not yet run against the live API** |
| binance (spot, testnet/live) | implemented, same caveat. Refuses keys with withdrawals enabled (live). |
| oanda (forex/CFD, practice/live) | implemented, same caveat |
| kraken, coinbase | **not implemented** (calls fail with `ProviderUnavailableError`) |
| mt5 | **not implemented**: MetaTrader 5 exposes only a local Windows terminal API; needs a bridge service |
| ibkr | **not implemented**: needs a running Client Portal Gateway / TWS session; needs a bridge service |

Nothing is simulated for unsupported venues. Use each venue's own sandbox (Alpaca paper, Binance testnet, OANDA practice) with `environment: "paper"`.

## Credentials

`POST /api/execution/accounts` seals the credentials with Fernet using `EXECUTION_VAULT_KEY` (a secret separate from the database) and stores only ciphertext. Plaintext exists in backend memory while an adapter is loaded. Responses never contain credentials. Generate a key:
`python -c "from app.execution.vault import CredentialVault; print(CredentialVault.generate_key())"`.
Create keys with trading permission only. ETI never requests withdrawal permission and refuses Binance keys that have it.

## Setup checklist

1. `EXECUTION_ENABLED=true`, `EXECUTION_VAULT_KEY=<key>`, `API_KEY=<secret>`.
2. Register an account (`paper` first), `POST /accounts/{id}/verify`.
3. `PUT /accounts/{id}/policy` with instruments, `max_order_notional`, `max_total_notional`, mode.
4. Send signals to `POST /signals`. In assisted mode approve via `POST /proposals/{id}/approve`.
5. Live additionally needs `LIVE_TRADING_ENABLED=true`.

## Known limitations

- Adapters are unverified against real venues; run on paper/testnet/practice before any live use.
- Daily-loss and drawdown use broker equity sampled when orders are evaluated (unrealised P&L included).
- The legacy `OrderRequest`/`TradingService` path is untouched; its provider-specific live gates still apply there only.
- No dashboard UI for this engine yet; use the API.

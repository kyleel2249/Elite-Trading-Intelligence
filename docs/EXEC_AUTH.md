# Execution authorization (internal paper, exchange testnet, live)

ETI authorizes every order **server-side**. Internal paper trading needs no manually supplied token or
exchange key; exchange testnets authenticate from server secrets; live trading is disabled and cannot be
authorized by any credential.

## How it works

| Environment | Who may order | Credential | Where it lives |
|---|---|---|---|
| `internal_paper` | the dashboard (automatic session) or the operator key | opaque session token `eti_ip_…` | HttpOnly cookie in the browser; only a keyed hash on the server |
| `exchange_testnet` | the operator (Execution Engine API) | Binance sandbox key/secret from server secrets; operator-established session `eti_xt_…` | environment secrets → encrypted vault (`EXECUTION_VAULT_KEY`) |
| `live` | nobody | none | disabled; `live_disabled` (403) everywhere |

* On page load the dashboard calls `POST /api/auth/session`. The server mints a random 256-bit token and
  returns it **only** as `Set-Cookie` (`HttpOnly; Secure; SameSite=Strict; Path=/api`). No token appears in a
  response body, the page, `localStorage`, logs or audit rows. The page cannot read it.
* Tokens are stored as `HMAC-SHA256(key, token_id.secret)`; the signing key comes from `EXEC_AUTH_SECRET`
  (your secret store), else a 0600 key file outside the repo, else memory.
* **Expiry:** idle timeout (default 15 min, slides on use) and an absolute lifetime (default 8 h).
* **Rotation:** after 5 min a request transparently receives a successor cookie; the old token survives a
  30 s grace period so in-flight requests do not fail. The successor keeps the old absolute expiry.
  The dashboard also renews every 4 min and retries once on `session_*`/`token_*` 401s.
* **Revocation:** `POST /api/auth/logout` (own session), `POST /api/auth/revoke` (operator: one token, one
  environment, or all). The engine boundary re-checks the session, so a revoke takes effect mid-flight.
* **Environment isolation:** a token is bound to one environment (prefix + stored column + separate cookie
  name). A paper token presented for testnet is rejected (`wrong_environment`). Paper orders live in the paper
  exchange tables, testnet orders in the execution engine tables, and the memory/learning tables carry the
  environment per trade.
* **Execution gate:** after authentication, `execution_gate()` signs a 30 s ticket bound to the environment
  and the exact order payload and verifies it right before the engine call.
* **CSRF:** cookie-authenticated writes must be same-origin (`Sec-Fetch-Site`/`Origin`), on top of `SameSite=Strict`.
* **Operator key** (`X-API-Key`) works as before for scripts and operator-only actions (account reset,
  MTM/reconcile runs, execution engine, backtest signal execution).
* **Local development:** with no `API_KEY` and `APP_ENV` in `development|test|local` the endpoints stay open,
  exactly as `require_api_key` already behaved. Any other `APP_ENV` fails closed, but still issues automatic
  paper sessions.

## Exchange testnet credentials

Loaded from environment secrets only (never generated, derived or substituted):

1. `BINANCE_TESTNET_API_KEY` + `BINANCE_TESTNET_SECRET_KEY`
2. `BINANCE_API_KEY` + `BINANCE_SECRET_KEY` — only while `BINANCE_TESTNET_ENABLED=true` **and**
   `BINANCE_LIVE_TRADING_ENABLED=false`, so a live key is never reinterpreted as a testnet key.

`GET /api/auth/status` verifies them against the sandbox through the execution adapter (which refuses
withdrawal-capable keys) and reports `valid | missing | invalid | unsafe_permissions | unverifiable` — never any
key material. With `EXECUTION_ENABLED=true` and `EXECUTION_VAULT_KEY` set, verified credentials are registered
as the `env-binance-testnet` execution account, **intelligence-only**: authentication is automatic, but the
operator still approves symbols, capital limits and mode through the execution policy.

If credentials are missing or invalid, the dashboard shows a `TESTNET_FALLBACK` notice and the paper API
runs INTERNAL PAPER. Nothing is ever labelled as a testnet execution unless the execution engine produced it.

> **Cloudflare note:** Worker secrets are only visible to the Worker. The Python backend reads environment
> variables, so put the exchange keys and `EXEC_AUTH_SECRET` in the backend host's secret store (Render/Fly/…)
> or inject them from Cloudflare into that host's environment. Never forward them to the browser.

## Endpoints

`POST /api/auth/session` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `GET /api/auth/status` ·
`POST /api/auth/revoke` (operator) · `GET /api/auth/events` (operator).
Paper: order-changing routes (`/orders`, `/orders/oco`, `/orders/{id}/cancel`, `/orders/cancel-all`,
`/flatten`, `/tick`) accept a session or the operator key; `/account/reset` is operator-only.

## Configuration

`EXEC_AUTH_SECRET`, `EXEC_AUTH_SECRET_PREVIOUS` (comma-separated, verify-only, for key rotation),
`EXEC_AUTH_KEY_FILE`, `EXEC_AUTO_SESSIONS` (default true), `EXEC_SESSION_IDLE_SECONDS` (900),
`EXEC_SESSION_ABSOLUTE_SECONDS` (28800), `EXEC_SESSION_ROTATE_SECONDS` (300),
`EXEC_SESSION_ROTATE_GRACE_SECONDS` (30), `EXEC_SESSION_MAX_ACTIVE` (500).

## Limits and honest caveats

* Automatic sessions are **not user accounts**: anyone who can load the dashboard can place paper orders on the
  shared paper account (simulated money). Set `EXEC_AUTO_SESSIONS=false` to require the operator key.
* The paper API has no per-session account isolation (single `default` account).
* Withdrawals and transfers do not exist in the code; a static test and a runtime path guard keep it that way.
* Not every operator action in the dashboard is paper-scoped; MTM/reconcile runs and account reset still need
  the operator key and will show a 401 message in the page.

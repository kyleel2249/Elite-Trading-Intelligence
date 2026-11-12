# ETI execution authorization

Three environments, three credential sets, three kinds of record. Nothing is shared between them.

| Environment | What it is | How it authenticates | Orders go to | Records |
|---|---|---|---|---|
| **INTERNAL PAPER** (`paper`) | ETI's own simulation. Fills at the live public price; no exchange or broker is contacted | automatic session (HttpOnly cookie `eti_paper`) | `POST /api/orders` with `broker:"eti_paper"`, and `/api/paper/*` | `exec:paper:rec:*` |
| **EXCHANGE TESTNET** (`testnet`) | Alpaca paper and Binance testnet, using **your** keys from Worker secrets | automatic session (cookie `eti_testnet`), issued only if the keys exist and are not rejected | `POST /api/orders` with `broker:"alpaca"` or `"binance"` | `order:*` |
| **LIVE** | Disabled in this build | never. `POST /api/orders/live` answers 423 `live_trading_disabled` (403 for a session); no live broker host or credential is referenced and `ETI_LIVE_TRADING_ENABLED` is ignored. No external risk gateway is involved anywhere | `POST /api/orders/live` (always refused) | none |

No withdrawal, transfer or funding endpoint exists. Requests to such paths return 404.

## How a browser gets authorised without typing anything
1. The dashboard calls `POST /api/auth/session {environment}`. The Worker checks the request is same-origin, rate-limits it, and creates a session record in KV.
2. The token (`eti1.<keyVersion>.<scope>.<sessionId>.<expiry>.<epoch>.<HMAC-SHA256>`) is sent **only** in `Set-Cookie: …; HttpOnly; Secure; SameSite=Strict`. It is not in any response body, bundle, header the page can read, `localStorage` or `sessionStorage`.
3. Every order is authenticated again on the server: signature (constant-time, against every live key), expiry, scope, KV session record, revocation epoch. Cookie-authenticated writes must also carry a matching `Origin` (CSRF).
4. Idle lifetime: 30 min paper, 15 min testnet. Absolute lifetime of a refresh chain: 12 h paper, 4 h testnet. The dashboard refreshes at half-life with `POST /api/auth/refresh`; the old token is revoked at once.

## Provisioning
- **Preferred:** `node scripts/provision-secrets.mjs --session-secret` generates 48 random bytes and pipes them into `wrangler secret put ETI_SESSION_SECRET`. The value is never printed or written to disk. `--execution-token` does the same for the master token. The script never touches exchange keys.
- **Zero-setup:** if `ETI_SESSION_SECRET` is unset, the Worker generates a random 256-bit key with `crypto.getRandomValues` and keeps it in the `ETI_EXECUTION_LOG` KV namespace. A Worker cannot create Cloudflare secrets for itself (that needs an API token with Workers write access, which should never be embedded), so KV is the automatic fallback. Anyone with access to your Cloudflare account can read KV; a Worker secret has the same exposure but is not listed alongside data. Use the script if that distinction matters to you.
- **Exchange keys:** `wrangler secret put ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `BINANCE_API_KEY`, `BINANCE_SECRET_KEY` (testnet/paper keys). ETI never generates, defaults or substitutes them.

## Rotation, expiry, revocation
- **Key rotation (KV-held key):** automatic after `ETI_KEY_ROTATION_DAYS` (default 7), or `POST /api/auth/rotate` with the master token. The previous key keeps validating unexpired sessions for the longest session life, then is dropped. The cron also runs this housekeeping.
- **Key rotation (secret-held key):** run the script with `--keep-previous OLD_VALUE_ENV`, or set `ETI_SESSION_SECRET_PREVIOUS` yourself, deploy, and remove the previous value after 12 h.
- **Revoke one session:** `POST /api/auth/revoke {environment}` from that browser. **Revoke everything:** master token, `{environment:"paper"|"testnet"|"all"}`: bumps an epoch so every session of that environment fails immediately.
- Expired session records disappear from KV by TTL.

## Fallback to INTERNAL PAPER
- If testnet keys are missing, or the testnet service rejects them (Alpaca 401/403; Binance 401 or codes −2014/−2015/−1022), no testnet session is issued and the dashboard shows a warning banner. An order placed after keys turn bad is filled in internal paper instead, and the response carries `fallback.reason`, `exchangeOrderPlaced:false` and a notice. Rejected keys are remembered for 10 minutes so ETI does not keep calling the exchange.
- A fallback order is never described as a testnet order. API clients using the master token keep strict behaviour (`503 broker_not_configured`) unless they send `fallbackToPaper:true`.
- Unreachable exchanges are **not** treated as bad keys: status shows `unverified` and orders return the upstream error.

## Endpoints
`GET /api/auth/status` (environments, credential status words, session expiry, signing-key version; no secrets), `POST /api/auth/session | refresh | revoke | rotate`, `GET /api/execution/history?environment=internal_paper|exchange_testnet|live` (a session sees only its own environments), `GET /api/execution/status`.

## Settings
`ETI_AUTO_SESSIONS` = `off` (manual master token only) | `paper` (automatic internal paper; testnet falls back) | `paper_testnet` (default). `ETI_KEY_ROTATION_DAYS`, `ETI_SESSION_SECRET`, `ETI_SESSION_SECRET_PREVIOUS`, `ETI_MAX_ORDER_QUANTITY`, `ETI_KILL_SWITCH` (blocks every order path).

## What this does **not** do (read this)
- **An automatic session is not a login.** It removes typing, not trust: anyone who can load the dashboard from a browser can obtain a paper or testnet session. That is the trade-off the "no manual token" requirement implies. Contain it with **Cloudflare Access in front of the Worker, and disable the `*.workers.dev` route**, otherwise Access is bypassable. Mitigations in code: same-origin issuance, IP rate limits, per-session order rate limit, quantity cap, kill switch, short lifetimes, strict scope separation, audit references. KV counters are eventually consistent, so limits are approximate.
- Testnet sessions let a visitor spend **your testnet balance**. Set `ETI_AUTO_SESSIONS=paper` if you do not want that.
- Internal paper fills are single fill records (price ± half the cost model, marketable limits only). Strategy-driven paper positions with stops live in `/api/paper/*`.
- Alpha execution (`/api/alpha/execute`), futures (`/api/futures/*`) and the Global Alpha admin routes keep their own master-token authentication; they are not opened to sessions.
- Live broker keys (`*_LIVE_*`) are untouched and still never auto-loaded by a session path.
- Not verified against live exchanges from the build sandbox (no outbound network); the exchange calls are tested against stubs.

## Tests
`worker/auth.test.ts` (22 tests): provisioning, cookie flags, same-origin, authentication and tampering, validation, expiry, refresh and absolute limit, revocation, key rotation and retirement, environment isolation (scopes, cookies, records, paper API), live lockout, testnet success, missing/invalid-credential fallback, master-token behaviour, leak scan of responses and stored records, rate limits, dashboard script checks, provisioning script.

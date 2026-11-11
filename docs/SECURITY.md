# Security

## Principles
- Never commit `.env` or real API keys. Secrets come only from Worker secrets or environment variables.
- No withdrawal or transfer permission is requested from any exchange; none is implemented.
- **Trading credentials, privileged API calls and execution authorisation never reach browser JavaScript.** Exchange keys exist only as Worker secrets. The browser holds only HttpOnly cookies it cannot read; no response body contains a token, key or credential (tests assert this).
- Live trading has no session path at all. It needs the master token, the live activation secret and the Worker live switch.
- RiskEngine keeps absolute veto authority; data freshness gates apply where configured.

## Accounts, roles and MFA (`worker/identity/`)
Needs the `ETI_PORTFOLIO_DB` D1 database (strong consistency for sessions, lockout and the audit chain) and the `ETI_IDENTITY_KEY` secret. Without both, accounts are reported as unavailable; nothing is simulated.

| Role | Grants | MFA | Session idle / absolute |
|---|---|---|---|
| viewer | market data | optional | 30 min / 12 h |
| analyst | + research, read portfolio | optional | 30 min / 12 h |
| paper_trader | + internal paper orders, manage portfolio | optional | 30 min / 12 h |
| trader | + exchange-testnet orders | **required** | 15 min / 4 h |
| admin | + users, audit, backup, key rotation | **required** | 15 min / 4 h |

- A trader or admin who has not enrolled MFA receives a *limited* session: identified, but no scopes and no privileges, until TOTP enrolment completes.
- Passwords: PBKDF2-SHA256, 100 000 iterations (the Cloudflare Workers maximum) over an HMAC pepper from `ETI_IDENTITY_KEY`, so a database leak alone cannot be cracked offline. Length policy of 12+, common-password and email-name checks. Hashes upgrade transparently on sign-in after a key rotation.
- MFA: TOTP (RFC 6238, verified against the RFC test vectors), replay-protected, seeds sealed with AES-256-GCM, 10 single-use HMAC-hashed recovery codes shown once.
- Sessions: opaque random tokens, only a hash stored, revocable, sliding idle window and an absolute cap. Role change, password change, MFA reset and disabling revoke sessions immediately. Cookie `eti_user` is `HttpOnly; Secure; SameSite=Strict`; mutating requests also require a same-origin `Origin`.
- Lockout: 5 failures, 15 minutes, doubling to 24 hours; login errors are identical for unknown users and wrong passwords; per-network rate limit.
- Guards: the last active administrator cannot be demoted or disabled; nobody can disable or change their own role.
- Audit trail: an append-only SHA-256 hash chain (`id_audit`), `UNIQUE(prev_hash)` so concurrent writers cannot fork it. `GET /api/identity/audit/verify` recomputes it and names the first broken record. Records hold references and event types, never secrets or raw IPs.
- Break-glass: the master `ETI_EXECUTION_TOKEN` creates the first administrator (`POST /api/identity/bootstrap` with `Authorization: Bearer`), and can restore backups. Treat it as a root credential.

### First-time setup
1. `openssl rand -base64 48`, then `npx wrangler secret put ETI_IDENTITY_KEY`.
2. Deploy (the D1 database is provisioned automatically, see `docs/PORTFOLIO.md`).
3. `curl -X POST https://<worker>/api/identity/bootstrap -H "Authorization: Bearer $ETI_EXECUTION_TOKEN" -H "content-type: application/json" -d '{"email":"you@example.com","password":"<12+ chars>"}'`
4. Open `/account`, sign in, enrol your authenticator, store the recovery codes offline.
5. Optional: set `ETI_AUTO_SESSIONS=off` so that only signed-in accounts (or the master token) can obtain execution scopes.

### Rotating `ETI_IDENTITY_KEY`
Put the old value in `ETI_IDENTITY_KEY_PREVIOUS`, set the new value in `ETI_IDENTITY_KEY`, deploy. Old hashes, sealed seeds and backups keep working; password hashes are re-hashed as users sign in. Remove the previous key after everyone has signed in once and you have taken a fresh backup.

## Browser protections (`worker/security/headers.ts`)
Every HTML response gets a per-response nonce on each inline script and style and a CSP of `default-src 'self'`, `script-src 'self' 'nonce-…'` (no `unsafe-inline`, no `unsafe-eval`), `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`; `connect-src` allows only same-origin and the Binance market-data stream. Add origins with `ETI_CSP_CONNECT`. All responses also carry `nosniff`, `Referrer-Policy: no-referrer`, a locked-down `Permissions-Policy` and HSTS. Pages that ship their own CSP keep it. A test fetches every page and verifies every inline block is nonced and no inline event handlers exist.

## Transport and WebSockets
The Worker is HTTPS-only behind Cloudflare. The browser's only WebSocket is the public Binance market-data stream (read-only, no credentials). The dashboard's own realtime updates use authenticated, same-origin polling. Authenticated server push (private WebSocket) is not implemented in the Worker; the Python `app/streaming` manager is a separate component.

## Rate limiting and input validation
Fixed-window limits (KV) on sign-in, MFA confirmation, session issue/refresh, portfolio actions, provider probing and backup. Every request body is parsed defensively and validated (types, lengths, enumerations, numeric ranges); SQL always uses bound parameters.

## Backup and recovery
- `GET /api/backup/export` (master token or MFA administrator): ledger, accounts and audit trail as one AES-256-GCM file under `ETI_IDENTITY_KEY`; sessions are excluded. Use it on a schedule from a trusted machine, for example `curl -H "Authorization: Bearer $TOKEN" .../api/backup/export -o eti-$(date +%F).etibak`.
- `POST /api/backup/restore` writes only into an **empty** database after checking the key, a checksum and the audit chain. It will not overwrite or merge with live data.
- For rolling a live database back, use Cloudflare D1 Time Travel (`npx wrangler d1 time-travel restore eti-portfolio-db --timestamp=<ISO time>`), which covers the last 30 days.
- Test a restore into a scratch database before you rely on it.

## Database access controls
D1 is reachable only through the Worker binding; there is no public connection string. Identity tables are touched only by `worker/identity/` and the backup module. Principle of least privilege for exchange keys: create them without withdrawal rights and, where the exchange allows, IP-restrict them.

## Data providers
`/providers` and `/api/providers/status` show per-provider state, last good response, latency and a coverage matrix. Providers are never assumed equivalent; see `docs/ARCHITECTURE_CONFORMANCE.md`.

## Reporting
Report vulnerabilities privately to the repository owner rather than in a public issue.

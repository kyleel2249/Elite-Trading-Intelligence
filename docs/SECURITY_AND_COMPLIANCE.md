# Security & compliance

Code: `app/governance/*`, API `/api/security/*` (`app/api/governance.py`), page `/security`, migration `0014_governance`,
tests `tests/test_governance.py` (36). Everything below is implemented and covered by tests unless marked otherwise.

## Controls

| Requirement | Implementation | Notes |
|---|---|---|
| Strong RBAC | 8 server-assigned roles (`viewer, auditor, trader, operator, treasurer, approver, security_admin, admin`) mapped to named permissions in `rbac.PERMISSIONS`. Identity = `X-API-Key` (platform `API_KEY` -> `master`, or a per-principal key). Roles can never be self-declared; denials and failed auth are audited. | Per-principal keys are shown once and stored only as an HMAC. Production with no `API_KEY` returns 503 (fail closed). |
| MFA for privileged actions | TOTP (RFC 6238, tested with the RFC vectors), replay-proof, 5-strike 15-minute lockout, 8 single-use recovery codes, seed stored only as Fernet ciphertext. Privileged permissions (`rbac.PRIVILEGED`) need a fresh `X-MFA-Code`. | Enforced by default outside local/test; `GOV_MFA_REQUIRED` overrides. |
| Multi-signature treasury | `approvals.py`: m-of-n (never below 2), requester cannot vote, one vote per principal, any rejection vetoes, expiry, digest bound to the exact action and parameters, atomic single use. The chain gate binds an approval to the sealed quote (network, destination, value, calldata hash, quote id). | The shared platform key counts as ONE signer; create per-person principals for real multi-party control. |
| Immutable audit | `gov_audit`: append-only (ORM guards + SQLite/PostgreSQL triggers incl. TRUNCATE), HMAC hash chain with key id, verify endpoint, head hash for external anchoring, credential-looking fields scrubbed. | Anchor `GET /api/security/audit/head` somewhere you do not control to also detect tail truncation by a DB superuser. |
| Encryption at rest | TOTP seeds, wallet keys and broker credentials are Fernet-sealed in the app (`GOVERNANCE_KEY`/`EXECUTION_VAULT_KEY`), keys kept out of the DB; backups are AES-256-GCM. | Volume-level encryption of the database is provider-side and **cannot be verified from the app**; posture reports it as `unverified`. |
| Encryption in transit | HTTPS enforcement (308 redirect when `X-Forwarded-Proto: http`), HSTS, nosniff, frame deny, `no-store` + restrictive CSP on `/api/*`; posture flags plain-HTTP RPC URLs and Postgres without `sslmode`. | TLS terminates at Cloudflare/Render; on by default outside local/test (`GOV_ENFORCE_HTTPS`). |
| Secrets management | Derived subkeys per purpose, `GOVERNANCE_KEY_PREVIOUS` rotation (old audit rows and ciphertexts stay valid), `reseal`, log/audit scrubbing, secret scanner (`python -m app.governance.secretscan`, also a test over the whole repo). | Rotation of `EXECUTION_VAULT_KEY` for the wallet is a separate vault operation (not automated here). |
| Withdrawal allowlists | Propose -> m-of-n approval -> activate -> cooling-off (`GOV_ALLOWLIST_COOLDOWN_HOURS`, default 24) -> usable. EIP-55 validated, instant revoke. Mainnet transfers to non-usable destinations are refused. | Layered on top of the existing chain allowlist. |
| Transaction limits | Per-role, per-network per-tx and rolling-24h caps (`gov_limits`, fallback `role/*`, `*/network`, `*/*`), optional "no approval at or below" threshold; split transfers are caught by the ledger-based 24h sum. | Amounts are base units (wei). |
| Fraud detection | Explainable scoring: new destination, fresh allowlist entry, velocity, rapid repeat, many payees (probing), amount anomaly vs median, auth-failure bursts, off-hours. `review` demands one extra signature, `block` refuses; alerts are stored and resolvable; account-takeover sweep endpoint. | Rule-based, no ML; thresholds via env (`GOV_FRAUD_*`). |
| Disaster recovery | See `docs/DISASTER_RECOVERY.md`. | |

## The send gate
`ChainService.send` -> `gate.enforce_send` runs **before any key is used**: fraud score -> role limits -> withdrawal allowlist (mainnet transfers) -> approval for this exact quote (mainnet). Testnets are exempt from allowlist/approval unless `GOV_ENFORCE_TESTNET=true` but are still scored and logged. The gate is **on in every non-local environment** and opt-in locally (`GOVERNANCE_ENFORCE=true`). A refused send does not burn an approval; an approval is spent only when the gate passes.
Both `/api/chain/send` and `/api/security/chain/send` enforce RBAC + MFA first.

## Operating it
1. Set `API_KEY`, `GOVERNANCE_KEY` (random 32+ chars, separate from the API key) and `EXECUTION_VAULT_KEY`.
2. As `master`: `POST /api/security/mfa/enroll` then `/mfa/confirm`; store the recovery codes offline.
3. Create per-person principals (`POST /api/security/principals`): at least two `approver`/`treasurer`.
4. Set limits (`PUT /api/security/limits`), propose and approve destinations, then send with `approval_id`.
5. Check `GET /api/security/posture` and `GET /api/security/audit/verify` regularly.

## Not covered / honest limits
- Compliance *certification* (SOC 2, ISO 27001, PCI) is an organisational process; these are technical controls that support it, not a certificate.
- Nothing was exercised against a real PostgreSQL instance here (SQLite only); the PostgreSQL trigger DDL is written but unrun.
- Per-IP rate limiting of failed API-key attempts is not implemented (failures are audited and feed fraud scoring).
- HTTPS enforcement and HSTS depend on the proxy setting `X-Forwarded-Proto`.

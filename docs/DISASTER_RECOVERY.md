# Disaster recovery (governance state)

Scope: principals (hashed keys, sealed MFA seeds), the audit chain, approvals/votes, allowlist, limits, fraud alerts.
Wallet keys and broker credentials live in their own vault tables and are covered by your database backups plus `EXECUTION_VAULT_KEY`.

**Backup** - `POST /api/security/dr/backup {passphrase}` (security_admin/admin + MFA) returns an envelope: PBKDF2-HMAC-SHA256
(>= 600,000 iterations) -> AES-256-GCM, header authenticated as AAD. The passphrase (14+ chars) is never stored; losing it makes the backup unrecoverable.
**Verify** - `POST /dr/verify` (or offline `GOV_BACKUP_PASSPHRASE=... python -m app.governance.dr verify backup.json`) decrypts and re-verifies counts, audit head and the whole hash chain.
**Drill** - `POST /dr/drill` proves recoverability now and records `dr.drill`; posture warns if no backup in 7 days / no drill in 30 days.
**Restore** - into an *empty* governance schema only (never merges/overwrites; the audit chain is verified before anything is written):
`GOV_BACKUP_PASSPHRASE=... python -m app.governance.dr restore backup.json` (operator shell access is the authority on a fresh database; the API route works too once authenticated and the schema is empty).

Keep separately and offline: `GOVERNANCE_KEY` (and `GOVERNANCE_KEY_PREVIOUS` if rotating), `EXECUTION_VAULT_KEY`, the backup passphrase, MFA recovery codes.
Suggested objectives (set your own): RPO <= 24h (daily backup), RTO <= 1h (restore + key re-provision), drill monthly.

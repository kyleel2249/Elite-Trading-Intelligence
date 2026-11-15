# Corporate wallets

Five purpose-separated wallets: **Trading**, **Corporate treasury**, **Operational expenses**, **Emergency reserves**, **Long-term investments**. Page: `/wallets`. API: `/api/wallets/*` (`worker/wallets/`).

## What ETI does and does not hold

ETI **never holds, generates, receives or stores a wallet private key, seed phrase or passphrase**. Keys live with a custodian that has hardware-backed or managed signing (HSM, MPC provider, cloud KMS, or an exchange). ETI holds only:

- the wallet configuration (policy, custody *reference*, whitelist), signers' **public** WebAuthn keys, approval records (public signatures) and ledger bookkeeping;
- the **public** half of the recovery key.

Controls that keep secrets out of D1, KV, browser storage, frontend JS, GitHub and logs:

| Place | Control |
|---|---|
| API input | Every request body is scanned; anything that looks like a seed phrase, private key, WIF/xprv, PEM key, recovery share or labelled passphrase is refused with `422 secret_material_rejected`, never echoed, stored or logged (`worker/wallets/redact.ts`). The data model also has no field that could hold one. |
| Logs and audit | Audit details pass through `redact()`. No `console.*` calls exist in wallet code (tested). |
| D1 / KV | Wallet events are public-key and policy data. A test asserts the event log and read model contain no secret-shaped values. |
| Browser | The page uses no browser storage; approvals are signed by the security key. A test checks this. |
| GitHub | `repo-scan.test.ts` fails the build if key material is committed; secrets are Worker secrets only (`.dev.vars.example` has blanks). |

The seed-phrase detector is a heuristic (no BIP-39 word list is bundled). It is a safety net; the real control is that no feature ever asks for those values.

## Wallets, floors and policy

| Wallet | Requested by | Min approvals | Min timelock | Min address cooldown | Default limits (USDT) |
|---|---|---|---|---|---|
| Trading | trader+ | 1 (2 above 1,000) | 0 | 1 h | 5,000 / tx, 20,000 / day |
| Operational expenses | trader+ | 1 (2 above 500) | 0 | 1 h | 2,000 / tx, 5,000 / day |
| Corporate treasury | admin | **2** | 1 h | 24 h | 25,000 / tx, 50,000 / day |
| Emergency reserves | admin | **2** | 24 h | 24 h | 100,000 |
| Long-term investments | admin | **2** | 24 h | 24 h | 50,000 |

Policies can be raised but never lowered below the floors above (`validatePolicy`, enforced on setup and on every policy-change action). Assets are deny-by-default: only assets listed in a wallet's policy can move, each with decimals, per-transaction and 24-hour limits (queued requests count against the daily limit) and size-based approval tiers.

## Multi-signature authorization

- Approvals are **WebAuthn (FIDO2) signatures with user verification** from signers' security keys. The signed challenge is the SHA-256 digest of the canonical action (kind, wallet, amount, destination, requester, expiry, threshold, timelock). The page recomputes that digest from the action it shows before asking for the signature, so a compromised server cannot obtain a signature for a different action than the one displayed.
- **The requester can never approve** their own action. Signers are scoped to wallets. One approval per person. Approvals from signers removed after approving stop counting; if that drops the count below quorum, the timelock restarts when quorum returns.
- Treasury, emergency and long-term withdrawals need at least 2 approvals plus the timelock. Signers can **cancel** any pending action, and any signer, administrator or the master token can **freeze** everything instantly; unfreezing needs a multi-signature action.
- At execution everything is re-checked: counted approvals are re-verified cryptographically against the digest, limits, whitelist (with cooldown), freeze, and that the policy has not been tightened since. An execution is **claimed exactly once** with an atomic primary-key insert (D1; external execution is refused on KV-only storage).
- Withdrawals go only to **whitelisted addresses**; adding one is itself a multi-signature action followed by a cooldown. Internal transfers are between ledger wallets and honor each wallet's inbound rules (e.g. only treasury may fund emergency).

## Custody and execution

| Custody | Meaning |
|---|---|
| `ledger` | Internal bookkeeping only (no on-chain keys). Deposits are recorded by multi-signature action; internal transfers move book balances. Cannot send externally. |
| `external_signer` | HTTPS signing gateway (HSM / MPC / KMS) at `ETI_SIGNER_URL`. ETI posts the approved action (including the signed approvals) with an HMAC; the gateway should verify the approvals itself, treat `idempotencyKey` as unique, sign and broadcast. |
| `binance` | Binance `capital/withdraw/apply` with a withdraw-only, IP-restricted key (`BINANCE_WITHDRAW_*`). Also enable Binance's own address whitelist. |

**External execution is off** until `ETI_WALLET_EXECUTION=enabled`; until then everything can be created, approved and reviewed, and nothing can be sent. Outcomes: *submitted*; *rejected* (definite, retried up to 3 times); *unknown* (timeout / 5xx: the transfer may exist, so it is **never retried automatically**; an administrator resolves it after checking the custodian, with a reference, audited).

## Setup, sealing and signers

1. Administrators configure custody/policy and designate signers (at least 3, distinct users, every wallet needs `approvals + 1` scoped signers).
2. Each signer signs in with MFA and registers a security key on `/wallets`. Synced passkeys are refused by default (device-bound keys only); optionally restrict to approved hardware models with `ETI_WALLET_AAGUIDS`. Note: with attestation "none" ETI cannot prove a key is hardware; use the AAGUID list and procurement control.
3. Run the offline recovery ceremony and register the public key.
4. **Seal.** From then on every change (signers, policy, custody, whitelist, recovery key, unfreeze) is a multi-signature action with a governance timelock (`ETI_WALLET_GOV_TIMELOCK_SEC`, default 24 h) and quorum `max(2, floor(n/2)+1)`.

## Encrypted backups, rotation and recovery

**Recovery key ceremony (offline):** `node scripts/wallet-recover.mjs init --k 3 --n 5 --out ./ceremony` creates an ECDH P-256 key, writes `public-key.json` (register this) and splits the private scalar into Shamir shares (`share-N.txt`, mode 0600) for separate custodians. ETI can never decrypt its own backups. Distribute shares, delete the folder.

**Backup:** administrators download `GET /api/wallets/backup` (audited, rate-limited). The file is AES-256-GCM encrypted to the recovery public key (ephemeral ECDH + HKDF), the header authenticated as AAD, and HMAC-signed with the identity key so a substituted file is rejected. Take one after every sealed configuration change; store copies off-platform.

**Restore:** `node scripts/wallet-recover.mjs decrypt --backup f.etibak --share s1 --share s3 --share s4 --out bundle.json` (offline), then `POST /api/wallets/recovery/restore` with the bundle (administrator, **empty wallet store only**). It is accepted only if the MAC verifies and the events match the MAC-protected hash. Wallet keys themselves are recovered by the custodian's own procedure; this backup restores ETI's authorization state.

**Rotation:**

| Item | Procedure |
|---|---|
| Recovery key | New offline ceremony, then a `recovery_rotate` action (multi-sig); take a fresh backup. Destroy old shares after the new backup is verified. |
| Signer key / person | `signer_remove` the old signer, `signer_add` + enrol the replacement (cannot go below 3 active signers). A lost key is handled the same way. |
| Identity / backup MAC key | `ETI_IDENTITY_KEY` with `ETI_IDENTITY_KEY_PREVIOUS` (see SECURITY.md); backups verify under either. |
| Signing gateway secret | Set the new `ETI_SIGNER_SECRET`, have the gateway accept old and new, then retire the old. |
| Custody keys | Rotated inside the HSM/MPC/KMS or exchange, outside ETI. |

**If signers are lost:** with fewer than the quorum available, wallets cannot move (by design). Recovery is: restore ETI state from backup into a fresh deployment with new administrators (3 shares), designate and enrol new signers, then re-register custody; moving funds still requires the custodian's own recovery procedure.

## Not verified

Written and tested against software WebAuthn authenticators and mocked gateways. **Not verified live:** a real HSM/MPC gateway, Binance withdrawals, physical security keys on a deployed origin, Cloudflare. Address checks are format-only (no checksum). Do not enable execution until you have run the full flow on testnet amounts with your custodian.

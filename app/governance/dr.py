"""Disaster recovery for the governance state: encrypted backups, verified restore, and a recovery drill.

A backup is a JSON envelope: PBKDF2-HMAC-SHA256 (>= 600,000 iterations, random salt) derives an AES-256-GCM key from an
operator passphrase; the header (version, time, counts, audit head) is authenticated as AAD. The passphrase is never stored
or logged - lose it and the backup is unrecoverable, which is the point. Restore first decrypts and re-verifies the whole
audit hash chain *before* touching the database, and only restores into an empty governance schema (it never merges or
overwrites). Sealed secrets inside (TOTP seeds) stay Fernet-ciphertext, so GOVERNANCE_KEY must be backed up separately and
offline. Offline check without the server:  python -m app.governance.dr verify backup.json
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.governance import audit, keys
from app.governance.models import (GovAllowEntry, GovApproval, GovApprovalVote, GovAudit, GovFraudAlert, GovLimit, GovPrincipal)

MIN_ITER = 600_000
MIN_PASSPHRASE = 14
TABLES = [GovPrincipal, GovAudit, GovApproval, GovApprovalVote, GovAllowEntry, GovLimit, GovFraudAlert]


class DRError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def iterations() -> int:
    if keys.is_local():     # tests may lower the cost; production always uses the floor or higher
        try:
            return max(1000, int(os.getenv("GOV_BACKUP_KDF_ITER", MIN_ITER)))
        except ValueError:
            pass
    return MIN_ITER


def _b(x: bytes) -> str:
    return base64.b64encode(x).decode()


def _kdf(passphrase: str, salt: bytes, iters: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, iters, 32)


def _check_pass(p: str) -> None:
    if not isinstance(p, str) or len(p) < MIN_PASSPHRASE:
        raise DRError(f"passphrase must be at least {MIN_PASSPHRASE} characters", 422)


def _row(obj) -> dict[str, Any]:
    out = {}
    for c in inspect(obj.__class__).columns:
        v = getattr(obj, c.key)
        out[c.key] = v.isoformat() if isinstance(v, datetime) else v
    return out


def snapshot(db: Session) -> dict[str, Any]:
    return {m.__tablename__: [_row(o) for o in db.execute(select(m)).scalars()] for m in TABLES}


def _aad(meta: dict) -> bytes:
    return json.dumps(meta, sort_keys=True, separators=(",", ":")).encode()


def backup(db: Session, passphrase: str, actor: str) -> dict:
    _check_pass(passphrase)
    audit.append(db, actor, "dr.backup", "governance", {"tables": [m.__tablename__ for m in TABLES]})   # recorded first so it is inside the backup
    data = snapshot(db)
    h = audit.head(db)
    meta = {"v": 1, "created": datetime.now(timezone.utc).isoformat(), "audit_head": h["hash"], "audit_seq": h["seq"],
            "counts": {k: len(v) for k, v in data.items()}, "kdf": "pbkdf2-sha256", "iter": iterations(), "cipher": "aes-256-gcm"}
    salt, nonce = os.urandom(16), os.urandom(12)
    ct = AESGCM(_kdf(passphrase, salt, meta["iter"])).encrypt(nonce, json.dumps(data, default=str).encode(), _aad(meta))
    return {"meta": meta, "salt": _b(salt), "nonce": _b(nonce), "ciphertext": _b(ct)}


def open_backup(envelope: dict, passphrase: str) -> tuple[dict, dict]:
    try:
        meta = envelope["meta"]
        if meta.get("v") != 1 or meta.get("kdf") != "pbkdf2-sha256" or int(meta["iter"]) < 1000:
            raise DRError("unsupported backup format", 422)
        key = _kdf(passphrase, base64.b64decode(envelope["salt"]), int(meta["iter"]))
        plain = AESGCM(key).decrypt(base64.b64decode(envelope["nonce"]), base64.b64decode(envelope["ciphertext"]), _aad(meta))
    except (KeyError, ValueError, TypeError):
        raise DRError("malformed backup envelope", 422)
    except InvalidTag:
        raise DRError("wrong passphrase or the backup was modified", 403)
    data = json.loads(plain)
    return meta, data


def verify(envelope: dict, passphrase: str) -> dict:
    """Decrypt and fully verify a backup without touching the database."""
    meta, data = open_backup(envelope, passphrase)
    rows = data.get("gov_audit", [])
    chain = audit.verify_rows(rows)
    counts_ok = all(len(data.get(k, [])) == n for k, n in meta["counts"].items())
    head_ok = (rows[-1]["hash"] if rows else audit.GENESIS) == meta["audit_head"]
    return {"ok": bool(chain["ok"] and counts_ok and head_ok), "audit_chain": chain, "counts_match": counts_ok, "head_matches": head_ok,
            "counts": meta["counts"], "created": meta["created"], "iterations": meta["iter"]}


def restore(db: Session, envelope: dict, passphrase: str, actor: str) -> dict:
    rep = verify(envelope, passphrase)
    if not rep["ok"]:
        raise DRError("backup failed verification; nothing was restored: " + json.dumps({k: rep[k] for k in ("audit_chain", "counts_match", "head_matches")}), 422)
    builtin = [p for p in db.execute(select(GovPrincipal)).scalars() if p.name in ("master", "local") and not p.totp_enrolled and not p.key_hash]
    for m in TABLES:
        existing = db.execute(select(m)).scalars().all()
        if m is GovPrincipal:
            existing = [p for p in existing if p not in builtin]       # bootstrap rows are recreated from the backup
        if existing:
            raise DRError(f"refusing to restore: {m.__tablename__} is not empty (restore targets an empty governance schema only)", 409)
    _, data = open_backup(envelope, passphrase)
    for p in builtin:
        db.delete(p)
    db.flush()
    for m in TABLES:
        cols = {c.key: c for c in inspect(m).columns}
        for r in data.get(m.__tablename__, []):
            vals = {k: (datetime.fromisoformat(v) if v and "DateTime" in type(cols[k].type).__name__ else v) for k, v in r.items() if k in cols}
            db.add(m(**vals))
    db.commit()
    audit.append(db, actor, "dr.restored", "governance", {"counts": rep["counts"], "backup_created": rep["created"]})
    return {"restored": True, **rep}


def drill(db: Session, passphrase: str, actor: str) -> dict:
    """Prove recoverability now: take a backup, decrypt it, verify chain + counts, and record the drill."""
    env = backup(db, passphrase, actor)
    rep = verify(env, passphrase)
    audit.append(db, actor, "dr.drill", "governance", {"ok": rep["ok"], "counts": rep["counts"]})
    return {"ok": rep["ok"], "report": rep, "backup_bytes": len(json.dumps(env)),
            "note": "The drill backup was not stored; download a real one via POST /api/security/dr/backup."}


if __name__ == "__main__":        # offline: python -m app.governance.dr verify|restore backup.json   (passphrase: GOV_BACKUP_PASSPHRASE)
    if len(sys.argv) != 3 or sys.argv[1] not in ("verify", "restore"):
        sys.exit("usage: python -m app.governance.dr verify|restore <backup.json>   (passphrase from GOV_BACKUP_PASSPHRASE)")
    env_, pw = json.load(open(sys.argv[2])), os.environ["GOV_BACKUP_PASSPHRASE"]
    if sys.argv[1] == "verify":
        print(json.dumps(verify(env_, pw), indent=2))
    else:                                   # disaster recovery into a fresh database: operator shell access is the authority
        from app.database import SessionLocal, init_db
        init_db()
        with SessionLocal() as s:
            print(json.dumps(restore(s, env_, pw, "operator-cli"), indent=2))

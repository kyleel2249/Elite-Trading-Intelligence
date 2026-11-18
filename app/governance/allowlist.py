"""Withdrawal allowlist with approval and a cooling-off period.

Adding a destination is a three-step control: (1) a privileged principal proposes it (entry is `pending`); (2) it needs an
m-of-n approval whose digest covers network + address; (3) once the approval is consumed the entry is `cooling` and becomes
usable only after GOV_ALLOWLIST_COOLDOWN_HOURS (default 24), which gives operators time to notice a hijacked proposal.
Removal is immediate (the safe direction). Addresses are normalised (EVM: EIP-55 validated) so lookalikes cannot collide.
"""
from __future__ import annotations

import os
import re
from datetime import timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chain.crypto import is_address, to_checksum
from app.chain.networks import NETWORKS
from app.governance import approvals, audit
from app.governance.models import GovAllowEntry, now

_OTHER_ADDR = re.compile(r"^[A-Za-z0-9]{26,90}$")


class AllowlistError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def cooldown() -> timedelta:
    try:
        return timedelta(hours=max(0.0, float(os.getenv("GOV_ALLOWLIST_COOLDOWN_HOURS", "24"))))
    except ValueError:
        return timedelta(hours=24)


def normalise(network: str, address: str) -> str:
    address = (address or "").strip()
    if network in NETWORKS or network == "*":
        if not is_address(address):
            raise AllowlistError("invalid EVM address (a mixed-case address must carry a valid EIP-55 checksum)", 422)
        return to_checksum(address)
    if network in ("bitcoin", "solana") and _OTHER_ADDR.match(address):
        return address
    raise AllowlistError(f"unsupported network {network!r}", 422)


def approval_params(network: str, address: str) -> dict:
    return {"network": network, "address": normalise(network, address)}


def propose(db: Session, network: str, address: str, label: Optional[str], by: str) -> tuple[GovAllowEntry, "approvals.GovApproval"]:
    addr = normalise(network, address)
    entry = db.execute(select(GovAllowEntry).where(GovAllowEntry.network == network, GovAllowEntry.address == addr)).scalar_one_or_none()
    if entry and entry.status in ("pending", "cooling"):
        raise AllowlistError(f"destination is already {entry.status}", 409)
    if entry is None:
        entry = GovAllowEntry(network=network, address=addr, created_by=by)
        db.add(entry)
    entry.label, entry.status, entry.created_by, entry.created_at, entry.activates_at = (label or "")[:64] or None, "pending", by, now(), None
    db.commit()
    appr = approvals.request(db, "allowlist.add", {"network": network, "address": addr}, by, reason=f"allowlist {network} {addr}")
    entry.approval_id = appr.id
    db.commit()
    audit.append(db, by, "allowlist.proposed", f"{network}:{addr}", {"approval_id": appr.id, "label": label})
    return entry, appr


def activate(db: Session, entry_id: int, approval_id: int, by: str) -> GovAllowEntry:
    entry = db.get(GovAllowEntry, entry_id)
    if entry is None:
        raise AllowlistError("allowlist entry not found", 404)
    if entry.status != "pending":
        raise AllowlistError(f"entry is {entry.status}, not pending", 409)
    approvals.consume(db, approval_id, "allowlist.add", {"network": entry.network, "address": entry.address}, by)
    entry.status, entry.activates_at = "cooling", now() + cooldown()
    db.commit()
    audit.append(db, by, "allowlist.activated", f"{entry.network}:{entry.address}", {"usable_from": entry.activates_at.isoformat()})
    return entry


def revoke(db: Session, entry_id: int, by: str) -> GovAllowEntry:
    entry = db.get(GovAllowEntry, entry_id)
    if entry is None:
        raise AllowlistError("allowlist entry not found", 404)
    entry.status = "revoked"
    db.commit()
    audit.append(db, by, "allowlist.revoked", f"{entry.network}:{entry.address}")
    return entry


def lookup(db: Session, network: str, address: str) -> Optional[GovAllowEntry]:
    try:
        addr = normalise(network, address)
    except AllowlistError:
        return None
    for net in (network, "*"):
        e = db.execute(select(GovAllowEntry).where(GovAllowEntry.network == net, GovAllowEntry.address == addr)).scalar_one_or_none()
        if e and e.status == "cooling":
            return e
    return None


def check(db: Session, network: str, address: str) -> tuple[bool, str]:
    e = lookup(db, network, address)
    if e is None:
        return False, "destination is not on the approved withdrawal allowlist"
    if e.activates_at and e.activates_at > now():
        return False, f"destination is still in its cooling-off period until {e.activates_at.isoformat()}Z"
    return True, "ok"


def as_dict(e: GovAllowEntry) -> dict:
    usable = e.status == "cooling" and bool(e.activates_at and e.activates_at <= now())
    return {"id": e.id, "network": e.network, "address": e.address, "label": e.label, "status": e.status, "usable": usable,
            "created_by": e.created_by, "approval_id": e.approval_id, "created_at": e.created_at.isoformat(),
            "activates_at": e.activates_at.isoformat() if e.activates_at else None}


def listing(db: Session) -> list[dict]:
    return [as_dict(e) for e in db.execute(select(GovAllowEntry).order_by(GovAllowEntry.id.desc())).scalars()]

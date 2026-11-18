"""Broker (treasury) wallet integration.

The broker's wallet is an address the operator supplies in CHAIN_BROKER_ADDRESS. ETI NEVER holds its key and cannot pull
from it: the broker sends capital to the ETI wallet, and ETI verifies that transfer on-chain before counting it. Fees owed
to the broker accrue on confirmed trades and are paid to that address through the normal preview -> policy -> SEND flow.
The broker address comes only from the environment (there is no API to change it), so a leaked API key cannot redirect fees.
"""
from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.chain.broker_models import ChainFee, ChainFunding
from app.chain.crypto import is_address, to_checksum
from app.chain.models import ChainTransaction
from app.chain.networks import NETWORKS, Network, rpc_url
from app.chain.policy import fmt_units
from app.chain.rpc import RpcError
from app.chain.service import ChainError, ChainService

MAX_FEE_BPS = 500            # hard ceiling: 5%
_HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class BrokerConfig:
    address: Optional[str]
    invalid_address: bool
    name: str
    fee_bps: int
    target_wei: int
    confirmations: int


def load_config() -> BrokerConfig:
    raw = os.getenv("CHAIN_BROKER_ADDRESS", "").strip()
    addr = to_checksum(raw) if raw and is_address(raw) else None
    try:
        bps = int(os.getenv("CHAIN_BROKER_FEE_BPS", "0"))
    except ValueError:
        bps = 0
    try:
        d = Decimal(os.getenv("CHAIN_BROKER_TARGET_FUNDING", "0") or "0")
        target = int(d * Decimal(10) ** 18) if d > 0 else 0
    except Exception:
        target = 0
    try:
        conf = int(os.getenv("CHAIN_FUNDING_CONFIRMATIONS", "3"))
    except ValueError:
        conf = 3
    return BrokerConfig(address=addr, invalid_address=bool(raw and not addr), name=(os.getenv("CHAIN_BROKER_NAME") or "Broker")[:64],
                        fee_bps=max(0, min(bps, MAX_FEE_BPS)), target_wei=target, confirmations=max(1, min(conf, 64)))


def fee_for(notional_wei: int, bps: int) -> int:
    return notional_wei * bps // 10000


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class BrokerService:
    def __init__(self, db, settings=None):
        self.db = db
        self.chain = ChainService(db, settings)

    def _cfg(self, need_address: bool = True) -> BrokerConfig:
        cfg = load_config()
        if need_address and not cfg.address:
            raise ChainError("No valid broker wallet is configured (set CHAIN_BROKER_ADDRESS to a checksummed 0x address)", 503)
        return cfg

    # ------------------------------------------------------------------ funding (broker -> ETI wallet)
    async def record_funding(self, network: str, tx_hash: str) -> dict[str, Any]:
        """Verify on-chain that the broker wallet sent native coin to the ETI wallet, then count it as allocated capital."""
        cfg = self._cfg()
        if not _HASH.match(tx_hash or ""):
            raise ChainError("tx_hash must be a 0x-prefixed 32-byte hash", 422)
        net = self.chain._net(network)
        w = self.chain._wallet_or_error()
        th = tx_hash.lower()
        if self.db.execute(select(ChainFunding).where(ChainFunding.tx_hash == th)).scalar_one_or_none():
            raise ChainError("this funding transaction is already recorded", 409)
        rpc = await self.chain._checked_rpc(net)
        try:
            tx = await rpc.get_tx(th)
            if not tx:
                raise ChainError("transaction not found on this network", 404)
            rc = await rpc.receipt(th)
            if not rc:
                raise ChainError("transaction is not mined yet; try again after it confirms", 409)
            head = await rpc.block_number()
        except RpcError as e:
            raise ChainError(f"RPC error: {e}", 502)
        if rc.get("status") != "0x1":
            raise ChainError("that transaction reverted; it moved no funds", 422)
        if (tx.get("from") or "").lower() != cfg.address.lower():
            raise ChainError("sender is not the configured broker wallet", 403)
        if (tx.get("to") or "").lower() != w.address.lower():
            raise ChainError("recipient is not the ETI wallet", 403)
        value = int(tx.get("value", "0x0"), 16)
        if value <= 0:
            raise ChainError("no native value was transferred", 422)
        block = int(rc["blockNumber"], 16)
        conf = head - block + 1
        if conf < cfg.confirmations:
            raise ChainError(f"only {conf} confirmation(s); {cfg.confirmations} required", 409)
        row = ChainFunding(network=net.key, tx_hash=th, from_address=cfg.address, to_address=w.address, value_wei=str(value), block_number=block, confirmations=conf)
        self.db.add(row)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            raise ChainError("this funding transaction is already recorded", 409)
        self.chain.event("funding_recorded", network=net.key, tx_hash=th, detail={"value_wei": str(value), "from": cfg.address})
        return self._funding_dict(row, net)

    @staticmethod
    def _funding_dict(r: ChainFunding, net: Optional[Network]) -> dict[str, Any]:
        return {"id": r.id, "network": r.network, "tx_hash": r.tx_hash, "from": r.from_address, "to": r.to_address, "value_wei": r.value_wei,
                "value": fmt_units(int(r.value_wei)), "native": net.native if net else None, "block": r.block_number,
                "confirmations": r.confirmations, "recorded_at": r.recorded_at.isoformat() + "Z",
                "explorer_url": f"{net.explorer}/tx/{r.tx_hash}" if net else None}

    def funding_list(self) -> list[dict[str, Any]]:
        rows = self.db.execute(select(ChainFunding).order_by(ChainFunding.id.desc())).scalars().all()
        return [self._funding_dict(r, NETWORKS.get(r.network)) for r in rows]

    # ------------------------------------------------------------------ fees (ETI -> broker wallet)
    def reconcile(self) -> None:
        """Settling fees become paid when their payment confirms, and return to accrued if it failed."""
        for f in self.db.execute(select(ChainFee).where(ChainFee.status == "settling")).scalars().all():
            tx = self.db.get(ChainTransaction, f.paid_tx_id) if f.paid_tx_id else None
            if tx is None or tx.status in ("failed", "broadcast_failed"):
                f.status, f.paid_tx_id = "accrued", None
            elif tx.status == "confirmed":
                f.status, f.paid_at = "paid", _now()
        self.db.commit()

    def accrue_fees(self) -> int:
        """Create a fee row for every CONFIRMED swap that has none (idempotent). Fees accrue on trades only."""
        cfg = load_config()
        created = 0
        if cfg.address and cfg.fee_bps > 0:
            have = {r for (r,) in self.db.execute(select(ChainFee.source_tx_id)).all()}
            swaps = self.db.execute(select(ChainTransaction).where(ChainTransaction.kind == "swap", ChainTransaction.status == "confirmed")).scalars().all()
            for tx in swaps:
                fee = fee_for(int(tx.notional_wei), cfg.fee_bps)
                if tx.id in have or fee <= 0:
                    continue
                self.db.add(ChainFee(network=tx.network, source_tx_id=tx.id, notional_wei=tx.notional_wei, fee_bps=cfg.fee_bps, fee_wei=str(fee), status="accrued"))
                created += 1
            if created:
                self.db.commit()
        self.reconcile()
        return created

    def _fee_rows(self, status: Optional[str] = None, network: Optional[str] = None) -> list[ChainFee]:
        q = select(ChainFee).order_by(ChainFee.id)
        if status:
            q = q.where(ChainFee.status == status)
        if network:
            q = q.where(ChainFee.network == network)
        return list(self.db.execute(q).scalars().all())

    def fees(self) -> dict[str, Any]:
        self.accrue_fees()
        rows = self._fee_rows()
        totals: dict[str, dict[str, int]] = {}
        for r in rows:
            t = totals.setdefault(r.network, {"accrued": 0, "settling": 0, "paid": 0})
            t[r.status] += int(r.fee_wei)
        cfg = load_config()
        return {"fee_bps": cfg.fee_bps, "fee_rule": f"{cfg.fee_bps / 100:.2f}% of each confirmed trade's native-coin notional" if cfg.fee_bps else "no fee configured (CHAIN_BROKER_FEE_BPS=0)",
                "totals": {k: {s: fmt_units(v) for s, v in t.items()} for k, t in totals.items()},
                "fees": [{"id": r.id, "network": r.network, "source_tx_id": r.source_tx_id, "notional": fmt_units(int(r.notional_wei)), "fee_bps": r.fee_bps,
                          "fee": fmt_units(int(r.fee_wei)), "fee_wei": r.fee_wei, "status": r.status, "paid_tx_id": r.paid_tx_id,
                          "created_at": r.created_at.isoformat() + "Z"} for r in reversed(rows)]}

    async def preview_fee_settlement(self, network: str) -> dict[str, Any]:
        cfg = self._cfg()
        net = self.chain._net(network)
        self.accrue_fees()
        rows = self._fee_rows("accrued", net.key)
        total = sum(int(r.fee_wei) for r in rows)
        if total <= 0:
            raise ChainError("no accrued fees to settle on this network", 409)
        self.chain.allow_add(network="*", address=cfg.address, kind="destination", label=f"{cfg.name} wallet (CHAIN_BROKER_ADDRESS)")
        prep = await self.chain.preview_transfer(net.key, cfg.address, fmt_units(total))
        prep["summary"] = f"Pay accrued fees {fmt_units(total)} {net.native} to the broker wallet {cfg.address[:6]}\u2026{cfg.address[-4:]} on {net.label}"
        prep["fee_settlement"] = {"fee_ids": [r.id for r in rows], "total_wei": str(total), "broker": cfg.address}
        return prep

    async def send_fee_settlement(self, quote_id: str, confirm: str) -> dict[str, Any]:
        cfg = self._cfg()
        q = self.chain._unseal(quote_id)
        if q.get("kind") != "transfer" or str(q.get("to", "")).lower() != cfg.address.lower():
            raise ChainError("this quote is not a payment to the broker wallet", 400)
        tx = await self.chain.send(quote_id, confirm)
        budget, picked = int(tx["value_wei"]), []
        for r in self._fee_rows("accrued", tx["network"]):          # FIFO: only whole fee rows the payment fully covers
            if int(r.fee_wei) <= budget:
                budget -= int(r.fee_wei)
                picked.append(r)
        for r in picked:
            r.status, r.paid_tx_id = "settling", tx["id"]
        self.db.commit()
        self.chain.event("fees_settling", network=tx["network"], tx_hash=tx["tx_hash"], detail={"fee_ids": [r.id for r in picked]})
        return {"transaction": tx, "fees_linked": len(picked)}

    # ------------------------------------------------------------------ status
    def _db_totals(self, net_key: str, broker: Optional[str]) -> dict[str, int]:
        funded = sum(int(r.value_wei) for r in self.db.execute(select(ChainFunding).where(ChainFunding.network == net_key)).scalars())
        fee_tx_ids = {r.paid_tx_id for r in self._fee_rows(network=net_key) if r.paid_tx_id and r.status in ("settling", "paid")}
        returned = 0
        if broker:
            for t in self.db.execute(select(ChainTransaction).where(ChainTransaction.network == net_key, ChainTransaction.kind == "transfer",
                                                                    ChainTransaction.status == "confirmed")).scalars():
                if t.to_address.lower() == broker.lower() and t.id not in fee_tx_ids:
                    returned += int(t.value_wei)
        fees = {s: sum(int(r.fee_wei) for r in self._fee_rows(s, net_key)) for s in ("accrued", "settling", "paid")}
        return {"funded": funded, "returned": returned, **fees}

    async def _net_status(self, net: Network, cfg: BrokerConfig, wallet) -> dict[str, Any]:
        t = self._db_totals(net.key, cfg.address)
        row: dict[str, Any] = {"network": net.key, "label": net.label, "native": net.native, "mainnet": net.mainnet, "connected": False,
                               "funded": fmt_units(t["funded"]), "returned": fmt_units(t["returned"]), "net_allocated": fmt_units(max(0, t["funded"] - t["returned"])),
                               "fees_accrued": fmt_units(t["accrued"]), "fees_settling": fmt_units(t["settling"]), "fees_paid": fmt_units(t["paid"])}
        try:
            rpc = await asyncio.wait_for(self.chain._checked_rpc(net), timeout=15)
            row["connected"] = True
            if cfg.address:
                row["broker_balance"] = fmt_units(await asyncio.wait_for(rpc.get_balance(cfg.address), timeout=10))
            if wallet:
                eti = await asyncio.wait_for(rpc.get_balance(wallet.address), timeout=10)
                row["eti_balance"] = fmt_units(eti)
                if cfg.target_wei > 0:
                    row["funded_ratio"] = round(eti / cfg.target_wei, 4)
        except ChainError as e:
            row["error"] = e.message
        except (RpcError, asyncio.TimeoutError) as e:
            row["error"] = str(e) or "timeout"
        return row

    async def status(self) -> dict[str, Any]:
        cfg = load_config()
        self.accrue_fees()
        w = self.chain.wallet()
        nets = await asyncio.gather(*[self._net_status(n, cfg, w) for n in NETWORKS.values() if rpc_url(n.key)])
        notes = []
        if cfg.invalid_address:
            notes.append("CHAIN_BROKER_ADDRESS is set but is not a valid address (checksum errors count); it is being ignored.")
        if not cfg.address:
            notes.append("No broker wallet configured: set CHAIN_BROKER_ADDRESS. ETI cannot create or hold the broker's funds.")
        if not w:
            notes.append("ETI has no wallet yet: create it on the ETI Wallet page, then ask the broker to fund its address.")
        return {"configured": bool(cfg.address), "broker": {"name": cfg.name, "address": cfg.address}, "eti_wallet": w.address if w else None,
                "fee_bps": cfg.fee_bps, "max_fee_bps": MAX_FEE_BPS, "target_funding": fmt_units(cfg.target_wei) if cfg.target_wei else None,
                "funding_confirmations": cfg.confirmations, "networks": nets, "notes": notes,
                "model": "Capital is provided by the broker (they send it to the ETI wallet and the transfer is verified on-chain). ETI trades with that balance, "
                         "under the spending policy. No margin or borrowing is used."}

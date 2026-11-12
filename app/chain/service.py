"""ETI wallet service: create the wallet, read chain state, preview and send transfers and DEX swaps under policy.

Every spend is two-step: a *preview* runs the policy and returns an HMAC-signed single-use quote; *send* verifies the
quote, re-runs the policy, signs with the vault-decrypted key and broadcasts. Nothing is reported as confirmed until a
receipt says so.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chain import policy as policy_mod
from app.chain.crypto import address_from_private, generate_private_key, is_address, to_checksum
from app.chain.models import ChainAllowlist, ChainEvent, ChainTransaction, ChainWallet
from app.chain.networks import NETWORKS, Network, dex_config, load_limits, rpc_url
from app.chain.policy import fmt_units, to_units
from app.chain.rpc import Rpc, RpcError
from app.chain.txcodec import (decode_address, decode_string, decode_uint, decode_uint_array, encode_call, sign_1559,
                               sign_legacy)
from app.config import get_settings
from app.execution.vault import CredentialVault, VaultError

logger = logging.getLogger("eti.chain")
QUOTE_TTL_SECONDS = 120
_SEND_LOCK = asyncio.Lock()
EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"


class ChainError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def make_rpc(network_key: str) -> Rpc:
    url = rpc_url(network_key)
    if not url:
        raise ChainError(f"No RPC endpoint configured for {network_key} (set CHAIN_RPC_{network_key.upper().replace('-', '_')})", 503)
    return Rpc(url)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _short(a: str) -> str:
    return a[:6] + "\u2026" + a[-4:]


def _hexdata(b: bytes) -> str:
    return "0x" + b.hex()


class ChainService:
    def __init__(self, db: Session, settings=None):
        self.db = db
        self.settings = settings or get_settings()

    # ------------------------------------------------------------------ wallet
    def _vault(self) -> CredentialVault:
        key = os.getenv("EXECUTION_VAULT_KEY") or getattr(self.settings, "execution_vault_key", None)
        try:
            return CredentialVault(key)
        except VaultError as e:
            raise ChainError(f"Wallet key storage unavailable: {e}", 503)

    def wallet(self) -> Optional[ChainWallet]:
        return self.db.execute(select(ChainWallet).order_by(ChainWallet.id)).scalars().first()

    def _wallet_or_error(self) -> ChainWallet:
        w = self.wallet()
        if not w:
            raise ChainError("ETI has no wallet yet: create one first", 409)
        return w

    def _private_key(self, w: ChainWallet) -> int:
        try:
            return int(self._vault().open(w.key_ciphertext)["private_key"], 16)
        except (VaultError, KeyError, ValueError):
            raise ChainError("Wallet key could not be decrypted with the configured vault key", 503)

    def event(self, event: str, network: Optional[str] = None, tx_hash: Optional[str] = None, detail: Optional[dict] = None) -> None:
        self.db.add(ChainEvent(event=event, network=network, tx_hash=tx_hash, detail=detail))
        self.db.commit()

    def create_wallet(self, label: str = "ETI wallet") -> ChainWallet:
        vault = self._vault()                                  # fail before generating anything
        if self.wallet():
            raise ChainError("A wallet already exists; ETI owns exactly one address", 409)
        priv = generate_private_key()
        w = ChainWallet(address=address_from_private(priv), key_ciphertext=vault.seal({"private_key": f"{priv:064x}"}), label=label[:64])
        self.db.add(w)
        self.db.commit()
        del priv
        self.event("wallet_created", detail={"address": w.address})
        return w

    @staticmethod
    def wallet_dict(w: ChainWallet) -> dict[str, Any]:
        return {"address": w.address, "label": w.label, "created_at": w.created_at.isoformat() + "Z"}

    # ------------------------------------------------------------------ allowlist
    @staticmethod
    def _net(key: str) -> Network:
        n = NETWORKS.get(key)
        if not n:
            raise ChainError(f"unknown network {key!r}; supported: {', '.join(NETWORKS)}", 422)
        return n

    def allow_row(self, network: str, address: str, kind: str) -> Optional[ChainAllowlist]:
        rows = self.db.execute(select(ChainAllowlist).where(ChainAllowlist.kind == kind)).scalars().all()
        return next((r for r in rows if r.address.lower() == address.lower() and r.network in (network, "*")), None)

    def allow_add(self, *, network: str, address: str, kind: str, label: Optional[str] = None, symbol: Optional[str] = None,
                  decimals: Optional[int] = None) -> ChainAllowlist:
        if network != "*":
            self._net(network)
        if not is_address(address):
            raise ChainError("invalid address (a mixed-case address must carry a valid EIP-55 checksum)", 422)
        addr = to_checksum(address)
        existing = self.db.execute(select(ChainAllowlist).where(ChainAllowlist.network == network, ChainAllowlist.address == addr,
                                                                ChainAllowlist.kind == kind)).scalar_one_or_none()
        if existing:
            return existing
        row = ChainAllowlist(network=network, address=addr, kind=kind, label=label, symbol=symbol, decimals=decimals)
        self.db.add(row)
        self.db.commit()
        self.event("allowlist_add", network=None if network == "*" else network, detail={"address": addr, "kind": kind, "label": label})
        return row

    def allow_remove(self, row_id: int) -> None:
        row = self.db.get(ChainAllowlist, row_id)
        if not row:
            raise ChainError("allowlist entry not found", 404)
        detail = {"address": row.address, "kind": row.kind}
        self.db.delete(row)
        self.db.commit()
        self.event("allowlist_remove", detail=detail)

    def allow_list(self) -> list[dict[str, Any]]:
        rows = self.db.execute(select(ChainAllowlist).order_by(ChainAllowlist.id)).scalars().all()
        return [{"id": r.id, "network": r.network, "address": r.address, "kind": r.kind, "label": r.label, "symbol": r.symbol,
                 "decimals": r.decimals} for r in rows]

    # ------------------------------------------------------------------ chain reads
    async def _checked_rpc(self, net: Network) -> Rpc:
        rpc = make_rpc(net.key)
        try:
            cid = await rpc.chain_id()
        except RpcError as e:
            raise ChainError(f"{net.label}: RPC unreachable ({e})", 502)
        if cid != net.chain_id:
            raise ChainError(f"{net.label}: RPC reports chain id {cid}, expected {net.chain_id}; refusing to use it", 502)
        return rpc

    async def network_status(self, net: Network) -> dict[str, Any]:
        out: dict[str, Any] = {"network": net.key, "label": net.label, "chain_id": net.chain_id, "native": net.native,
                               "mainnet": net.mainnet, "explorer": net.explorer, "configured": bool(rpc_url(net.key)), "connected": False}
        if not out["configured"]:
            out["note"] = f"set CHAIN_RPC_{net.key.upper().replace('-', '_')} to enable"
            return out
        try:
            rpc = await asyncio.wait_for(self._checked_rpc(net), timeout=15)
            out["connected"] = True
            out["block"] = await asyncio.wait_for(rpc.block_number(), timeout=10)
            fee = await asyncio.wait_for(rpc.fee_data(), timeout=10)
            out["gas_price_gwei"] = float(fee["gas_price"]) / 1e9
            w = self.wallet()
            if w:
                bal = await asyncio.wait_for(rpc.get_balance(w.address), timeout=10)
                out["balance_wei"], out["balance"] = str(bal), fmt_units(bal)
        except ChainError as e:
            out["error"] = e.message
        except (RpcError, asyncio.TimeoutError) as e:
            out["error"] = str(e) or "timeout"
        return out

    async def token_balances(self, net: Network) -> list[dict[str, Any]]:
        w = self._wallet_or_error()
        rpc = await self._checked_rpc(net)
        out = []
        for r in self.db.execute(select(ChainAllowlist).where(ChainAllowlist.kind == "token")).scalars():
            if r.network not in (net.key, "*"):
                continue
            try:
                raw = decode_uint(await rpc.call(r.address, _hexdata(encode_call("balanceOf(address)", [w.address]))))
                out.append({"token": r.address, "symbol": r.symbol, "decimals": r.decimals or 18, "balance_raw": str(raw),
                            "balance": fmt_units(raw, r.decimals or 18)})
            except (RpcError, ValueError) as e:
                out.append({"token": r.address, "symbol": r.symbol, "error": str(e)})
        return out

    # ------------------------------------------------------------------ quotes
    def _secret(self) -> bytes:
        return str(self.settings.secret_key).encode()

    def _seal(self, payload: dict) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
        return f"{raw}.{hmac.new(self._secret(), raw.encode(), hashlib.sha256).hexdigest()}"

    def _unseal(self, quote_id: str) -> dict:
        try:
            raw, sig = quote_id.rsplit(".", 1)
            if not hmac.compare_digest(sig, hmac.new(self._secret(), raw.encode(), hashlib.sha256).hexdigest()):
                raise ValueError
            payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        except Exception:
            raise ChainError("quote is invalid or was altered", 400)
        if payload.get("exp", 0) < time.time():
            raise ChainError("quote expired: preview again", 400)
        return payload

    def _sent_today(self, network: str) -> int:
        cut = _now() - timedelta(days=1)
        rows = self.db.execute(select(ChainTransaction).where(ChainTransaction.network == network, ChainTransaction.created_at >= cut,
                                                              ChainTransaction.status.in_(["signed", "pending", "confirmed"]))).scalars()
        return sum(int(r.notional_wei) for r in rows)

    def _violations(self, net: Network, *, kind: str, notional: int, to: Optional[str], extra: dict) -> list[str]:
        w = self._wallet_or_error()
        return policy_mod.violations(network=net, limits=load_limits(), kill_switch=bool(self.settings.kill_switch), kind=kind,
                                     notional_wei=notional, sent_today_wei=self._sent_today(net.key), to=to, wallet=w.address, **extra)

    async def _prepare(self, net: Network, *, kind: str, to: str, value: int, data: bytes, notional: int, summary: str,
                       extra: Optional[dict] = None, skip_estimate: bool = False, extra_violations: Optional[list] = None) -> dict[str, Any]:
        w = self._wallet_or_error()
        rpc = await self._checked_rpc(net)
        try:
            fee = await rpc.fee_data()
            if skip_estimate:
                gas = 250000
            else:
                try:
                    gas = max(21000, int(await rpc.estimate_gas(w.address, to, value, _hexdata(data)) * 1.2))
                except RpcError as e:
                    raise ChainError(f"Gas estimation failed, the transaction would likely revert: {e}", 422)
            balance = await rpc.get_balance(w.address)
        except RpcError as e:
            raise ChainError(f"RPC error: {e}", 502)
        if fee["base_fee"] is not None:
            prio = int(fee["priority"] or 10 ** 9)
            fees = {"type": 2, "max_priority_fee": prio, "max_fee": 2 * int(fee["base_fee"]) + prio}
            unit = fees["max_fee"]
        else:
            fees = {"type": 0, "gas_price": int(fee["gas_price"])}
            unit = fees["gas_price"]
        max_cost = gas * unit
        v = self._violations(net, kind=kind, notional=notional, to=to, extra=extra or {}) + list(extra_violations or [])
        if value + max_cost > balance:
            v.append(f"insufficient balance: need up to {fmt_units(value + max_cost)} {net.native}, have {fmt_units(balance)}")
        prep: dict[str, Any] = {"network": net.key, "label": net.label, "mainnet": net.mainnet, "kind": kind, "from": w.address, "to": to,
                                "value_wei": str(value), "data": _hexdata(data), "gas": gas, "fees": fees, "max_fee_cost_wei": str(max_cost),
                                "max_fee_cost": fmt_units(max_cost), "notional_wei": str(notional), "summary": summary, "violations": v,
                                "allowed": not v, "explorer": net.explorer, "native": net.native}
        if not v:
            exp = int(time.time()) + QUOTE_TTL_SECONDS
            prep["expires_at"] = datetime.fromtimestamp(exp, timezone.utc).isoformat()
            prep["quote_id"] = self._seal({"qid": secrets.token_hex(12), "exp": exp, "network": net.key, "kind": kind, "to": to, "value": str(value),
                                           "data": _hexdata(data), "gas": gas, "fees": fees, "notional": str(notional), "summary": summary,
                                           "extra": extra or {}})
        return prep

    # ------------------------------------------------------------------ previews
    async def preview_transfer(self, network: str, to: str, amount: str) -> dict[str, Any]:
        net = self._net(network)
        if not is_address(to):
            raise ChainError("invalid destination address", 422)
        try:
            value = to_units(amount)
        except ValueError as e:
            raise ChainError(str(e), 422)
        return await self._prepare(net, kind="transfer", to=to_checksum(to), value=value, data=b"", notional=value,
                                   summary=f"Send {amount} {net.native} to {_short(to)} on {net.label}",
                                   extra={"destination_allowed": self.allow_row(net.key, to, "destination") is not None})

    def _dex(self, net: Network) -> tuple[str, str]:
        router, wrapped = dex_config(net.key)
        if not (router and wrapped and is_address(router) and is_address(wrapped)):
            raise ChainError(f"DEX not configured for {net.label}: set CHAIN_DEX_ROUTER_* and CHAIN_WRAPPED_NATIVE_* (verified addresses)", 503)
        return to_checksum(router), to_checksum(wrapped)

    async def preview_swap(self, network: str, side: str, token: str, amount: str, slippage_bps: int) -> dict[str, Any]:
        net = self._net(network)
        router, wrapped = self._dex(net)
        if side not in ("buy", "sell") or not is_address(token):
            raise ChainError("side must be buy|sell and token a valid address", 422)
        token = to_checksum(token)
        row = self.allow_row(net.key, token, "token")
        decimals = (row.decimals if row and row.decimals is not None else 18)
        w = self._wallet_or_error()
        rpc = await self._checked_rpc(net)
        deadline = int(time.time()) + 1200
        extra = {"token_allowed": row is not None, "slippage_bps": slippage_bps, "router_configured": True}
        try:
            if side == "buy":
                amount_in = to_units(amount)
                path = [wrapped, token]
                out = decode_uint_array(await rpc.call(router, _hexdata(encode_call("getAmountsOut(uint256,address[])", [amount_in, path]))))[-1]
                min_out = out * (10000 - slippage_bps) // 10000
                data = encode_call("swapExactETHForTokens(uint256,address[],address,uint256)", [min_out, path, w.address, deadline])
                prep = await self._prepare(net, kind="swap", to=router, value=amount_in, data=data, notional=amount_in, extra=extra,
                                           summary=f"Buy {fmt_units(out, decimals)} {(row.symbol if row else 'token')} (min {fmt_units(min_out, decimals)}) with {amount} {net.native}")
            else:
                amount_in = to_units(amount, decimals)
                path = [token, wrapped]
                out = decode_uint_array(await rpc.call(router, _hexdata(encode_call("getAmountsOut(uint256,address[])", [amount_in, path]))))[-1]
                min_out = out * (10000 - slippage_bps) // 10000
                bal = decode_uint(await rpc.call(token, _hexdata(encode_call("balanceOf(address)", [w.address]))))
                allowance = decode_uint(await rpc.call(token, _hexdata(encode_call("allowance(address,address)", [w.address, router]))))
                ev = []
                if bal < amount_in:
                    ev.append("token balance is lower than the amount to sell")
                needs_approval = allowance < amount_in
                if needs_approval:
                    ev.append("router allowance is too low: submit the exact-amount approval first and wait for it to confirm")
                data = encode_call("swapExactTokensForETH(uint256,uint256,address[],address,uint256)", [amount_in, min_out, path, w.address, deadline]) \
                    if False else b""
                data = self._sell_calldata(amount_in, min_out, path, w.address, deadline)
                prep = await self._prepare(net, kind="swap", to=router, value=0, data=data, notional=out, extra=extra, skip_estimate=needs_approval,
                                           extra_violations=ev, summary=f"Sell {amount} {(row.symbol if row else 'token')} for about {fmt_units(out)} {net.native} (min {fmt_units(min_out)})")
                prep["needs_approval"] = needs_approval
        except (RpcError, ValueError) as e:
            raise ChainError(f"DEX quote failed: {e}", 502)
        prep.update({"expected_out_wei": str(out), "min_out_wei": str(min_out), "slippage_bps": slippage_bps, "token": token, "router": router,
                     "warning": "Quotes come from the router's current pool state; MEV, price impact and token taxes are not modelled."})
        return prep

    @staticmethod
    def _sell_calldata(amount_in: int, min_out: int, path: list[str], to: str, deadline: int) -> bytes:
        from app.chain.txcodec import enc_address, enc_uint, selector
        sig = "swapExactTokensForETH(uint256,uint256,address[],address,uint256)"
        head = enc_uint(amount_in) + enc_uint(min_out) + enc_uint(32 * 5) + enc_address(to) + enc_uint(deadline)
        tail = enc_uint(len(path)) + b"".join(enc_address(p) for p in path)
        return selector(sig) + head + tail

    async def preview_approval(self, network: str, token: str, amount: str) -> dict[str, Any]:
        net = self._net(network)
        router, _ = self._dex(net)
        if not is_address(token):
            raise ChainError("invalid token address", 422)
        token = to_checksum(token)
        row = self.allow_row(net.key, token, "token")
        decimals = row.decimals if row and row.decimals is not None else 18
        try:
            raw = to_units(amount, decimals)
        except ValueError as e:
            raise ChainError(str(e), 422)
        data = encode_call("approve(address,uint256)", [router, raw])
        return await self._prepare(net, kind="approve", to=token, value=0, data=data, notional=0, extra={"token_allowed": row is not None, "router_configured": True},
                                   summary=f"Approve the router to spend exactly {amount} {(row.symbol if row else 'token')} (no unlimited approval)")

    # ------------------------------------------------------------------ send
    async def send(self, quote_id: str, confirm: str) -> dict[str, Any]:
        if confirm != "SEND":
            raise ChainError('confirmation must be the exact word "SEND"', 400)
        q = self._unseal(quote_id)
        net = self._net(q["network"])
        w = self._wallet_or_error()
        if self.db.execute(select(ChainTransaction).where(ChainTransaction.quote_id == q["qid"])).scalar_one_or_none():
            raise ChainError("this quote was already used", 409)
        async with _SEND_LOCK:
            v = self._violations(net, kind=q["kind"], notional=int(q["notional"]), to=q["to"], extra=q.get("extra") or {})
            if v:
                raise ChainError("policy no longer allows this: " + "; ".join(v), 403)
            rpc = await self._checked_rpc(net)
            try:
                nonce = await rpc.nonce(w.address)
            except RpcError as e:
                raise ChainError(f"RPC error: {e}", 502)
            priv = self._private_key(w)
            data = bytes.fromhex(q["data"][2:])
            fees = q["fees"]
            if fees["type"] == 2:
                signed = sign_1559(priv, chain_id=net.chain_id, nonce=nonce, max_priority_fee=fees["max_priority_fee"], max_fee=fees["max_fee"],
                                   gas=q["gas"], to=q["to"], value=int(q["value"]), data=data)
            else:
                signed = sign_legacy(priv, chain_id=net.chain_id, nonce=nonce, gas_price=fees["gas_price"], gas=q["gas"], to=q["to"],
                                     value=int(q["value"]), data=data)
            del priv
            tx_hash = "0x" + signed["hash"].hex()
            row = ChainTransaction(quote_id=q["qid"], wallet_address=w.address, network=net.key, kind=q["kind"], to_address=q["to"], value_wei=q["value"],
                                   notional_wei=q["notional"], data_hex=q["data"], nonce=nonce, gas_limit=q["gas"], tx_hash=tx_hash, status="signed",
                                   summary=q["summary"][:240], policy={"violations": [], "limits_checked": True})
            self.db.add(row)
            self.db.commit()
            self.event("tx_signed", network=net.key, tx_hash=tx_hash, detail={"kind": q["kind"], "to": q["to"], "value_wei": q["value"]})
            try:
                await rpc.send_raw("0x" + signed["raw"].hex())
            except RpcError as e:
                row.status, row.error, row.updated_at = "broadcast_failed", str(e)[:240], _now()
                self.db.commit()
                self.event("tx_broadcast_failed", network=net.key, tx_hash=tx_hash, detail={"error": str(e)[:200]})
                raise ChainError(f"Broadcast rejected by the node: {e}", 502)
            row.status, row.updated_at = "pending", _now()
            self.db.commit()
            self.event("tx_broadcast", network=net.key, tx_hash=tx_hash)
        return self.tx_dict(row)

    @staticmethod
    def tx_dict(r: ChainTransaction) -> dict[str, Any]:
        net = NETWORKS.get(r.network)
        return {"id": r.id, "network": r.network, "kind": r.kind, "to": r.to_address, "value_wei": r.value_wei, "value": fmt_units(int(r.value_wei)),
                "native": net.native if net else None, "nonce": r.nonce, "tx_hash": r.tx_hash, "status": r.status, "summary": r.summary, "error": r.error,
                "gas_used": r.gas_used, "block_number": r.block_number, "created_at": r.created_at.isoformat() + "Z",
                "explorer_url": f"{net.explorer}/tx/{r.tx_hash}" if net else None}

    def txs(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.execute(select(ChainTransaction).order_by(ChainTransaction.id.desc()).limit(limit)).scalars().all()
        return [self.tx_dict(r) for r in rows]

    async def refresh_tx(self, tx_id: int) -> dict[str, Any]:
        r = self.db.get(ChainTransaction, tx_id)
        if not r:
            raise ChainError("transaction not found", 404)
        if r.status in ("pending", "signed"):
            try:
                rc = await (await self._checked_rpc(self._net(r.network))).receipt(r.tx_hash)
            except RpcError as e:
                raise ChainError(f"RPC error: {e}", 502)
            if rc:
                r.status = "confirmed" if rc.get("status") == "0x1" else "failed"
                r.gas_used = int(rc["gasUsed"], 16) if rc.get("gasUsed") else None
                r.block_number = int(rc["blockNumber"], 16) if rc.get("blockNumber") else None
                r.updated_at = _now()
                self.db.commit()
                self.event("tx_" + r.status, network=r.network, tx_hash=r.tx_hash, detail={"block": r.block_number})
        return self.tx_dict(r)

    async def refresh_pending(self) -> list[dict[str, Any]]:
        ids = [r.id for r in self.db.execute(select(ChainTransaction).where(ChainTransaction.status == "pending")).scalars()]
        out = []
        for i in ids:
            try:
                out.append(await self.refresh_tx(i))
            except ChainError as e:
                out.append({"id": i, "error": e.message})
        return out

    # ------------------------------------------------------------------ blockchain intelligence (read-only)
    async def inspect_contract(self, network: str, address: str) -> dict[str, Any]:
        net = self._net(network)
        if not is_address(address):
            raise ChainError("invalid address", 422)
        rpc = await self._checked_rpc(net)
        ind: list[dict[str, str]] = []
        out: dict[str, Any] = {"network": net.key, "address": to_checksum(address), "indicators": ind}
        try:
            code = await rpc.get_code(address)
            size = max(0, (len(code) - 2) // 2)
            out["is_contract"], out["code_size_bytes"] = size > 0, size
            if size == 0:
                ind.append({"severity": "informational", "text": "No contract code at this address (an ordinary account or not yet deployed)."})
                return out
            async def read(sig: str, dec):
                try:
                    return dec(await rpc.call(address, _hexdata(encode_call(sig, []))))
                except (RpcError, ValueError):
                    return None
            out["name"], out["symbol"] = await read("name()", decode_string), await read("symbol()", decode_string)
            out["decimals"], out["total_supply"] = await read("decimals()", decode_uint), await read("totalSupply()", decode_uint)
            owner = await read("owner()", decode_address)
            out["owner"] = owner
            if owner is None:
                ind.append({"severity": "informational", "text": "No owner() function answered (not Ownable, or non-standard)."})
            elif int(owner, 16) == 0:
                ind.append({"severity": "informational", "text": "owner() is the zero address (ownership renounced)."})
            else:
                ind.append({"severity": "low", "text": f"Has an owner ({_short(owner)}): privileged functions may exist; read the source before trusting it."})
            slot = await rpc.get_storage(address, EIP1967_IMPL_SLOT)
            if slot and int(slot, 16) != 0:
                ind.append({"severity": "medium", "text": "EIP-1967 upgradeable proxy: the logic contract can be replaced by its admin."})
        except RpcError as e:
            raise ChainError(f"RPC error: {e}", 502)
        out["disclaimer"] = ("Indicators come from on-chain reads only. No honeypot/sell simulation and no source verification was done, so the "
                             "absence of an indicator is not a safety verdict and the presence of one is not proof of malice.")
        return out

    async def scan_blocks(self, network: str, count: int, threshold: str) -> dict[str, Any]:
        net = self._net(network)
        try:
            thr = to_units(threshold)
        except ValueError as e:
            raise ChainError(str(e), 422)
        count = max(1, min(count, 20))
        rpc = await self._checked_rpc(net)
        watch = {r.address.lower(): r for r in self.db.execute(select(ChainAllowlist).where(ChainAllowlist.kind == "watch")).scalars()
                 if r.network in (net.key, "*")}
        findings: list[dict[str, Any]] = []
        try:
            head = await rpc.block_number()
            for n in range(head - count + 1, head + 1):
                blk = await rpc.get_block(n, True)
                for tx in (blk or {}).get("transactions", []):
                    val = int(tx.get("value", "0x0"), 16)
                    frm, to = (tx.get("from") or "").lower(), (tx.get("to") or "").lower()
                    tags = []
                    if val >= thr:
                        tags.append("large_transfer")
                    if frm in watch or to in watch:
                        tags.append("watched_address")
                    if tags and len(findings) < 50:
                        findings.append({"block": n, "tx_hash": tx.get("hash"), "from": tx.get("from"), "to": tx.get("to"), "value_wei": str(val),
                                         "value": fmt_units(val), "tags": tags, "explorer_url": f"{net.explorer}/tx/{tx.get('hash')}"})
        except RpcError as e:
            raise ChainError(f"RPC error: {e}", 502)
        return {"network": net.key, "blocks_scanned": count, "head": head, "threshold": threshold, "native": net.native, "findings": findings,
                "note": "Native-coin transfers only. Token transfers and internal transactions are not decoded."}

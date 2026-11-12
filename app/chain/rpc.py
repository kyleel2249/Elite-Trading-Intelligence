"""Async JSON-RPC client for EVM nodes. RPC URLs often embed API keys, so URLs never appear in errors or responses."""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse

import httpx


class RpcError(Exception):
    pass


def host_label(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.hostname}" if p.hostname else "rpc"


def _int(x: Any) -> int:
    return int(x, 16)


class Rpc:
    def __init__(self, url: str, *, client: Optional[httpx.AsyncClient] = None, timeout: float = 15.0):
        self.url, self._client, self.timeout = url, client, timeout

    async def request(self, method: str, params: Optional[list] = None) -> Any:
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}
        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            resp = await client.post(self.url, json=body)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            raise RpcError(f"RPC transport failure ({type(e).__name__})") from None
        finally:
            if own:
                await client.aclose()
        if not isinstance(data, dict):
            raise RpcError("RPC returned a malformed response")
        if data.get("error"):
            raise RpcError(str((data["error"] or {}).get("message", "rpc error"))[:200])
        return data.get("result")

    async def chain_id(self) -> int:
        return _int(await self.request("eth_chainId"))

    async def block_number(self) -> int:
        return _int(await self.request("eth_blockNumber"))

    async def get_balance(self, address: str) -> int:
        return _int(await self.request("eth_getBalance", [address, "latest"]))

    async def nonce(self, address: str) -> int:
        return _int(await self.request("eth_getTransactionCount", [address, "pending"]))

    async def fee_data(self) -> dict[str, Optional[int]]:
        blk = await self.request("eth_getBlockByNumber", ["latest", False])
        base = _int(blk["baseFeePerGas"]) if isinstance(blk, dict) and blk.get("baseFeePerGas") else None
        try:
            prio = _int(await self.request("eth_maxPriorityFeePerGas"))
        except RpcError:
            prio = 10 ** 9
        return {"base_fee": base, "priority": prio, "gas_price": _int(await self.request("eth_gasPrice"))}

    async def estimate_gas(self, frm: str, to: Optional[str], value: int, data_hex: str) -> int:
        tx: dict[str, Any] = {"from": frm, "value": hex(value), "data": data_hex}
        if to:
            tx["to"] = to
        return _int(await self.request("eth_estimateGas", [tx]))

    async def send_raw(self, raw_hex: str) -> str:
        return await self.request("eth_sendRawTransaction", [raw_hex])

    async def receipt(self, tx_hash: str) -> Optional[dict]:
        return await self.request("eth_getTransactionReceipt", [tx_hash])

    async def call(self, to: str, data_hex: str) -> str:
        return await self.request("eth_call", [{"to": to, "data": data_hex}, "latest"])

    async def get_block(self, number: int, full: bool = True) -> Optional[dict]:
        return await self.request("eth_getBlockByNumber", [hex(number), full])

    async def get_code(self, address: str) -> str:
        return await self.request("eth_getCode", [address, "latest"])

    async def get_storage(self, address: str, slot: str) -> str:
        return await self.request("eth_getStorageAt", [address, slot, "latest"])

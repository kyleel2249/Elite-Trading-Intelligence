"""RLP, EVM transaction signing (legacy EIP-155 and EIP-1559) and ABI call encoding. Pure Python."""
from __future__ import annotations

from typing import Any

from app.chain.crypto import keccak256, sign


def _int_bytes(i: int) -> bytes:
    if i < 0:
        raise ValueError("negative integer")
    return b"" if i == 0 else i.to_bytes((i.bit_length() + 7) // 8, "big")


def _len_prefix(n: int, offset: int) -> bytes:
    if n < 56:
        return bytes([offset + n])
    lb = _int_bytes(n)
    return bytes([offset + 55 + len(lb)]) + lb


def rlp(x: Any) -> bytes:
    if isinstance(x, bool):
        raise TypeError("bool is not RLP-encodable")
    if isinstance(x, int):
        x = _int_bytes(x)
    if isinstance(x, (bytes, bytearray)):
        b = bytes(x)
        if len(b) == 1 and b[0] < 0x80:
            return b
        return _len_prefix(len(b), 0x80) + b
    if isinstance(x, (list, tuple)):
        body = b"".join(rlp(i) for i in x)
        return _len_prefix(len(body), 0xC0) + body
    raise TypeError(f"cannot RLP-encode {type(x).__name__}")


def _addr_bytes(to: str | None) -> bytes:
    return bytes.fromhex(to[2:]) if to else b""


def sign_legacy(priv: int, *, chain_id: int, nonce: int, gas_price: int, gas: int, to: str | None, value: int,
                data: bytes = b"") -> dict[str, Any]:
    base = [nonce, gas_price, gas, _addr_bytes(to), value, data]
    h = keccak256(rlp(base + [chain_id, 0, 0]))
    r, s, rec = sign(h, priv)
    v = rec + 35 + 2 * chain_id
    raw = rlp(base + [v, r, s])
    return {"raw": raw, "hash": keccak256(raw), "signing_hash": h, "r": r, "s": s, "v": v, "recid": rec}


def sign_1559(priv: int, *, chain_id: int, nonce: int, max_priority_fee: int, max_fee: int, gas: int, to: str | None,
              value: int, data: bytes = b"") -> dict[str, Any]:
    base = [chain_id, nonce, max_priority_fee, max_fee, gas, _addr_bytes(to), value, data, []]
    h = keccak256(b"\x02" + rlp(base))
    r, s, rec = sign(h, priv)
    raw = b"\x02" + rlp(base + [rec, r, s])
    return {"raw": raw, "hash": keccak256(raw), "signing_hash": h, "r": r, "s": s, "v": rec, "recid": rec}


# ----------------------------------------------------------------------------------------------- ABI
def selector(signature: str) -> bytes:
    return keccak256(signature.encode())[:4]


def enc_address(a: str) -> bytes:
    if not (isinstance(a, str) and len(a) == 42 and a.startswith("0x")):
        raise ValueError("bad address")
    return bytes(12) + bytes.fromhex(a[2:])


def enc_uint(n: int) -> bytes:
    if not 0 <= n < 2 ** 256:
        raise ValueError("uint256 out of range")
    return n.to_bytes(32, "big")


def encode_call(signature: str, args: list[Any]) -> bytes:
    inner = signature[signature.index("(") + 1:signature.rindex(")")]
    types = [t for t in inner.split(",") if t]
    if len(types) != len(args):
        raise ValueError("argument count mismatch")
    head: list[bytes] = []
    tail = b""
    head_size = 32 * len(types)
    for t, a in zip(types, args):
        if t == "address":
            head.append(enc_address(a))
        elif t == "uint256":
            head.append(enc_uint(a))
        elif t == "address[]":
            head.append(enc_uint(head_size + len(tail)))
            tail += enc_uint(len(a)) + b"".join(enc_address(x) for x in a)
        else:
            raise ValueError(f"unsupported ABI type {t}")
    return selector(signature) + b"".join(head) + tail


def _b(hexstr: str) -> bytes:
    h = hexstr[2:] if hexstr.startswith("0x") else hexstr
    return bytes.fromhex(h)


def decode_uint(hexstr: str) -> int:
    b = _b(hexstr)
    if len(b) < 32:
        raise ValueError("short ABI result")
    return int.from_bytes(b[:32], "big")


def decode_address(hexstr: str) -> str:
    b = _b(hexstr)
    if len(b) < 32:
        raise ValueError("short ABI result")
    return "0x" + b[12:32].hex()


def decode_uint_array(hexstr: str) -> list[int]:
    b = _b(hexstr)
    off = int.from_bytes(b[0:32], "big")
    n = int.from_bytes(b[off:off + 32], "big")
    if n > 64 or len(b) < off + 32 + 32 * n:
        raise ValueError("malformed ABI array")
    return [int.from_bytes(b[off + 32 + 32 * i: off + 64 + 32 * i], "big") for i in range(n)]


def decode_string(hexstr: str) -> str:
    """ABI string, falling back to a right-padded bytes32 (some old tokens)."""
    b = _b(hexstr)
    if len(b) == 32:
        return b.rstrip(b"\x00").decode("utf-8", "replace")
    off = int.from_bytes(b[0:32], "big")
    n = int.from_bytes(b[off:off + 32], "big")
    if n > 256 or len(b) < off + 32 + n:
        raise ValueError("malformed ABI string")
    return b[off + 32:off + 32 + n].decode("utf-8", "replace")

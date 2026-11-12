"""Minimal secp256k1 + Keccak-256 + EIP-55 for an EVM wallet. Pure Python, standard library only.

Why hand-rolled: it adds no dependency (so the Python build everywhere stays unchanged) and every primitive is checked
against published known-answer vectors in tests/test_chain_crypto.py (Keccak, the secp256k1 key-1 address and the
canonical EIP-155 signed transaction).

Known limitation: Python big-integer arithmetic is not constant-time. Signing runs only on the server, with the key
decrypted just-in-time, so timing side channels would need local co-tenancy; for a high-value production wallet,
swap `sign()` for an audited library or an HSM/KMS (the interface is one function).
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
G = (GX, GY)

# --------------------------------------------------------------------------------------------- Keccak-256
_M64 = 0xFFFFFFFFFFFFFFFF
_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
    0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]


def _rol(x: int, n: int) -> int:
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M64 if n else x


def _keccak_f(a: list[int]) -> list[int]:
    for rc in _RC:
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [a[i] ^ d[i % 5] for i in range(25)]
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rol(a[x + 5 * y], _ROT[x][y])
        a = [b[i] ^ ((~b[(i % 5 + 1) % 5 + 5 * (i // 5)] & _M64) & b[(i % 5 + 2) % 5 + 5 * (i // 5)]) for i in range(25)]
        a[0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0x00)
    msg[-1] |= 0x80
    state = [0] * 25
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        state = _keccak_f(state)
    return b"".join(state[i].to_bytes(8, "little") for i in range(4))


# --------------------------------------------------------------------------------------------- secp256k1
def _inv(a: int, m: int) -> int:
    return pow(a, -1, m)


def _add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    x1, y1 = p
    x2, y2 = q
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        lam = (3 * x1 * x1) * _inv(2 * y1, P) % P
    else:
        lam = (y2 - y1) * _inv(x2 - x1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return x3, (lam * (x1 - x3) - y1) % P


def _mul(k: int, p):
    r = None
    while k:
        if k & 1:
            r = _add(r, p)
        p = _add(p, p)
        k >>= 1
    return r


def generate_private_key() -> int:
    while True:
        k = int.from_bytes(secrets.token_bytes(32), "big")
        if 1 <= k < N:
            return k


def public_point(priv: int):
    if not 1 <= priv < N:
        raise ValueError("private key out of range")
    return _mul(priv, G)


def _addr_from_point(pt) -> str:
    raw = pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big")
    return to_checksum(keccak256(raw)[-20:].hex())


def address_from_private(priv: int) -> str:
    return _addr_from_point(public_point(priv))


def to_checksum(addr_hex: str) -> str:
    a = addr_hex.lower().removeprefix("0x")
    h = keccak256(a.encode()).hex()
    return "0x" + "".join(c.upper() if int(h[i], 16) >= 8 else c for i, c in enumerate(a))


_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")


def is_address(s: str) -> bool:
    """Valid hex address; if it is mixed-case it must also carry a correct EIP-55 checksum."""
    if not isinstance(s, str) or not _ADDR.match(s):
        return False
    body = s[2:]
    return body == body.lower() or body == body.upper() or to_checksum(s) == s


def _rfc6979(priv: int, h: bytes) -> int:
    x = priv.to_bytes(32, "big")
    h_oct = (int.from_bytes(h, "big") % N).to_bytes(32, "big")
    v, k = b"\x01" * 32, b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h_oct, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h_oct, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        cand = int.from_bytes(v, "big")
        if 1 <= cand < N:
            return cand
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def sign(msg_hash: bytes, priv: int) -> tuple[int, int, int]:
    """Deterministic (RFC 6979) low-s ECDSA signature. Returns (r, s, recovery_id)."""
    if len(msg_hash) != 32 or not 1 <= priv < N:
        raise ValueError("bad hash length or private key")
    z = int.from_bytes(msg_hash, "big")
    k = _rfc6979(priv, msg_hash)
    rx, ry = _mul(k, G)
    r = rx % N
    s = (_inv(k, N) * (z + r * priv)) % N
    recid = (ry & 1) | (2 if rx >= N else 0)
    if s > N // 2:
        s, recid = N - s, recid ^ 1
    if r == 0 or s == 0:
        raise ValueError("degenerate signature")
    return r, s, recid


def recover_address(msg_hash: bytes, r: int, s: int, recid: int) -> str:
    x = r + (N if recid & 2 else 0)
    if x >= P:
        raise ValueError("invalid recovery")
    y2 = (pow(x, 3, P) + 7) % P
    y = pow(y2, (P + 1) // 4, P)
    if (y * y) % P != y2:
        raise ValueError("invalid recovery")
    if (y & 1) != (recid & 1):
        y = P - y
    z = int.from_bytes(msg_hash, "big")
    q = _mul(_inv(r, N), _add(_mul(s, (x, y)), _mul((-z) % N, G)))
    if q is None:
        raise ValueError("invalid recovery")
    return _addr_from_point(q)

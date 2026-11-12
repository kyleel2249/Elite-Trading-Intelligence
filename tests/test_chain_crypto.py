"""Known-answer tests for the pure-Python wallet cryptography. If any of these fail the wallet must not be used."""
from __future__ import annotations

import pytest

from app.chain import crypto
from app.chain.txcodec import (decode_address, decode_string, decode_uint, decode_uint_array, enc_uint, encode_call, rlp,
                               selector, sign_1559, sign_legacy)


# ---------------------------------------------------------------------------------- Keccak-256
def test_keccak256_known_answers():
    assert crypto.keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert crypto.keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"


def test_keccak256_multi_block_input_is_stable():
    long = b"a" * 300                                     # > 2 sponge blocks
    assert crypto.keccak256(long) == crypto.keccak256(long) and len(crypto.keccak256(long)) == 32
    assert crypto.keccak256(b"a" * 135) != crypto.keccak256(b"a" * 136)


# ---------------------------------------------------------------------------------- keys + addresses
def test_private_key_one_maps_to_the_published_address():
    assert crypto.address_from_private(1) == "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"


def test_generated_keys_are_in_range_and_unique():
    ks = {crypto.generate_private_key() for _ in range(5)}
    assert len(ks) == 5 and all(1 <= k < crypto.N for k in ks)


def test_address_validation_enforces_eip55_checksum():
    good = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
    assert crypto.is_address(good) and crypto.is_address(good.lower()) and crypto.is_address("0x" + good[2:].upper())
    bad = good[:-1] + ("c" if good[-1] != "c" else "d")      # wrong last char breaks the checksum
    assert not crypto.is_address(bad)
    flipped = good[:3] + good[3].swapcase() + good[4:]      # one flipped case letter/digit position
    assert not crypto.is_address("0x123") and not crypto.is_address("7E5F" * 10) and not crypto.is_address(None)
    assert flipped == good or not crypto.is_address(flipped)


# ---------------------------------------------------------------------------------- signing
EIP155_KEY = int("46" * 32, 16)
EIP155_TO = "0x" + "35" * 20


def test_eip155_canonical_example_matches_the_spec_bit_for_bit():
    assert crypto.address_from_private(EIP155_KEY).lower() == "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f"
    t = sign_legacy(EIP155_KEY, chain_id=1, nonce=9, gas_price=20 * 10 ** 9, gas=21000, to=EIP155_TO, value=10 ** 18)
    assert t["signing_hash"].hex() == "daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53"
    assert t["v"] == 37
    assert t["r"] == 18515461264373351373200002665853028612451056578545711640558177340181847433846
    assert t["s"] == 46948507304638947509940763649030358759909902576025900602547168820602576006531
    assert t["raw"].hex() == (
        "f86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a0"
        "28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a0"
        "67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83")


def test_signatures_recover_to_the_signer_and_are_deterministic_low_s():
    priv = crypto.generate_private_key()
    addr = crypto.address_from_private(priv)
    h = crypto.keccak256(b"eti wallet self-test")
    r, s, rec = crypto.sign(h, priv)
    assert crypto.sign(h, priv) == (r, s, rec) and s <= crypto.N // 2
    assert crypto.recover_address(h, r, s, rec) == addr


def test_eip1559_transaction_recovers_to_the_sender_and_has_type_prefix():
    priv = crypto.generate_private_key()
    t = sign_1559(priv, chain_id=11155111, nonce=3, max_priority_fee=10 ** 9, max_fee=3 * 10 ** 10, gas=21000,
                  to=EIP155_TO, value=12345)
    assert t["raw"][0] == 0x02 and t["recid"] in (0, 1)
    assert crypto.recover_address(t["signing_hash"], t["r"], t["s"], t["recid"]) == crypto.address_from_private(priv)
    assert crypto.keccak256(t["raw"]) == t["hash"]


def test_signing_rejects_bad_inputs():
    with pytest.raises(ValueError):
        crypto.sign(b"short", 1)
    with pytest.raises(ValueError):
        crypto.sign(b"\x00" * 32, 0)
    with pytest.raises(ValueError):
        crypto.sign(b"\x00" * 32, crypto.N)


# ---------------------------------------------------------------------------------- RLP
def test_rlp_reference_vectors():
    assert rlp(b"dog").hex() == "83646f67"
    assert rlp([b"cat", b"dog"]).hex() == "c88363617483646f67"
    assert rlp(0).hex() == "80" and rlp(b"").hex() == "80" and rlp([]).hex() == "c0"
    assert rlp(15).hex() == "0f" and rlp(1024).hex() == "820400"
    assert rlp(b"a" * 56).hex().startswith("b838")          # long-string length prefix
    with pytest.raises(TypeError):
        rlp(True)
    with pytest.raises(ValueError):
        rlp(-1)


# ---------------------------------------------------------------------------------- ABI
def test_well_known_function_selectors():
    assert selector("transfer(address,uint256)").hex() == "a9059cbb"
    assert selector("approve(address,uint256)").hex() == "095ea7b3"
    assert selector("balanceOf(address)").hex() == "70a08231"
    assert selector("decimals()").hex() == "313ce567"
    assert selector("swapExactETHForTokens(uint256,address[],address,uint256)").hex() == "7ff36ab5"
    assert selector("getAmountsOut(uint256,address[])").hex() == "d06ca61f"


def test_encode_call_static_and_dynamic_layouts():
    a = "0x" + "11" * 20
    d = encode_call("approve(address,uint256)", [a, 5])
    assert d[:4].hex() == "095ea7b3" and len(d) == 4 + 64 and d[4:36] == bytes(12) + bytes.fromhex(a[2:]) and d[36:] == enc_uint(5)
    p = ["0x" + "22" * 20, "0x" + "33" * 20]
    s = encode_call("swapExactETHForTokens(uint256,address[],address,uint256)", [7, p, a, 99])
    assert int.from_bytes(s[4 + 32:4 + 64], "big") == 128           # offset of the dynamic array
    assert int.from_bytes(s[4 + 128:4 + 160], "big") == 2           # array length
    with pytest.raises(ValueError):
        encode_call("foo(uint256)", [])
    with pytest.raises(ValueError):
        enc_uint(2 ** 256)


def test_abi_decoders():
    assert decode_uint("0x" + (255).to_bytes(32, "big").hex()) == 255
    assert decode_address("0x" + "00" * 12 + "ab" * 20) == "0x" + "ab" * 20
    arr = "0x" + (32).to_bytes(32, "big").hex() + (2).to_bytes(32, "big").hex() + (10).to_bytes(32, "big").hex() + (20).to_bytes(32, "big").hex()
    assert decode_uint_array(arr) == [10, 20]
    s = "0x" + (32).to_bytes(32, "big").hex() + (3).to_bytes(32, "big").hex() + b"ETI".ljust(32, b"\x00").hex()
    assert decode_string(s) == "ETI" and decode_string("0x" + b"WETH".ljust(32, b"\x00").hex()) == "WETH"
    with pytest.raises(ValueError):
        decode_uint("0x1234")

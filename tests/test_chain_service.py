"""ETI wallet service tests against a fake RPC node: policy, quotes, signing/broadcast, receipts, DEX, inspection, API."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.chain import service as chain_service
from app.chain.crypto import address_from_private, is_address, keccak256
from app.chain.models import ChainAllowlist, ChainEvent, ChainTransaction, ChainWallet
from app.chain.networks import NETWORKS
from app.chain.rpc import RpcError
from app.chain.service import ChainError, ChainService
from app.database import SessionLocal, init_db
from app.execution.vault import CredentialVault
from app.main import app

ROUTER = "0x" + "a1" * 20
WRAPPED = "0x" + "b2" * 20
TOKEN = "0x" + "c3" * 20
DEST = "0x" + "d4" * 20


def setup_module():
    init_db()


def run(coro):
    return asyncio.run(coro)


def _u(n: int) -> str:
    return "0x" + n.to_bytes(32, "big").hex()


class FakeRpc:
    def __init__(self):
        self.cid, self.balance, self.nonce_v, self.fail_send = 11155111, 10 ** 18, 5, False
        self.sent, self.receipts, self.token_balance, self.allowance = [], {}, 10 ** 21, 0
        self.code, self.blocks, self.owner = "0x6080", {}, "0x" + "00" * 12 + "ee" * 20

    async def chain_id(self): return self.cid
    async def block_number(self): return 100
    async def get_balance(self, a): return self.balance
    async def nonce(self, a): return self.nonce_v
    async def fee_data(self): return {"base_fee": 10 ** 9, "priority": 10 ** 9, "gas_price": 2 * 10 ** 9}
    async def estimate_gas(self, frm, to, value, data_hex): return 21000 if data_hex in ("0x", "") else 150000

    async def send_raw(self, raw):
        if self.fail_send:
            raise RpcError("nonce too low")
        self.sent.append(raw)
        return "0x" + keccak256(bytes.fromhex(raw[2:])).hex()

    async def receipt(self, h): return self.receipts.get(h)
    async def get_code(self, a): return self.code
    async def get_storage(self, a, slot): return "0x" + "00" * 32
    async def get_block(self, n, full): return self.blocks.get(n)

    async def call(self, to, data_hex):
        sel = data_hex[2:10]
        if sel == "d06ca61f":                                     # getAmountsOut(amountIn, path) -> [in, in*2]
            amt = int(data_hex[10:74], 16)
            return "0x" + (32).to_bytes(32, "big").hex() + (2).to_bytes(32, "big").hex() + amt.to_bytes(32, "big").hex() + (amt * 2).to_bytes(32, "big").hex()
        if sel == "70a08231": return _u(self.token_balance)
        if sel == "dd62ed3e": return _u(self.allowance)
        if sel == "313ce567": return _u(18)
        if sel == "18160ddd": return _u(10 ** 24)
        if sel == "8da5cb5b": return self.owner
        if sel in ("06fdde03", "95d89b41"):
            return "0x" + (32).to_bytes(32, "big").hex() + (3).to_bytes(32, "big").hex() + b"TKN".ljust(32, b"\x00").hex()
        raise RpcError("execution reverted")


@pytest.fixture
def env(monkeypatch):
    for k in ("CHAIN_MAX_TX_NATIVE", "CHAIN_MAX_DAILY_NATIVE", "CHAIN_MAX_SLIPPAGE_BPS", "CHAIN_REQUIRE_ALLOWLIST", "CHAIN_MAINNET_SEND_ENABLED"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("EXECUTION_VAULT_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("CHAIN_MAX_TX_NATIVE", "0.05")
    monkeypatch.setenv("CHAIN_MAX_DAILY_NATIVE", "0.08")
    monkeypatch.setenv("CHAIN_DEX_ROUTER_SEPOLIA", ROUTER)
    monkeypatch.setenv("CHAIN_WRAPPED_NATIVE_SEPOLIA", WRAPPED)
    fake = FakeRpc()
    monkeypatch.setattr(chain_service, "make_rpc", lambda key: fake)
    db = SessionLocal()
    for m in (ChainTransaction, ChainAllowlist, ChainWallet, ChainEvent):
        db.query(m).delete()
    db.commit()
    yield fake, db
    db.close()


def svc(db, kill=False):
    return ChainService(db, settings=SimpleNamespace(kill_switch=kill, secret_key="unit-test-secret"))


def ready(db):
    s = svc(db)
    s.create_wallet()
    s.allow_add(network="*", address=DEST, kind="destination", label="cold")
    return s


# ------------------------------------------------------------------------------------------------ wallet
def test_wallet_is_vault_gated_unique_and_never_exposes_the_key(env, monkeypatch):
    _, db = env
    monkeypatch.delenv("EXECUTION_VAULT_KEY")
    with pytest.raises(ChainError) as e:
        svc(db).create_wallet()
    assert e.value.status == 503 and db.query(ChainWallet).count() == 0
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("EXECUTION_VAULT_KEY", key)
    w = svc(db).create_wallet()
    assert is_address(w.address)
    priv_hex = CredentialVault(key).open(w.key_ciphertext)["private_key"]
    assert address_from_private(int(priv_hex, 16)) == w.address
    assert priv_hex not in w.key_ciphertext and priv_hex not in str(ChainService.wallet_dict(w))
    with pytest.raises(ChainError) as e2:
        svc(db).create_wallet()
    assert e2.value.status == 409


# ------------------------------------------------------------------------------------------------ policy
def test_transfer_requires_allowlist_cap_and_valid_input(env):
    _, db = env
    s = svc(db); s.create_wallet()
    p = run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert not p["allowed"] and "quote_id" not in p and any("allowlist" in v for v in p["violations"])
    s.allow_add(network="*", address=DEST, kind="destination")
    ok = run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert ok["allowed"] and ok["quote_id"] and ok["value_wei"] == str(10 ** 16) and ok["fees"]["type"] == 2
    big = run(s.preview_transfer("sepolia", DEST, "0.06"))
    assert not big["allowed"] and any("per-transaction cap" in v for v in big["violations"])
    for bad_to, bad_amt in ((("0x123"), "0.01"), (DEST, "0"), (DEST, "0.0000000000000000001")):
        with pytest.raises(ChainError) as e:
            run(s.preview_transfer("sepolia", bad_to, bad_amt))
        assert e.value.status == 422
    with pytest.raises(ChainError):
        run(s.preview_transfer("nosuchnet", DEST, "0.01"))


def test_kill_switch_blocks_new_quotes(env):
    _, db = env
    ready(db)
    p = run(svc(db, kill=True).preview_transfer("sepolia", DEST, "0.01"))
    assert not p["allowed"] and any("kill switch" in v for v in p["violations"])


def test_mainnet_sending_is_off_unless_the_operator_enables_it(env, monkeypatch):
    fake, db = env
    s = ready(db); fake.cid = 1
    p = run(s.preview_transfer("ethereum", DEST, "0.01"))
    assert not p["allowed"] and any("CHAIN_MAINNET_SEND_ENABLED" in v for v in p["violations"]) and p["mainnet"] is True
    monkeypatch.setenv("CHAIN_MAINNET_SEND_ENABLED", "true")
    assert run(s.preview_transfer("ethereum", DEST, "0.01"))["allowed"]


def test_wrong_chain_id_is_refused_and_insufficient_balance_flagged(env):
    fake, db = env
    s = ready(db)
    fake.cid = 5
    with pytest.raises(ChainError) as e:
        run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert e.value.status == 502 and "chain id" in e.value.message
    fake.cid, fake.balance = 11155111, 10 ** 15
    p = run(s.preview_transfer("sepolia", DEST, "0.01"))
    assert not p["allowed"] and any("insufficient balance" in v for v in p["violations"])


# ------------------------------------------------------------------------------------------------ send
def test_send_signs_broadcasts_records_and_quote_is_single_use(env):
    fake, db = env
    s = ready(db)
    q = run(s.preview_transfer("sepolia", DEST, "0.01"))["quote_id"]
    with pytest.raises(ChainError) as e:
        run(s.send(q, "yes"))
    assert e.value.status == 400 and not fake.sent
    tx = run(s.send(q, "SEND"))
    assert tx["status"] == "pending" and tx["nonce"] == 5 and tx["network"] == "sepolia" and len(fake.sent) == 1
    raw = fake.sent[0]
    assert raw.startswith("0x02") and tx["tx_hash"] == "0x" + keccak256(bytes.fromhex(raw[2:])).hex()
    assert tx["explorer_url"].endswith(tx["tx_hash"])
    with pytest.raises(ChainError) as again:
        run(s.send(q, "SEND"))
    assert again.value.status == 409 and len(fake.sent) == 1
    kinds = [r.event for r in db.query(ChainEvent).all()]
    assert {"wallet_created", "tx_signed", "tx_broadcast"} <= set(kinds)


def test_tampered_and_expired_quotes_are_rejected(env, monkeypatch):
    fake, db = env
    s = ready(db)
    q = run(s.preview_transfer("sepolia", DEST, "0.01"))["quote_id"]
    raw, sig = q.rsplit(".", 1)
    for bad in (raw + "x." + sig, raw + "." + sig[:-1] + ("0" if sig[-1] != "0" else "1"), "garbage"):
        with pytest.raises(ChainError) as e:
            run(s.send(bad, "SEND"))
        assert e.value.status == 400
    monkeypatch.setattr(chain_service.time, "time", lambda: time.time.__call__() + 1000 if False else 4102444800.0)
    with pytest.raises(ChainError) as e2:
        run(s.send(q, "SEND"))
    assert "expired" in e2.value.message and not fake.sent


def test_daily_cap_accumulates_across_sends(env):
    _, db = env
    s = ready(db)
    run(s.send(run(s.preview_transfer("sepolia", DEST, "0.05"))["quote_id"], "SEND"))
    p = run(s.preview_transfer("sepolia", DEST, "0.05"))
    assert not p["allowed"] and any("24h cap" in v for v in p["violations"])
    assert run(s.preview_transfer("sepolia", DEST, "0.02"))["allowed"]


def test_broadcast_failure_is_recorded_honestly_and_does_not_count_toward_caps(env):
    fake, db = env
    s = ready(db); fake.fail_send = True
    with pytest.raises(ChainError) as e:
        run(s.send(run(s.preview_transfer("sepolia", DEST, "0.05"))["quote_id"], "SEND"))
    assert e.value.status == 502
    row = db.query(ChainTransaction).one()
    assert row.status == "broadcast_failed" and "nonce too low" in row.error
    assert run(s.preview_transfer("sepolia", DEST, "0.05"))["allowed"]       # failed broadcasts do not consume the daily cap


def test_receipts_decide_confirmed_vs_failed(env):
    fake, db = env
    s = ready(db)
    t1 = run(s.send(run(s.preview_transfer("sepolia", DEST, "0.01"))["quote_id"], "SEND"))
    assert run(s.refresh_tx(t1["id"]))["status"] == "pending"               # no receipt yet: never claim confirmation
    fake.receipts[t1["tx_hash"]] = {"status": "0x1", "gasUsed": "0x5208", "blockNumber": "0x10"}
    done = run(s.refresh_tx(t1["id"]))
    assert done["status"] == "confirmed" and done["gas_used"] == 21000 and done["block_number"] == 16
    fake.nonce_v = 6
    t2 = run(s.send(run(s.preview_transfer("sepolia", DEST, "0.01"))["quote_id"], "SEND"))
    fake.receipts[t2["tx_hash"]] = {"status": "0x0", "gasUsed": "0x5208", "blockNumber": "0x11"}
    assert run(s.refresh_pending())[0]["status"] == "failed"


# ------------------------------------------------------------------------------------------------ DEX
def test_swap_buy_preview_enforces_token_allowlist_and_slippage(env):
    _, db = env
    s = ready(db)
    unlisted = run(s.preview_swap("sepolia", "buy", TOKEN, "0.01", 50))
    assert not unlisted["allowed"] and any("token allowlist" in v for v in unlisted["violations"])
    s.allow_add(network="sepolia", address=TOKEN, kind="token", symbol="TKN", decimals=18)
    ok = run(s.preview_swap("sepolia", "buy", TOKEN, "0.01", 50))
    assert ok["allowed"] and ok["data"].startswith("0x7ff36ab5") and ok["to"].lower() == ROUTER and ok["value_wei"] == str(10 ** 16)
    assert ok["expected_out_wei"] == str(2 * 10 ** 16) and ok["min_out_wei"] == str(2 * 10 ** 16 * 9950 // 10000)
    loose = run(s.preview_swap("sepolia", "buy", TOKEN, "0.01", 900))
    assert not loose["allowed"] and any("slippage" in v for v in loose["violations"])


def test_swap_sell_needs_an_exact_approval_first(env):
    fake, db = env
    s = ready(db)
    s.allow_add(network="sepolia", address=TOKEN, kind="token", symbol="TKN", decimals=18)
    first = run(s.preview_swap("sepolia", "sell", TOKEN, "0.01", 50))
    assert first["needs_approval"] and not first["allowed"] and any("allowance" in v for v in first["violations"])
    ap = run(s.preview_approval("sepolia", TOKEN, "0.01"))
    assert ap["allowed"] and ap["data"].startswith("0x095ea7b3") and ap["to"].lower() == TOKEN and ap["value_wei"] == "0"
    assert int(ap["data"][-64:], 16) == 10 ** 16                                  # exact amount, never unlimited
    fake.allowance = 10 ** 16
    ok = run(s.preview_swap("sepolia", "sell", TOKEN, "0.01", 50))
    assert ok["allowed"] and not ok["needs_approval"] and ok["data"].startswith("0x18cbafe5") and ok["value_wei"] == "0"


def test_swap_requires_dex_configuration(env, monkeypatch):
    _, db = env
    s = ready(db)
    monkeypatch.delenv("CHAIN_DEX_ROUTER_SEPOLIA")
    with pytest.raises(ChainError) as e:
        run(s.preview_swap("sepolia", "buy", TOKEN, "0.01", 50))
    assert e.value.status == 503


# ------------------------------------------------------------------------------------------------ intelligence
def test_contract_inspection_reports_indicators_not_verdicts(env):
    fake, db = env
    s = ready(db)
    c = run(s.inspect_contract("sepolia", TOKEN))
    assert c["is_contract"] and c["symbol"] == "TKN" and c["decimals"] == 18 and "not a safety verdict" in c["disclaimer"]
    assert any(i["severity"] == "low" and "owner" in i["text"].lower() for i in c["indicators"])
    fake.code = "0x"
    eoa = run(s.inspect_contract("sepolia", DEST))
    assert not eoa["is_contract"] and eoa["indicators"][0]["severity"] == "informational"


def test_block_scan_flags_large_and_watched_transfers(env):
    fake, db = env
    s = ready(db)
    watched = "0x" + "e5" * 20
    s.allow_add(network="*", address=watched, kind="watch", label="watched")
    fake.blocks = {100: {"transactions": [
        {"hash": "0x01", "from": DEST, "to": TOKEN, "value": hex(2 * 10 ** 18)},
        {"hash": "0x02", "from": DEST, "to": TOKEN, "value": hex(10 ** 15)},
        {"hash": "0x03", "from": watched, "to": TOKEN, "value": "0x0"}]}}
    r = run(s.scan_blocks("sepolia", 1, "1"))
    tags = {f["tx_hash"]: f["tags"] for f in r["findings"]}
    assert tags == {"0x01": ["large_transfer"], "0x03": ["watched_address"]} and r["head"] == 100


# ------------------------------------------------------------------------------------------------ HTTP API
def test_api_flow_without_key_material_in_any_response(env):
    fake, db = env
    c = TestClient(app)
    r = c.post("/api/chain/wallet", json={"label": "ETI"})
    assert r.status_code == 201 and is_address(r.json()["address"])
    assert not any(k in r.text.lower() for k in ("private", "ciphertext", "secret", "mnemonic"))
    assert c.post("/api/chain/wallet", json={}).status_code == 409
    assert c.get("/api/chain/wallet").json()["wallet"]["address"] == r.json()["address"]
    nets = c.get("/api/chain/networks").json()
    assert any(n["key"] == "sepolia" for n in nets["networks"]) and nets["limits"]["mainnet_send_enabled"] is False
    assert c.post("/api/chain/allowlist", json={"network": "*", "address": DEST, "kind": "destination"}).status_code == 201
    assert c.post("/api/chain/transfer/preview", json={"network": "sepolia", "to": "0x12", "amount": "1"}).status_code == 422
    pv = c.post("/api/chain/transfer/preview", json={"network": "sepolia", "to": DEST, "amount": "0.01"})
    assert pv.status_code == 200 and pv.json()["allowed"]
    assert c.post("/api/chain/send", json={"quote_id": pv.json()["quote_id"], "confirm": "nope"}).status_code == 400
    sent = c.post("/api/chain/send", json={"quote_id": pv.json()["quote_id"], "confirm": "SEND"})
    assert sent.status_code == 200 and sent.json()["transaction"]["status"] == "pending"
    assert c.get("/api/chain/txs").json()["transactions"][0]["tx_hash"] == sent.json()["transaction"]["tx_hash"]
    assert [e["event"] for e in c.get("/api/chain/events").json()["events"]][0] == "tx_broadcast"
    st = c.get("/api/chain/status").json()
    assert st["wallet"]["address"] == r.json()["address"] and st["networks"][0]["connected"] is True

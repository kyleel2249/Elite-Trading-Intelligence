import test from "node:test";
import assert from "node:assert/strict";
import { scanPublicAddress, isValidPublicAddress } from "./onchain-monitor.ts";

test("public chain address validator rejects malformed inputs and supports common formats", () => {
  assert.equal(isValidPublicAddress("bitcoin", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"), true);
  assert.equal(isValidPublicAddress("ethereum", "0x" + "1".repeat(40)), true);
  assert.equal(isValidPublicAddress("solana", "11111111111111111111111111111111"), true);
  assert.equal(isValidPublicAddress("ethereum", "bad"), false);
});

test("bitcoin scan computes address net flow from inputs and outputs", async () => {
  const address = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  const fake = async () => new Response(JSON.stringify([{
    txid: "tx-demo",
    vin: [{ prevout: { scriptpubkey_address: "1other", value: 100000000 } }],
    vout: [{ scriptpubkey_address: address, value: 25000000 }],
    status: { confirmed: true, block_time: 1700000000 }
  }]), { status: 200, headers: { "content-type": "application/json" } });
  const r = await scanPublicAddress("bitcoin", address, fake as typeof fetch);
  assert.equal(r.count, 1);
  assert.equal(r.events[0].direction, "inflow");
  assert.equal(r.events[0].amountNative, .25);
  assert.equal(r.provider, "mempool.space");
});

test("EVM scan returns native movement and token transfers when supported", async () => {
  const address = "0x" + "a".repeat(40);
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ items: [{
      hash: "0xhash", from: { hash: "0x" + "b".repeat(40) }, to: { hash: address },
      value: "1000000000000000000", timestamp: "2025-01-01T00:00:00Z"
    }] }), { status: 200 });
    return new Response(JSON.stringify({ items: [{
      transaction_hash: "0x-token", from: { hash: "0x" + "b".repeat(40) }, to: { hash: address },
      total: { value: "2500000" }, token: { symbol: "USDC", decimals: "6", address: "0x" + "c".repeat(40) },
      timestamp: "2025-01-01T00:00:00Z"
    }] }), { status: 200 });
  };
  const r = await scanPublicAddress("ethereum", address, fake as typeof fetch);
  assert.equal(r.count, 2);
  assert.equal(r.events[0].amountNative, 1);
  assert.equal(r.events[1].amountNative, 2.5);
  assert.equal(r.events[1].nativeAsset, "USDC");
});

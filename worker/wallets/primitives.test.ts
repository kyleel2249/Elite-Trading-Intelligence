import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, fromHex, toHex } from "./bytes.ts";
import { combine, parseShare, split } from "./shamir.ts";
import { detectSecret, findSecret, redact } from "./redact.ts";
import { cborDecode, verifyAssertion, verifyRegistration } from "./webauthn.ts";
import { SoftKey } from "./softkey.ts";

const O = "https://eti.example", RP = "eti.example", E = (challenge: string) => ({ challenge, origins: [O], rpId: RP });

test("shamir: any k of n rebuild the secret, fewer or mixed shares cannot", () => {
  const secret = crypto.getRandomValues(new Uint8Array(32)), shares = split(secret, 3, 5);
  assert.equal(shares.length, 5);
  for (const pick of [[0, 1, 2], [4, 2, 0], [1, 3, 4], [0, 1, 2, 3, 4]]) assert.equal(toHex(combine(pick.map((i) => shares[i]))), toHex(secret));
  assert.throws(() => combine(shares.slice(0, 2)), /need 3 shares/);
  assert.throws(() => combine([shares[0], shares[0], shares[1]]), /duplicate/);
  assert.throws(() => combine([...shares.slice(0, 2), split(secret, 3, 5)[2]]), /different ceremonies/);
  const t = shares[0].replace(/.$/, (c) => (c === "0" ? "1" : "0")); assert.throws(() => parseShare(t), /check failed/);
  assert.throws(() => split(secret, 1, 3)); assert.throws(() => split(secret, 4, 3)); assert.throws(() => split(new Uint8Array(8), 2, 3));
  // a forged third share of the same set rebuilds garbage, never the secret
  const forged = ["eti-shr1", shares[2].split(":")[1], 3, 5, 3, "00".repeat(32)].join(":"), body = forged; const fnvText = (t: string) => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
  assert.notEqual(toHex(combine([shares[0], shares[1], body + ":" + fnvText(body)])), toHex(secret));
});

test("secret detection refuses seed phrases and private keys but allows transaction hashes where expected", () => {
  const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  assert.equal(detectSecret(phrase), "mnemonic"); assert.equal(detectSecret("-----BEGIN EC PRIVATE KEY-----\nabc"), "pem_private_key");
  assert.equal(detectSecret("a".repeat(64)), "hex_private_key"); assert.equal(detectSecret("0x" + "ab".repeat(32)), "hex_private_key");
  assert.equal(detectSecret("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"), "wif"); assert.equal(detectSecret("my seed phrase: apple"), "labelled_secret");
  assert.equal(detectSecret("eti-shr1:0a0b0c0d:3:5:1:" + "00".repeat(32) + ":12345678"), "share");
  assert.equal(detectSecret("Withdraw to the cold storage address"), null); assert.equal(detectSecret("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), null); assert.equal(detectSecret("0x" + "ab".repeat(20)), null);
  assert.equal(findSecret({ txRef: "a".repeat(64) }), null); assert.deepEqual(findSecret({ label: "a".repeat(64) }), { path: "label", kind: "hex_private_key" });
  assert.equal(findSecret({ nested: [{ note: phrase }] })?.kind, "mnemonic"); assert.equal(findSecret({ password: "hunter2" })?.kind, "labelled_secret");
  const r: any = redact({ a: phrase, b: { d: "secretvalue", ok: "fine" }, txRef: "a".repeat(64) }); assert.equal(r.a, "[REDACTED]"); assert.equal(r.b.d, "[REDACTED]"); assert.equal(r.b.ok, "fine"); assert.equal(r.txRef, "a".repeat(64));
});

test("cbor decoder handles the shapes WebAuthn uses and rejects malformed input", () => {
  assert.deepEqual(cborDecode(Uint8Array.of(0x18, 200)).value, 200); assert.equal(cborDecode(Uint8Array.of(0x26)).value, -7);
  assert.equal(cborDecode(Uint8Array.of(0x63, 0x61, 0x62, 0x63)).value, "abc");
  assert.throws(() => cborDecode(Uint8Array.of(0x58, 5, 1))); assert.throws(() => cborDecode(Uint8Array.of(0xf9, 0, 0))); assert.throws(() => cborDecode(new Uint8Array(0)));
});

test("webauthn: registration and assertions verify; every tampering is refused", async () => {
  const key = await SoftKey.create(), chal = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const reg = await verifyRegistration(await key.register(chal, O, RP), E(chal)); assert.equal(reg.ok, true); if (!reg.ok) return;
  assert.equal(reg.credentialId, b64u(key.credId)); assert.equal(reg.backupEligible, false);
  const cred = { publicKey: reg.publicKey, signCount: reg.signCount }, digest = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const a1 = await key.assert(digest, O, RP), ok = await verifyAssertion(a1, E(digest), cred); assert.deepEqual(ok, { ok: true, signCount: 1 });
  const bad = async (a: any, e: any, c = cred) => (await verifyAssertion(a, e, c) as any).reason;
  assert.equal(await bad(a1, E(b64u(new Uint8Array(32)))), "challenge_mismatch");
  assert.equal(await bad(a1, { ...E(digest), origins: ["https://evil.example"] }), "origin_not_allowed");
  assert.equal(await bad(a1, { ...E(digest), rpId: "evil.example" }), "rp_id_mismatch");
  assert.equal(await bad(a1, E(digest), { ...cred, signCount: 5 }), "sign_count_not_increasing");
  assert.equal(await bad(await key.assert(digest, O, RP, { type: "webauthn.create" }), E(digest)), "wrong_ceremony_type");
  const other = await SoftKey.create(), regOther: any = await verifyRegistration(await other.register(chal, O, RP), E(chal));
  assert.equal(await bad(await key.assert(digest, O, RP), E(digest), { publicKey: regOther.publicKey, signCount: 0 }), "bad_signature");
  const sig = a1.signature, flip = sig.slice(0, 20) + (sig[20] === "A" ? "B" : "A") + sig.slice(21); assert.match(await bad({ ...a1, signature: flip }, E(digest)), /bad_signature|assertion_invalid/);
  key.uv = false; assert.equal(await bad(await key.assert(digest, O, RP), E(digest), { ...cred, signCount: 1 }), "user_verification_required");
});

test("webauthn registration policy: user verification required, synced passkeys refused by default, model allow-list", async () => {
  const chal = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const noUv = await SoftKey.create({ uv: false }); assert.equal(((await verifyRegistration(await noUv.register(chal, O, RP), E(chal))) as any).reason, "user_verification_required");
  const synced = await SoftKey.create({ backupEligible: true }), r = await synced.register(chal, O, RP);
  assert.equal(((await verifyRegistration(r, E(chal))) as any).reason, "synced_passkey_not_allowed"); assert.equal((await verifyRegistration(r, E(chal), { allowSynced: true })).ok, true);
  const model = await SoftKey.create({ aaguid: fromHex("00112233445566778899aabbccddeeff") }), m = await model.register(chal, O, RP);
  assert.equal(((await verifyRegistration(m, E(chal), { aaguids: ["ffffffffffffffffffffffffffffffff"] })) as any).reason, "authenticator_model_not_allowed"); assert.equal((await verifyRegistration(m, E(chal), { aaguids: ["00112233445566778899aabbccddeeff"] })).ok, true);
  assert.equal(((await verifyRegistration({ ...r, clientDataJSON: b64u(new TextEncoder().encode("{}")) }, E(chal))) as any).reason, "wrong_ceremony_type");
  assert.match(((await verifyRegistration({ clientDataJSON: "!!", attestationObject: "x" }, E(chal))) as any).reason, /registration_invalid/);
});

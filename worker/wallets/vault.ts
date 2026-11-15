/**
 * Recovery vault: encrypted wallet-state backups and Shamir-split recovery keys.
 *
 * What a backup protects: the wallet configuration and approval history (signers, public keys, policies, whitelist, actions, ledger balances). It never holds
 * wallet private keys or seed phrases, because ETI never has them; those stay with the custodian / HSM / MPC provider and have their own backup procedure.
 *
 *  - The recovery key is an ECDH P-256 pair generated OFFLINE (scripts/wallet-recover.mjs init). Only its PUBLIC key is registered in ETI; the private scalar is split
 *    into k-of-n Shamir shares for separate custodians. ETI cannot decrypt its own backups.
 *  - Each backup: ephemeral ECDH to the recovery public key -> HKDF -> AES-256-GCM, with the header authenticated as AAD, plus an HMAC (identity key) over the whole file
 *    so ETI can tell a genuine, untampered backup from a substituted one before it will restore anything.
 *  - Restore is offline decrypt (k shares) then an online restore of the plaintext events into an EMPTY wallet store, accepted only if the events hash to the MAC-protected hash.
 */
import { b64u, concat, ctEqual, fromHex, sha256Hex, te, td, toHex, unb64u } from "./bytes.ts";
import { canon } from "./model.ts";
import { combine, parseShare, split } from "./shamir.ts";
import type { Jwk } from "./webauthn.ts";

export interface SealedBackup { v: 1; kind: "eti-wallet-backup"; setId: string; createdAt: number; count: number; plainHash: string; recipient: Jwk; eph: Jwk; salt: string; iv: string; ct: string; mac: string }
const INFO = (setId: string) => te.encode("eti-wallet-backup-v1|" + setId);
const pubOf = (j: JsonWebKey): Jwk => ({ kty: "EC", crv: "P-256", x: j.x!, y: j.y! });

/** Used by the offline CLI and the tests. The private scalar leaves this function only as shares. */
export async function newRecoverySet(k: number, n: number): Promise<{ publicKey: Jwk; shares: string[]; setId: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey), pub = pubOf(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const shares = split(unb64u(priv.d!), k, n), setId = parseShare(shares[0]).setId;
  return { publicKey: pub, shares, setId };
}
async function macOf(key: string, b: Omit<SealedBackup, "mac">): Promise<string> {
  const k = await crypto.subtle.importKey("raw", te.encode("eti-wallet-backup-mac|" + key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(canon(b)))));
}
async function aesKey(shared: Uint8Array, salt: Uint8Array, setId: string, usage: KeyUsage[]) {
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO(setId) }, base, { name: "AES-GCM", length: 256 }, false, usage);
}
const aad = (b: Omit<SealedBackup, "mac" | "ct">) => te.encode(canon(b));
const importPub = (j: Jwk) => crypto.subtle.importKey("jwk", { ...j, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);

export async function sealBackup(events: unknown[], recipient: Jwk, setId: string, macKey: string, now: number): Promise<string> {
  if (macKey.length < 32) throw new Error("identity key missing");
  const plain = canon(events), eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await importPub(recipient) }, eph.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const head = { v: 1 as const, kind: "eti-wallet-backup" as const, setId, createdAt: now, count: events.length, plainHash: await sha256Hex(plain), recipient, eph: pubOf(await crypto.subtle.exportKey("jwk", eph.publicKey)), salt: b64u(salt), iv: b64u(iv) };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(head) }, await aesKey(shared, salt, setId, ["encrypt"]), te.encode(plain)));
  const body = { ...head, ct: b64u(ct) }; return JSON.stringify({ ...body, mac: await macOf(macKey, body) });
}
export function parseSealed(text: string): SealedBackup | null {
  try { const b = JSON.parse(text); return b && b.v === 1 && b.kind === "eti-wallet-backup" && typeof b.ct === "string" && typeof b.mac === "string" && typeof b.plainHash === "string" ? b : null; } catch { return null; }
}
export async function verifyMac(b: SealedBackup, macKeys: string[]): Promise<boolean> {
  const { mac, ...body } = b; for (const k of macKeys) if (ctEqual(fromHex(await macOf(k, body)), fromHex(mac.length % 2 === 0 && /^[0-9a-f]+$/.test(mac) ? mac : "00"))) return true; return false;
}
/** Offline: needs k shares. Returns the events or a reason. */
export async function openBackup(text: string, shares: string[]): Promise<{ ok: true; events: any[]; backup: SealedBackup } | { ok: false; error: string }> {
  const b = parseSealed(text); if (!b) return { ok: false, error: "not an ETI wallet backup" };
  let d: Uint8Array; try { d = combine(shares); } catch (e) { return { ok: false, error: (e as Error).message }; }
  if (parseShare(shares[0]).setId !== b.setId) return { ok: false, error: "these shares belong to a different recovery set than this backup" };
  try {
    const priv = await crypto.subtle.importKey("jwk", { ...b.recipient, d: b64u(d), ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await importPub(b.eph) }, priv, 256)), { ct, mac, ...head } = b, { ct: _c, ...h2 } = { ...head, ct };
    const plain = td.decode(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(b.iv), additionalData: aad(h2 as any) }, await aesKey(shared, unb64u(b.salt), b.setId, ["decrypt"]), unb64u(ct))));
    if (await sha256Hex(plain) !== b.plainHash) return { ok: false, error: "decrypted content does not match its recorded hash" };
    const events = JSON.parse(plain); return Array.isArray(events) ? { ok: true, events, backup: b } : { ok: false, error: "unexpected content" };
  } catch { return { ok: false, error: "decryption failed (wrong shares or a tampered backup)" }; }
}
/** Online: the bundle is { backup: <sealed file text>, events } produced by the offline tool. Genuine only if the MAC verifies and the events match the MAC-protected hash. */
export async function checkRestoreBundle(bundle: any, macKeys: string[]): Promise<{ ok: true; events: any[]; backup: SealedBackup } | { ok: false; error: string }> {
  const b = parseSealed(typeof bundle?.backup === "string" ? bundle.backup : ""); if (!b || !Array.isArray(bundle?.events)) return { ok: false, error: "bundle must contain the sealed backup text and the decrypted events" };
  if (!(await verifyMac(b, macKeys))) return { ok: false, error: "backup MAC does not verify: it was altered, or it was made under an identity key this deployment does not hold" };
  if (await sha256Hex(canon(bundle.events)) !== b.plainHash || bundle.events.length !== b.count) return { ok: false, error: "events do not match the backup's protected hash" };
  return { ok: true, events: bundle.events, backup: b };
}
export const _internal = { concat };

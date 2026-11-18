/**
 * Server-side WebAuthn (ES256 / P-256, attestation "none") on WebCrypto only. A signer's approval is a hardware-authenticator assertion whose
 * challenge IS the digest of the action being approved, so a stolen session cannot approve and an approval cannot be replayed for another action.
 * Registration refuses synced passkeys unless explicitly allowed (backup-eligible credentials live in a cloud account, not in hardware).
 * Attestation statements are not validated (fmt "none"): the AAGUID is recorded and can be allow-listed, but this does not prove the make or model.
 */
import { b64u, concat, ctEqual, sha256, td, unb64u } from "./bytes.ts";

// ---- minimal CBOR (definite lengths, ints, byte/text strings, arrays, maps, simple values) ----
export function cborDecode(buf: Uint8Array, start = 0): { value: any; end: number } {
  let p = start;
  const read = (): any => {
    if (p >= buf.length) throw new Error("cbor: truncated");
    const ib = buf[p++], major = ib >> 5, ai = ib & 31;
    let n: number;
    if (ai < 24) n = ai;
    else if (ai === 24) { if (p + 1 > buf.length) throw new Error("cbor: truncated"); n = buf[p++]; }
    else if (ai === 25) { if (p + 2 > buf.length) throw new Error("cbor: truncated"); n = (buf[p] << 8) | buf[p + 1]; p += 2; }
    else if (ai === 26) { if (p + 4 > buf.length) throw new Error("cbor: truncated"); n = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0; p += 4; }
    else throw new Error("cbor: unsupported length form");
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { if (p + n > buf.length) throw new Error("cbor: truncated"); const v = buf.slice(p, p + n); p += n; return v; }
      case 3: { if (p + n > buf.length) throw new Error("cbor: truncated"); const v = td.decode(buf.slice(p, p + n)); p += n; return v; }
      case 4: { if (n > 1024) throw new Error("cbor: too large"); const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
      case 5: { if (n > 1024) throw new Error("cbor: too large"); const m = new Map<any, any>(); for (let i = 0; i < n; i++) { const k = read(); m.set(k, read()); } return m; }
      case 7: if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; throw new Error("cbor: unsupported simple value");
      default: throw new Error("cbor: unsupported type");
    }
  };
  const value = read();
  return { value, end: p };
}

export interface AuthData { rpIdHash: Uint8Array; flags: number; up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; signCount: number; aaguid?: Uint8Array; credId?: Uint8Array; cose?: Map<any, any> }
export function parseAuthData(a: Uint8Array): AuthData {
  if (a.length < 37) throw new Error("authData too short");
  const flags = a[32], signCount = ((a[33] << 24) | (a[34] << 16) | (a[35] << 8) | a[36]) >>> 0;
  const out: AuthData = { rpIdHash: a.slice(0, 32), flags, up: !!(flags & 1), uv: !!(flags & 4), be: !!(flags & 8), bs: !!(flags & 16), at: !!(flags & 64), signCount };
  if (out.at) {
    if (a.length < 55) throw new Error("attested data truncated");
    out.aaguid = a.slice(37, 53);
    const len = (a[53] << 8) | a[54];
    if (len < 16 || len > 1023 || 55 + len > a.length) throw new Error("bad credential id length");
    out.credId = a.slice(55, 55 + len);
    const { value } = cborDecode(a, 55 + len);
    if (!(value instanceof Map)) throw new Error("bad COSE key");
    out.cose = value;
  }
  return out;
}

export interface Jwk { kty: "EC"; crv: "P-256"; x: string; y: string }
export function coseToJwk(m: Map<any, any>): Jwk {
  if (m.get(1) !== 2 || m.get(3) !== -7 || m.get(-1) !== 1) throw new Error("only ES256 / P-256 credentials are accepted");
  const x = m.get(-2), y = m.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new Error("bad EC point");
  return { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) };
}

export interface Expected { challenge: string; origins: string[]; rpId: string }
function checkClient(clientDataJSON: Uint8Array, type: string, e: Expected): string | null {
  let c: any; try { c = JSON.parse(td.decode(clientDataJSON)); } catch { return "client_data_unparseable"; }
  if (c.type !== type) return "wrong_ceremony_type";
  if (c.challenge !== e.challenge) return "challenge_mismatch";
  if (!e.origins.includes(c.origin)) return "origin_not_allowed";
  if (c.crossOrigin === true) return "cross_origin";
  return null;
}

export type Registered = { ok: true; credentialId: string; publicKey: Jwk; signCount: number; aaguid: string; backupEligible: boolean } | { ok: false; reason: string };
export async function verifyRegistration(r: { clientDataJSON: string; attestationObject: string }, e: Expected, opts: { allowSynced?: boolean; aaguids?: string[] } = {}): Promise<Registered> {
  try {
    const cd = unb64u(r.clientDataJSON), bad = checkClient(cd, "webauthn.create", e); if (bad) return { ok: false, reason: bad };
    const att = cborDecode(unb64u(r.attestationObject)).value;
    if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array)) return { ok: false, reason: "bad_attestation_object" };
    const ad = parseAuthData(att.get("authData"));
    if (!ctEqual(ad.rpIdHash, await sha256(e.rpId))) return { ok: false, reason: "rp_id_mismatch" };
    if (!ad.up) return { ok: false, reason: "user_presence_missing" };
    if (!ad.uv) return { ok: false, reason: "user_verification_required" };
    if (!ad.at || !ad.credId || !ad.cose) return { ok: false, reason: "no_credential_data" };
    if (ad.be && !opts.allowSynced) return { ok: false, reason: "synced_passkey_not_allowed" };
    const aaguid = [...ad.aaguid!].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (opts.aaguids?.length && !opts.aaguids.includes(aaguid)) return { ok: false, reason: "authenticator_model_not_allowed" };
    const jwk = coseToJwk(ad.cose);
    await crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { ok: true, credentialId: b64u(ad.credId), publicKey: jwk, signCount: ad.signCount, aaguid, backupEligible: ad.be };
  } catch (err) { return { ok: false, reason: "registration_invalid:" + (err as Error).message }; }
}

function derToRaw(der: Uint8Array): Uint8Array {
  let p = 0;
  if (der[p++] !== 0x30) throw new Error("bad signature");
  let len = der[p++]; if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[p++]; }
  const int = () => { if (der[p++] !== 0x02) throw new Error("bad signature"); const l = der[p++]; let v = der.slice(p, p + l); p += l; while (v.length > 32 && v[0] === 0) v = v.slice(1); if (v.length > 32) throw new Error("bad signature"); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  return concat(int(), int());
}

export type Asserted = { ok: true; signCount: number } | { ok: false; reason: string };
export async function verifyAssertion(a: { clientDataJSON: string; authenticatorData: string; signature: string }, e: Expected, cred: { publicKey: Jwk; signCount: number }): Promise<Asserted> {
  try {
    const cd = unb64u(a.clientDataJSON), bad = checkClient(cd, "webauthn.get", e); if (bad) return { ok: false, reason: bad };
    const adRaw = unb64u(a.authenticatorData), ad = parseAuthData(adRaw);
    if (!ctEqual(ad.rpIdHash, await sha256(e.rpId))) return { ok: false, reason: "rp_id_mismatch" };
    if (!ad.up) return { ok: false, reason: "user_presence_missing" };
    if (!ad.uv) return { ok: false, reason: "user_verification_required" };
    if ((ad.signCount !== 0 || cred.signCount !== 0) && ad.signCount <= cred.signCount) return { ok: false, reason: "sign_count_not_increasing" };
    const key = await crypto.subtle.importKey("jwk", { ...cred.publicKey, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(unb64u(a.signature)), concat(adRaw, await sha256(cd)));
    return ok ? { ok: true, signCount: ad.signCount } : { ok: false, reason: "bad_signature" };
  } catch (err) { return { ok: false, reason: "assertion_invalid:" + (err as Error).message }; }
}

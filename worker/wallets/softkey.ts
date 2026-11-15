/** A software WebAuthn authenticator used by the tests (and nothing else): builds registrations and assertions exactly as a hardware key would, so the verifier is exercised for real. */
import { b64u, concat, sha256, te, unb64u } from "./bytes.ts";

function cborEnc(v: any): Uint8Array {
  const head = (major: number, n: number) => n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = te.encode(v); return concat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (v instanceof Map) return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEnc(k), cborEnc(x)]));
  throw new Error("cbor enc");
}
function rawToDer(raw: Uint8Array): Uint8Array {
  const enc = (x: Uint8Array) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let v = x.slice(i); if (v[0] & 0x80) v = concat(Uint8Array.of(0), v); return concat(Uint8Array.of(2, v.length), v); };
  const body = concat(enc(raw.slice(0, 32)), enc(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}
export class SoftKey {
  credId = crypto.getRandomValues(new Uint8Array(32)); counter = 0; pub!: { x: Uint8Array; y: Uint8Array }; private priv!: CryptoKey; uv = true; backupEligible = false; aaguid = new Uint8Array(16);
  static async create(opts: Partial<Pick<SoftKey, "uv" | "backupEligible" | "aaguid">> = {}): Promise<SoftKey> {
    const k = new SoftKey(); Object.assign(k, opts);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    k.priv = pair.privateKey; const jwk: any = await crypto.subtle.exportKey("jwk", pair.publicKey); k.pub = { x: unb64u(jwk.x), y: unb64u(jwk.y) };
    return k;
  }
  private flags(extra = 0) { return 1 | (this.uv ? 4 : 0) | (this.backupEligible ? 8 : 0) | extra; }
  async register(challenge: string, origin: string, rpId: string) {
    const cd = te.encode(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    const cose = new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, this.pub.x], [-3, this.pub.y]]);
    const ad = concat(await sha256(rpId), Uint8Array.of(this.flags(64), 0, 0, 0, this.counter), this.aaguid, Uint8Array.of(0, this.credId.length), this.credId, cborEnc(cose));
    return { credentialId: b64u(this.credId), clientDataJSON: b64u(cd), attestationObject: b64u(cborEnc(new Map<any, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]))) };
  }
  async assert(challenge: string, origin: string, rpId: string, over: { type?: string; origin?: string } = {}) {
    this.counter++;
    const cd = te.encode(JSON.stringify({ type: over.type ?? "webauthn.get", challenge, origin: over.origin ?? origin, crossOrigin: false }));
    const ad = concat(await sha256(rpId), Uint8Array.of(this.flags(), (this.counter >> 24) & 255, (this.counter >> 16) & 255, (this.counter >> 8) & 255, this.counter & 255));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, concat(ad, await sha256(cd))));
    return { credentialId: b64u(this.credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(rawToDer(sig)) };
  }
}

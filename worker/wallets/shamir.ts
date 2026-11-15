/**
 * Shamir secret sharing over GF(256) (AES polynomial 0x11b), byte by byte. Any k of the n shares rebuild the secret; fewer than k reveal nothing.
 * Share text: eti-shr1:<setId>:<k>:<n>:<x>:<hex y>:<check>. The set id stops shares of different ceremonies being mixed; the check catches typos.
 * Used only to split the recovery private key at a ceremony: shares are shown once and never stored by the application.
 */
import { fromHex, toHex } from "./bytes.ts";

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; let y = x << 1; if (y & 0x100) y ^= 0x11b; x = y ^ x; x &= 0xff; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const inv = (a: number) => { if (a === 0) throw new Error("no inverse"); return EXP[255 - LOG[a]]; };
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };

export interface Share { setId: string; k: number; n: number; x: number; y: Uint8Array }

export function split(secret: Uint8Array, k: number, n: number): string[] {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n < k || n > 16) throw new Error("need 2 <= k <= n <= 16");
  if (secret.length < 16 || secret.length > 64) throw new Error("secret must be 16 to 64 bytes");
  const setId = toHex(crypto.getRandomValues(new Uint8Array(4))), ys = Array.from({ length: n }, () => new Uint8Array(secret.length));
  for (let b = 0; b < secret.length; b++) {
    const coef = new Uint8Array(k); coef[0] = secret[b]; crypto.getRandomValues(coef.subarray(1));
    for (let xi = 1; xi <= n; xi++) { let y = 0; for (let d = k - 1; d >= 0; d--) y = mul(y, xi) ^ coef[d]; ys[xi - 1][b] = y; }
  }
  return ys.map((y, i) => { const body = ["eti-shr1", setId, k, n, i + 1, toHex(y)].join(":"); return body + ":" + fnv(body); });
}

export function parseShare(text: string): Share {
  const p = String(text).trim().split(":");
  if (p.length !== 7 || p[0] !== "eti-shr1") throw new Error("not an ETI share");
  if (fnv(p.slice(0, 6).join(":")) !== p[6]) throw new Error("share check failed (typo or corruption)");
  const k = Number(p[2]), n = Number(p[3]), x = Number(p[4]);
  if (![k, n, x].every(Number.isInteger) || x < 1 || x > n || k < 2 || k > n) throw new Error("bad share header");
  return { setId: p[1], k, n, x, y: fromHex(p[5]) };
}

export function combine(texts: string[]): Uint8Array {
  const shares = texts.map(parseShare);
  if (!shares.length) throw new Error("no shares given");
  const { setId, k, n } = shares[0], len = shares[0].y.length;
  for (const s of shares) if (s.setId !== setId || s.k !== k || s.n !== n || s.y.length !== len) throw new Error("shares come from different ceremonies");
  const seen = new Set<number>(); for (const s of shares) { if (seen.has(s.x)) throw new Error("duplicate share"); seen.add(s.x); }
  if (shares.length < k) throw new Error(`need ${k} shares, got ${shares.length}`);
  const use = shares.slice(0, k), out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < k; i++) { let num = 1, den = 1; for (let j = 0; j < k; j++) if (i !== j) { num = mul(num, use[j].x); den = mul(den, use[i].x ^ use[j].x); } acc ^= mul(use[i].y[b], mul(num, inv(den))); }
    out[b] = acc;
  }
  return out;
}

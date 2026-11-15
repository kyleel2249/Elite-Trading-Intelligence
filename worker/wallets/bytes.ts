/** Small byte helpers shared by the wallet modules (base64url, hex, concatenation, constant-time compare). */
export const te = new TextEncoder(), td = new TextDecoder();
export function b64u(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
export function unb64u(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4), bin = atob(p), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array { if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("bad hex"); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; }
export function concat(...p: Uint8Array[]): Uint8Array { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; }
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
export async function sha256(data: Uint8Array | string): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? te.encode(data) : data)); }
export const sha256Hex = async (d: Uint8Array | string) => toHex(await sha256(d));

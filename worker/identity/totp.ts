/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) on WebCrypto, plus RFC 4648 base32 and single-use recovery codes. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(b: Uint8Array): string { let bits = 0, v = 0, o = ""; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } v &= (1 << bits) - 1; } if (bits > 0) o += B32[(v << (5 - bits)) & 31]; return o; }
export function base32Decode(s: string): Uint8Array { s = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase(); let bits = 0, v = 0; const out: number[] = []; for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new Error("invalid base32"); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; v &= (1 << bits) - 1; } } return Uint8Array.from(out); }
export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));
export async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8); let c = counter; for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)), o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
export const totpCounter = (nowMs: number, step = 30) => Math.floor(nowMs / 1000 / step);
export const totpCode = (secretB32: string, nowMs: number) => hotp(base32Decode(secretB32), totpCounter(nowMs));
/** Accepts the current step and one either side (clock drift). A counter at or below `lastCounter` is refused so a code cannot be replayed. Returns the matched counter or null. */
export async function verifyTotp(secretB32: string, code: string, nowMs: number, lastCounter = -1, window = 1): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32), c0 = totpCounter(nowMs); let hit: number | null = null;
  for (let d = -window; d <= window; d++) { const c = c0 + d; const exp = await hotp(secret, c); let diff = 0; for (let i = 0; i < 6; i++) diff |= exp.charCodeAt(i) ^ code.charCodeAt(i); if (diff === 0 && c > lastCounter && (hit === null || c > hit)) hit = c; }
  return hit;
}
export const otpauthUri = (issuer: string, account: string, secretB32: string) => "otpauth://totp/" + encodeURIComponent(issuer) + ":" + encodeURIComponent(account) + "?secret=" + secretB32 + "&issuer=" + encodeURIComponent(issuer) + "&algorithm=SHA1&digits=6&period=30";
const RC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRecoveryCodes(n = 10): string[] { return Array.from({ length: n }, () => { const b = crypto.getRandomValues(new Uint8Array(10)); const s = [...b].map(x => RC[x % RC.length]).join(""); return s.slice(0, 5) + "-" + s.slice(5); }); }
export const normaliseRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{5})(.{5})$/, "$1-$2");

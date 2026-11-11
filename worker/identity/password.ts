/** Password hashing and policy. PBKDF2-SHA256 (WebCrypto; Cloudflare Workers cap PBKDF2 at 100,000 iterations) over an HMAC "pepper" kept in a Worker secret, so a database leak alone is not enough to crack hashes. */
const enc = new TextEncoder();
const hex = (u: Uint8Array) => [...u].map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
export const ITERATIONS = 100_000;
async function pepper(pw: string, key: string): Promise<Uint8Array> { const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(pw))); }
async function derive(pw: string, key: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", await pepper(pw, key), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
}
export async function hashPassword(pw: string, key: string, iterations = ITERATIONS): Promise<string> { const salt = crypto.getRandomValues(new Uint8Array(16)); return ["pbkdf2-sha256", iterations, hex(salt), hex(await derive(pw, key, salt, iterations))].join("$"); }
export async function verifyPassword(pw: string, stored: string, keys: string[]): Promise<{ ok: boolean; needsRehash: boolean }> {
  const [alg, it, salt, hash] = stored.split("$"); if (alg !== "pbkdf2-sha256" || !salt || !hash) return { ok: false, needsRehash: false };
  const iterations = Number(it); if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return { ok: false, needsRehash: false };
  const want = unhex(hash); let ok = false, idx = -1;
  for (const [n, k] of keys.entries()) { const got = await derive(pw, k, unhex(salt), iterations); let d = got.length ^ want.length; for (let i = 0; i < got.length; i++) d |= got[i] ^ (want[i] ?? 0); if (d === 0) { ok = true; idx = n; break; } }
  return { ok, needsRehash: ok && (iterations < ITERATIONS || idx > 0) };
}
const COMMON = new Set(["password", "password1", "passw0rd", "qwerty", "letmein", "welcome", "admin", "administrator", "iloveyou", "trading", "bitcoin", "123456", "12345678", "123456789", "1234567890", "abc123", "monkey", "dragon"]);
/** Returns a list of problems (empty = acceptable). Length matters most; there is no composition ritual beyond a basic variety check for short passphrases. */
export function passwordProblems(pw: string, email = ""): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push("use at least 12 characters");
  if (pw.length > 256) p.push("use at most 256 characters");
  const lower = pw.toLowerCase(), local = email.split("@")[0]?.toLowerCase() ?? "";
  if ([...COMMON].some(c => lower.includes(c))) p.push("avoid common passwords");
  if (local.length >= 3 && lower.includes(local)) p.push("do not include your email name");
  if (/^(.)\1+$/.test(pw)) p.push("do not repeat one character");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (pw.length < 16 && classes < 3) p.push("under 16 characters, mix at least three of: lower case, upper case, digits, symbols");
  return p;
}

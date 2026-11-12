/** Authenticated encryption for secrets at rest (TOTP seeds): AES-256-GCM, key derived by HKDF from a dedicated Worker secret, bound to a context string so a ciphertext cannot be moved to another user. */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function aesKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("eti-identity-seal-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function seal(secret: string, context: string, plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await aesKey(secret, salt), enc.encode(plaintext)));
  return "v1." + b64u(salt) + "." + b64u(iv) + "." + b64u(ct);
}
/** Tries each key in order (current first, then previous) so keys can be rotated. Returns null when nothing opens it. */
export async function open(secrets: string[], context: string, sealed: string): Promise<string | null> {
  const [v, s, i, c] = sealed.split("."); if (v !== "v1" || !s || !i || !c) return null;
  for (const k of secrets) { try { return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(i), additionalData: enc.encode(context) }, await aesKey(k, unb64u(s)), unb64u(c))); } catch { /* try next key */ } }
  return null;
}

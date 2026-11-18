/**
 * Secret-material detection. The wallet system never needs a seed phrase, private key or passphrase, so any API field that looks like one is
 * REFUSED (not stored, not echoed), and every audit/log detail passes through redact() before it is written anywhere.
 * Detection is heuristic by design (no BIP-39 word list is bundled); it is a safety net, not the only control: the data model has no field for secrets.
 */
const HEX64 = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const WIF = /(?<![1-9A-HJ-NP-Za-km-z])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/;
const XPRV = /\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LABEL = /\b(seed ?phrase|mnemonic|recovery ?phrase|private ?key|secret ?key|passphrase|wallet ?password)\b\s*[:=]\s*\S+/i;
export function looksLikeMnemonic(s: string): boolean {
  const w = s.trim().toLowerCase().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(w.length) && w.every((x) => /^[a-z]{3,8}$/.test(x)) && new Set(w).size >= Math.ceil(w.length * 0.75);
}
export type SecretKind = "mnemonic" | "hex_private_key" | "wif" | "xprv" | "pem_private_key" | "labelled_secret" | "share";
export function detectSecret(s: string, opts: { allowHex64?: boolean } = {}): SecretKind | null {
  if (typeof s !== "string" || s.length < 12) return null;
  if (PEM.test(s)) return "pem_private_key";
  if (/eti-shr1:[0-9a-f]{8}:/.test(s)) return "share";
  if (XPRV.test(s)) return "xprv";
  if (LABEL.test(s)) return "labelled_secret";
  if (looksLikeMnemonic(s)) return "mnemonic";
  if (WIF.test(s)) return "wif";
  if (!opts.allowHex64 && HEX64.test(s)) return "hex_private_key";
  return null;
}
/** First secret-looking string anywhere in a JSON-like value, or null. Field names listed in `hexOk` may carry 64-hex values (transaction hashes). */
export function findSecret(v: unknown, hexOk: readonly string[] = ["txRef", "txId", "digest", "id", "actionId", "credentialId", "signature", "authenticatorData", "clientDataJSON", "attestationObject", "rawId", "hash", "plainHash", "mac"], key = "", depth = 0): { path: string; kind: SecretKind } | null {
  if (depth > 8) return null;
  if (typeof v === "string") { const k = detectSecret(v, { allowHex64: hexOk.includes(key) }); return k ? { path: key || "(value)", kind: k } : null; }
  if (Array.isArray(v)) { for (const x of v) { const f = findSecret(x, hexOk, key, depth + 1); if (f) return f; } return null; }
  if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) { if (/^(seed|mnemonic|private_?key|secret|passphrase|password)$/i.test(k) && typeof x === "string" && x) return { path: k, kind: "labelled_secret" }; const f = findSecret(x, hexOk, k, depth + 1); if (f) return f; } }
  return null;
}
/** Deep copy with anything secret-looking replaced, for audit details and logs. */
export function redact<T>(v: T, hexOk: readonly string[] = ["txRef", "txId", "digest", "id", "actionId", "credentialId", "signature", "authenticatorData", "clientDataJSON", "attestationObject", "rawId", "hash", "plainHash", "mac"], key = "", depth = 0): T {
  if (depth > 8) return "[deep]" as any;
  if (typeof v === "string") return (detectSecret(v, { allowHex64: hexOk.includes(key) }) ? "[REDACTED]" : v.length > 2000 ? v.slice(0, 2000) + "…" : v) as any;
  if (Array.isArray(v)) return v.map((x) => redact(x, hexOk, key, depth + 1)) as any;
  if (v && typeof v === "object") { const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = /^(seed|mnemonic|private_?key|secret|passphrase|password|d)$/i.test(k) && typeof x === "string" ? "[REDACTED]" : redact(x, hexOk, k, depth + 1); return o; }
  return v;
}

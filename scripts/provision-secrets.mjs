#!/usr/bin/env node
/**
 * Generate cryptographically secure ETI secrets and store them as Cloudflare Worker secrets.
 * Values are produced with crypto.randomBytes, piped straight into `wrangler secret put` on stdin, and are never
 * printed, written to disk or placed on a command line.
 *
 *   node scripts/provision-secrets.mjs --session-secret            # ETI_SESSION_SECRET (signs execution sessions)
 *   node scripts/provision-secrets.mjs --execution-token           # ETI_EXECUTION_TOKEN (master token for API clients / live gate)
 *   node scripts/provision-secrets.mjs --session-secret --keep-previous OLD_VALUE_ENV   # rotate: old value (read from that env var) becomes ETI_SESSION_SECRET_PREVIOUS
 *   add --dry-run to see what would be set without calling wrangler; add --env <name> for a wrangler environment.
 *
 * Exchange API keys are NEVER generated here: set them yourself (wrangler secret put ALPACA_API_KEY ...).
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2), has = f => args.includes(f), val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
export const generate = (bytes = 48) => randomBytes(bytes).toString("base64url");
const FORBIDDEN = /^(ALPACA|BINANCE)_/; // exchange credentials are the user's to provide
export function plan(a) {
  const get = f => a.includes(f), out = [];
  if (get("--session-secret")) out.push("ETI_SESSION_SECRET");
  if (get("--execution-token")) out.push("ETI_EXECUTION_TOKEN");
  return out.filter(n => !FORBIDDEN.test(n));
}
function put(name, value, env, dry) {
  if (dry) { console.log(`[dry-run] would set ${name} (${value.length} chars, not shown)`); return true; }
  const r = spawnSync("npx", ["wrangler", "secret", "put", name, ...(env ? ["--env", env] : [])], { input: value, stdio: ["pipe", "inherit", "inherit"], encoding: "utf8" });
  if (r.status !== 0) { console.error(`failed to set ${name}`); return false; }
  console.log(`set ${name}`); return true;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const names = plan(args); if (!names.length) { console.error("Nothing to do. Use --session-secret and/or --execution-token (see the header of this file)."); process.exit(2); }
  const env = val("--env"), dry = has("--dry-run"); let ok = true;
  const prevVar = val("--keep-previous");
  if (prevVar && names.includes("ETI_SESSION_SECRET")) { const old = process.env[prevVar]; if (!old || old.length < 24) { console.error(`--keep-previous needs an environment variable ${prevVar} holding the OLD secret (at least 24 characters)`); process.exit(2); } ok = put("ETI_SESSION_SECRET_PREVIOUS", old, env, dry) && ok; }
  for (const n of names) ok = put(n, generate(), env, dry) && ok;
  console.log(ok ? "Done. Sessions signed by the previous secret stay valid until they expire." : "Some secrets failed.");
  process.exit(ok ? 0 : 1);
}

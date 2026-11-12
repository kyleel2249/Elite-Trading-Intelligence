import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

function sources(dir: URL, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const u = new URL(n + (statSync(new URL(n, dir)).isDirectory() ? "/" : ""), dir); if (n.endsWith("/")) continue; if (statSync(u).isDirectory()) sources(u, acc); else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) acc.push(readFileSync(u, "utf8")); }
  return acc;
}
test("every environment variable the Worker reads is documented in docs/ENVIRONMENT_VARIABLES.md", () => {
  const code = sources(new URL("./", import.meta.url)).join("\n"), doc = readFileSync(new URL("../docs/ENVIRONMENT_VARIABLES.md", import.meta.url), "utf8");
  const used = new Set<string>([...code.matchAll(/\bETI_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g)].map(m => m[0]).concat([...code.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1])));
  const missing = [...used].filter(v => !doc.includes("`" + v + "`"));
  assert.deepEqual(missing, [], "undocumented variables: " + missing.join(", "));
});
test("the documentation lists no secret-looking values", () => {
  const doc = readFileSync(new URL("../docs/ENVIRONMENT_VARIABLES.md", import.meta.url), "utf8");
  assert.doesNotMatch(doc, /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN)/);
});

test("wrangler vars never contain API keys, tokens, or secrets", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const unsafe = Object.keys(config.vars || {}).filter(name => /(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(name));
  assert.deepEqual(unsafe, [], "move credential-like Worker vars to Cloudflare secrets: " + unsafe.join(", "));
});

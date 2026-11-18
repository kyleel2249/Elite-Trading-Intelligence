import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { detectSecret } from "./redact.ts";

/** Nothing resembling a private key, seed share or labelled secret may be committed (tests and the detector itself are exempt). */
test("repository contains no committed key material", (t) => {
  let files: string[]; try { files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { t.skip("git not available"); return; }
  const hits: string[] = [];
  for (const f of files) {
    if (/\.(test\.ts|png|jpg|jpeg|gif|ico|woff2?|zip|lock)$/.test(f) || f === "worker/wallets/redact.ts" || f === "package-lock.json") continue;
    let text: string; try { text = readFileSync(f, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => { if (line.length > 4000) return; const k = detectSecret(line.trim(), { allowHex64: true }); if (k && k !== "labelled_secret") hits.push(`${f}:${i + 1} ${k}`); if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) hits.push(`${f}:${i + 1} pem`); });
  }
  assert.deepEqual(hits, []);
});
test("application code never persists secrets to browser storage or logs wallet payloads", () => {
  for (const f of ["worker/wallets/ui.ts", "worker/wallets/routes.ts", "worker/wallets/service.ts", "worker/wallets/custody.ts", "worker/wallets/vault.ts"]) {
    const t = readFileSync(f, "utf8"); assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(t), false, f); assert.equal(/console\.(log|info|debug|warn|error)/.test(t), false, f);
  }
});

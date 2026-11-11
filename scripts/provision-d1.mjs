#!/usr/bin/env node
// wrangler.jsonc already declares ETI_PORTFOLIO_DB / eti-portfolio-db WITHOUT a database_id, so `wrangler deploy` (4.45+) creates and binds it automatically.
// This script is the explicit alternative (older wrangler, or to pin the id): it creates the D1 database for the portfolio ledger, binds it as ETI_PORTFOLIO_DB in wrangler.jsonc, applies the migration.
// Usage: node scripts/provision-d1.mjs [--name eti-portfolio-db] [--dry-run]
// Needs `wrangler` authenticated for your Cloudflare account (npx wrangler login, or CLOUDFLARE_API_TOKEN).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BINDING = "ETI_PORTFOLIO_DB";
/** Pure: add the d1_databases binding to wrangler.jsonc text (idempotent). */
export function patchWrangler(text, name, id) {
  if (text.includes('"' + BINDING + '"')) return text;
  const block = '"d1_databases": [\n    { "binding": "' + BINDING + '", "database_name": "' + name + '", "database_id": "' + id + '", "migrations_dir": "migrations" }\n  ],\n  ';
  if (!text.includes('"kv_namespaces"')) throw new Error("wrangler.jsonc has no kv_namespaces anchor to insert before");
  return text.replace('"kv_namespaces"', block + '"kv_namespaces"');
}
/** Pure: pull the database id out of `wrangler d1 create` output (JSON snippet or toml-style line). */
export function parseDatabaseId(out) {
  const m = /"database_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(out) || /database_id\s*=\s*"([0-9a-f-]{36})"/i.exec(out);
  if (!m) throw new Error("could not find database_id in wrangler output:\n" + out);
  return m[1];
}
function main() {
  const args = process.argv.slice(2), dry = args.includes("--dry-run"), name = args.includes("--name") ? args[args.indexOf("--name") + 1] : "eti-portfolio-db";
  const run = (a) => { console.log("$ npx wrangler " + a.join(" ")); return dry ? "" : execFileSync("npx", ["wrangler", ...a], { encoding: "utf8" }); };
  const out = run(["d1", "create", name]);
  const id = dry ? "00000000-0000-0000-0000-000000000000" : parseDatabaseId(out);
  const path = new URL("../wrangler.jsonc", import.meta.url), text = readFileSync(path, "utf8"), next = patchWrangler(text, name, id);
  if (!dry && next !== text) writeFileSync(path, next);
  console.log(dry ? "[dry run] would bind " + BINDING + " -> " + name + " in wrangler.jsonc" : "Bound " + BINDING + " in wrangler.jsonc");
  run(["d1", "migrations", "apply", name, "--remote"]);
  console.log("Done. Deploy, then (only if you already have KV portfolio data) POST /api/portfolio/migrate-to-d1 with the master token for each environment.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();

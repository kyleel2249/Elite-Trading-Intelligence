import { test } from "node:test";
import assert from "node:assert/strict";
import { dataXCanonical, dataXSignature } from "./integration.ts";

test("DataX request signature binds timestamp, nonce, method and exact endpoint", () => {
  assert.equal(dataXCanonical("1795000000", "nonce123456789012", "/api/integrations/eti/summary"), "1795000000\nnonce123456789012\nGET\n/api/integrations/eti/summary");
});

test("DataX HMAC signature is deterministic and changes with the canonical request", async () => {
  const secret = "x".repeat(48);
  const a = await dataXSignature(secret, dataXCanonical("1795000000", "nonce123456789012", "/api/integrations/eti/summary"));
  const b = await dataXSignature(secret, dataXCanonical("1795000000", "nonce123456789012", "/api/integrations/eti/summary"));
  const c = await dataXSignature(secret, dataXCanonical("1795000001", "nonce123456789012", "/api/integrations/eti/summary"));
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("DataX integration is a separate read-only route and does not touch trading ledgers", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./integration.ts", import.meta.url), "utf8");
  assert.match(source, /DATAX_INTEGRATION_SECRET/);
  assert.match(source, /DATAX_API_URL/);
  assert.match(source, /api\/integrations\/eti\/summary/);
  assert.match(source, /ETI trading and portfolio services remain independent/);
  assert.doesNotMatch(source, /INSERT INTO (wallet_accounts|portfolio|journal)/i);
});

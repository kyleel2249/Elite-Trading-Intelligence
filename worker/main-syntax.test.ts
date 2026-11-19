import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression: a literal backslash-n after a statement terminator (from a bad scripted edit) broke the Cloudflare build ("Syntax error \"n\"").
test("worker/main.ts has no stray literal \\n escapes between statements", () => {
  const src = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const bad = src.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /[;)}]\\n\s*(\/\/|if\b|const\b|ctx\.|await\b)/.test(l));
  assert.deepEqual(bad.map(([n]) => n), []);
});
test("worker/main.ts parses as a module", () => {
  const src = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.doesNotThrow(() => (globalThis as any).process.getBuiltinModule("node:module").stripTypeScriptTypes?.(src));
});

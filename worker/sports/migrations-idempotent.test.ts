import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../migrations/", import.meta.url);
const read = (n: string) => readFileSync(new URL(n, dir), "utf8");

test("migrations never use ALTER TABLE ADD COLUMN (not idempotent; breaks when the Worker self-healed the schema first)", () => {
  for (const f of readdirSync(dir).filter(n => n.endsWith(".sql"))) {
    assert.doesNotMatch(read(f), /ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN/i, f + " contains a non-idempotent ADD COLUMN");
  }
});

test("0003 defines every sports_bets column that later migrations and the Worker rely on", () => {
  const sql = read("0003_sports_betting.sql");
  for (const c of ["event_id", "bookmaker", "odds_provider", "implied_probability", "expected_value", "model_version"]) assert.match(sql, new RegExp("\\b" + c + "\\b"), "missing " + c);
});

test("every CREATE TABLE / INDEX in the sports migrations is IF NOT EXISTS", () => {
  for (const f of readdirSync(dir).filter(n => /^000[3-8]_/.test(n))) {
    const sql = read(f);
    assert.doesNotMatch(sql, /CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF\s+NOT\s+EXISTS)/i, f + " has a non-idempotent CREATE");
  }
});

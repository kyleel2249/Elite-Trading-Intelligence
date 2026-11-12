import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("D1 migration creates the football results table with every column used by history sync", () => {
  const sql = readFileSync(new URL("../../migrations/0008_sports_match_results.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sports_match_results/i);
  for (const column of ["fixture_id", "played_at", "competition", "country", "home_team", "away_team", "home_goals", "away_goals", "source", "updated_at"]) {
    assert.match(sql, new RegExp("\\b" + column + "\\b", "i"), "missing D1 column: " + column);
  }
  assert.match(sql, /PRIMARY KEY/i);
  assert.match(sql, /sports_match_results_played_at_idx/i);
});

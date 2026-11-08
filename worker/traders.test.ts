import test from "node:test";
import assert from "node:assert/strict";
import { handleTraderDirectory, TRADER_PROFILES } from "./traders.ts";

test("directory includes user-specified core and additional profiles", () => {
  const names = new Set(TRADER_PROFILES.map(p => p.name));
  for (const name of ["George Soros","Stanley Druckenmiller","Paul Tudor Jones","Richard Dennis","William Eckhardt","Ed Seykota","Mark Minervini","Nicolas Darvas","Richard Wyckoff","William O'Neil","Jim Simons","Warren Buffett","Charlie Munger","Peter Lynch","Michael Burry","Ed Thorp","Michael Steinhardt","Julian Robertson","David Shaw","Marty Schwartz","Tom Basso","Howard Marks","Chris Hohn","David Einhorn","John W. Henry","Robert Mercer"]) assert.ok(names.has(name), name);
});

test("directory is searchable and carries explicit public-method caveats", async () => {
  const res = handleTraderDirectory(new Request("https://eti.test/api/intelligence/traders?q=reflexivity"));
  const body = await res.json() as any;
  assert.equal(body.count, 1);
  assert.equal(body.profiles[0].name, "George Soros");
  assert.match(body.limitations, /No private algorithms/);
});
